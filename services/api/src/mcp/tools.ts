/**
 * CareFlow's MCP tools — what the companion can actually do.
 *
 * The important design decision is how consent works. MCP says clients *should* put a
 * human in the loop before a sensitive tool call, but "should" is not a guarantee, and we
 * are not willing to let someone's daughter be phoned because a host application skipped a
 * confirmation dialog. So consent is enforced server-side:
 *
 *   1. A sensitive tool does not act. It returns `status: "confirmation_required"` with a
 *      `confirmationId` and the exact sentence to read to the person.
 *   2. The model asks. The person answers.
 *   3. `confirm_action` executes — and only if the id is live, unexpired, and matches the
 *      action that was described.
 *
 * That turns our consent engine into a protocol-level contract. A host that ignores it
 * simply cannot make anything happen, which is the property we want.
 *
 * Read-only tools and anything purely local (remembering a fact, logging a check-in) run
 * immediately — there is nothing to undo about a note, and a confirmation prompt for every
 * trivial thing trains people to say yes without listening.
 */

import { randomUUID } from 'node:crypto';
import type { CarePlan, Memory, SensitiveAction } from '@careflow/shared';
import { nowIso } from '@careflow/shared';
import { createConsentMachine, type ConsentMachine } from '@careflow/consent-engine';
import { toolError, toolResult, type ToolDefinition, type ToolResult } from './protocol.js';
import { executeAction } from '../lib/actions.js';
import { CONFIRMATION_TTL_MS, toDescriptor } from '../lib/consent.js';
import type { Store } from '../lib/store.js';

export interface ToolContext {
  sessionId: string;
}

export interface ToolDeps {
  store: Store;
  getCarePlan: () => Promise<CarePlan>;
  demoMode: boolean;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

interface PendingConfirmation {
  id: string;
  action: SensitiveAction;
  machine: ConsentMachine<SensitiveAction>;
  createdAt: number;
  expiresAt: number;
  sessionId: string;
}

type Handler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult;

interface RegisteredTool {
  definition: ToolDefinition;
  handler: Handler;
}

const NO_ARGS = { type: 'object', additionalProperties: false } as const;

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private pending = new Map<string, PendingConfirmation>();

  constructor(private readonly deps: ToolDeps) {
    this.registerAll();
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return toolError(`Unknown tool: ${name}`);

    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      this.deps.log('mcp tool failed', {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
      // A tool execution error, not a protocol error: the model may be able to retry with
      // different arguments, and should be told what went wrong.
      return toolError(
        err instanceof Error ? err.message : 'That did not work. Nothing was changed.',
      );
    }
  }

  private register(definition: ToolDefinition, handler: Handler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  // =========================================================================
  // Consent
  // =========================================================================

  /**
   * Stage a sensitive action and hand back the sentence to say out loud.
   *
   * Nothing has happened at this point. The action is frozen inside the consent machine,
   * so the message that gets sent is necessarily the message the person approved.
   */
  private requireConfirmation(action: SensitiveAction, ctx: ToolContext): ToolResult {
    const machine = createConsentMachine<SensitiveAction>({
      blockedActions: ['unlock_door', 'disarm_alarm', 'medical_advice', 'emergency_dispatch'],
      confirmationTtlMs: CONFIRMATION_TTL_MS,
      actor: `mcp:${ctx.sessionId}`,
    });

    const descriptor = toDescriptor(action);
    const allowed = machine.can(descriptor);
    if (!allowed.allowed) return toolError(allowed.reason);

    machine.observe({ kind: 'mcp_tool_call' });
    machine.offer([descriptor]);
    machine.choose(descriptor.id);

    const id = randomUUID();
    this.pending.set(id, {
      id,
      action,
      machine,
      createdAt: Date.now(),
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
      sessionId: ctx.sessionId,
    });
    this.sweepPending();

    const ask = `Just to confirm — should I ${action.summary}?`;
    return toolResult(
      `Not done yet. Ask them, out loud, exactly this: "${ask}" ` +
        `If they say yes, call confirm_action with confirmationId "${id}" and affirmative true. ` +
        `If they say no, call it with affirmative false. Do not assume the answer.`,
      {
        status: 'confirmation_required',
        confirmationId: id,
        askExactly: ask,
        willDo: action.summary,
        ...(action.message ? { message: action.message } : {}),
        expiresInSeconds: Math.round(CONFIRMATION_TTL_MS / 1000),
      },
    );
  }

  private sweepPending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt < now) this.pending.delete(id);
  }

  // =========================================================================
  // Registration
  // =========================================================================

  private registerAll(): void {
    this.registerProfileTools();
    this.registerCompanionTools();
    this.registerContactTools();
    this.registerMedicationTools();
    this.registerAppointmentTools();
    this.registerSafetyTools();
    this.registerConfirmation();
  }

  // --- who they are, and what today looks like -----------------------------

  private registerProfileTools(): void {
    this.register(
      {
        name: 'get_care_profile',
        title: 'Who you are talking to',
        description:
          'The person CareFlow is supporting: their name, how they like to be addressed, and non-clinical context such as being home after a hospital stay. Call this at the start of a conversation.',
        inputSchema: NO_ARGS,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const plan = await this.deps.getCarePlan();
        const p = plan.patient;
        return toolResult(
          `${p.displayName}, who prefers to be called ${p.preferredName ?? p.displayName}. ` +
            (p.careContext?.situation ?? 'No additional context recorded.'),
          {
            name: p.displayName,
            preferredName: p.preferredName ?? p.displayName,
            context: p.careContext?.situation ?? null,
            homeSince: p.careContext?.homeSince ?? null,
            locale: p.preferences.locale,
          },
        );
      },
    );

    this.register(
      {
        name: 'get_daily_brief',
        title: "Today's plan",
        description:
          "Everything happening today: scheduled care visits, medication reminders, and appointments. Use this to answer 'what's happening today?' and to open a check-in.",
        inputSchema: NO_ARGS,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const plan = await this.deps.getCarePlan();
        const time = (iso: string) =>
          new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

        const visits = plan.visits.map((v) => ({
          who: plan.contacts.find((c) => c.contactId === v.contactId)?.displayName ?? v.contactId,
          from: time(v.startsAt),
          to: time(v.endsAt),
          purpose: v.purpose,
          status: v.status,
        }));
        const today = new Date().toDateString();
        const appointments = plan.appointments
          .filter((a) => new Date(a.startsAt).toDateString() === today)
          .map((a) => ({ title: a.title, at: time(a.startsAt), location: a.location }));
        const medications = plan.medications.map((m) => ({
          name: m.name,
          schedule: m.schedule,
          daysSupplyRemaining: m.daysSupplyRemaining,
        }));

        const lines = [
          visits.length
            ? `Visits: ${visits.map((v) => `${v.who} ${v.from}–${v.to}`).join('; ')}.`
            : 'No care visits scheduled today.',
          appointments.length
            ? `Appointments: ${appointments.map((a) => `${a.title} at ${a.at}`).join('; ')}.`
            : 'No appointments today.',
          medications.length ? `Medications: ${medications.map((m) => m.name).join(', ')}.` : '',
        ].filter(Boolean);

        return toolResult(lines.join(' '), { visits, appointments, medications });
      },
    );
  }

  // --- companionship -------------------------------------------------------

  private registerCompanionTools(): void {
    this.register(
      {
        name: 'recall_memories',
        title: 'What you already know about them',
        description:
          'Things CareFlow has remembered from previous conversations: family, routines, worries, plans. Call this before chatting so the conversation continues rather than starting over. Optionally filter by topic.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Optional filter, e.g. "family", "routine", "likes", "worry", "plan".',
            },
            limit: { type: 'number', description: 'Maximum to return. Defaults to 20.' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        const plan = await this.deps.getCarePlan();
        const topic = str(args, 'topic');
        const limit = typeof args.limit === 'number' ? args.limit : 20;

        let memories = await this.deps.store.listMemories(plan.patient.patientId, 100);
        if (topic) memories = memories.filter((m) => m.topic === topic);
        memories = memories.slice(-limit);

        if (memories.length === 0) {
          return toolResult(
            "Nothing remembered yet. Ask about them and use save_memory when they share something worth keeping.",
            { memories: [] },
          );
        }
        return toolResult(
          memories.map((m) => `(${m.topic}) ${m.text}`).join(' '),
          { memories: memories.map((m) => ({ topic: m.topic, text: m.text, since: m.createdAt })) },
        );
      },
    );

    this.register(
      {
        name: 'save_memory',
        title: 'Remember something',
        description:
          'Remember a fact the person shared, so later conversations can pick up where this one left off — their grandson\'s name, that Tuesdays are hard, that they like the crossword. Keep it to what they would be comfortable having repeated back. Do not record clinical details, symptoms, or anything they asked you to keep private.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: "The fact, in their own framing where possible.",
            },
            topic: {
              type: 'string',
              description: 'One of: family, routine, likes, worry, plan, other.',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      async (args) => {
        const text = str(args, 'text');
        if (!text) return toolError('Provide the text to remember.');

        const plan = await this.deps.getCarePlan();
        const memory: Memory = {
          memoryId: randomUUID(),
          text,
          topic: str(args, 'topic') ?? 'other',
          createdAt: nowIso(),
          source: 'patient',
        };
        await this.deps.store.saveMemory(plan.patient.patientId, memory);
        return toolResult(`Remembered: ${text}`, { saved: true, topic: memory.topic });
      },
    );

    this.register(
      {
        name: 'log_check_in',
        title: 'Record how they are',
        description:
          "Record a short, non-clinical note about how the person seems — in their own words. This is what lets a caregiver notice a pattern. Never record a diagnosis, a symptom assessment, or a judgement about their mental state; only what they said about themselves.",
        inputSchema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Short note, e.g. "a bit tired but did the crossword".',
            },
            mood: {
              type: 'string',
              description: "Only what they said about themselves, e.g. 'lonely', 'good'.",
            },
            initiatedBy: { type: 'string', enum: ['patient', 'careflow'] },
          },
          required: ['summary'],
          additionalProperties: false,
        },
      },
      async (args) => {
        const summary = str(args, 'summary');
        if (!summary) return toolError('Provide a short summary.');

        const plan = await this.deps.getCarePlan();
        const checkIn = {
          checkInId: randomUUID(),
          at: nowIso(),
          summary,
          ...(str(args, 'mood') ? { mood: str(args, 'mood')! } : {}),
          initiatedBy: (args.initiatedBy === 'careflow' ? 'careflow' : 'patient') as
            | 'patient'
            | 'careflow',
        };
        await this.deps.store.saveCheckIn(plan.patient.patientId, checkIn);
        return toolResult('Check-in recorded for the care team.', { checkIn });
      },
    );

    this.register(
      {
        name: 'get_recent_check_ins',
        title: 'How they have been lately',
        description:
          'Recent check-ins, so you can notice if someone has been quiet or has mentioned the same worry repeatedly. Use it to open with "you mentioned yesterday that…" rather than a cold start.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number' } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        const plan = await this.deps.getCarePlan();
        const limit = typeof args.limit === 'number' ? args.limit : 7;
        const checkIns = (await this.deps.store.listCheckIns(plan.patient.patientId, 50)).slice(
          -limit,
        );
        const lastAt = checkIns.at(-1)?.at;
        const daysSince = lastAt
          ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86_400_000)
          : null;

        return toolResult(
          checkIns.length === 0
            ? 'No check-ins recorded yet.'
            : `${checkIns.length} recent check-ins. Most recent: ${checkIns.at(-1)?.summary}`,
          { checkIns, daysSinceLastCheckIn: daysSince },
        );
      },
    );

    this.register(
      {
        name: 'set_reminder',
        title: 'Set a reminder',
        description:
          'Set a reminder for a medication, an appointment, or anything else they ask to be reminded about. Local to CareFlow — it does not contact anyone.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to remind them about.' },
            dueAt: { type: 'string', description: 'ISO-8601 timestamp.' },
            kind: { type: 'string', enum: ['medication', 'appointment', 'general'] },
          },
          required: ['text', 'dueAt'],
          additionalProperties: false,
        },
      },
      async (args) => {
        const text = str(args, 'text');
        const dueAtRaw = str(args, 'dueAt');
        if (!text || !dueAtRaw) return toolError('Provide both text and dueAt.');

        const dueAt = new Date(dueAtRaw);
        if (Number.isNaN(dueAt.getTime())) {
          return toolError(`"${dueAtRaw}" is not a valid date. Use an ISO-8601 timestamp.`);
        }

        const plan = await this.deps.getCarePlan();
        const reminder = {
          reminderId: randomUUID(),
          text,
          dueAt: dueAt.toISOString(),
          kind: (args.kind === 'medication' || args.kind === 'appointment'
            ? args.kind
            : 'general') as 'medication' | 'appointment' | 'general',
          createdAt: nowIso(),
        };
        await this.deps.store.saveReminder(plan.patient.patientId, reminder);
        return toolResult(
          `Reminder set for ${dueAt.toLocaleString('en-US')}: ${text}`,
          { reminder },
        );
      },
    );
  }

  // --- reaching people -----------------------------------------------------

  private registerContactTools(): void {
    this.register(
      {
        name: 'list_contacts',
        title: 'Who they can reach',
        description:
          'The people in the care circle, and whether the person has approved each one to be contacted. Only contacts marked approved can be messaged or called — CareFlow refuses the rest whatever it is asked.',
        inputSchema: NO_ARGS,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const plan = await this.deps.getCarePlan();
        const contacts = plan.contacts.map((c) => ({
          contactId: c.contactId,
          name: c.displayName,
          relationship: c.relationship ?? c.role,
          role: c.role,
          approvedForContact: c.notifiableOutsideVisits,
        }));
        return toolResult(
          contacts
            .map((c) => `${c.name} (${c.relationship})${c.approvedForContact ? '' : ' — not approved'}`)
            .join('; '),
          { contacts },
        );
      },
    );

    this.register(
      {
        name: 'message_contact',
        title: 'Send someone a message',
        description:
          'Send a message to someone in the care circle. Requires the person to confirm first: this returns a confirmation request, not a sent message. Put what they actually said into the message rather than paraphrasing it.',
        inputSchema: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'From list_contacts.' },
            message: { type: 'string', description: "What to say, in their own words." },
          },
          required: ['contactId', 'message'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async (args, ctx) => {
        const contactId = str(args, 'contactId');
        const message = str(args, 'message');
        if (!contactId || !message) return toolError('Provide both contactId and message.');

        const plan = await this.deps.getCarePlan();
        const contact = plan.contacts.find((c) => c.contactId === contactId);
        if (!contact) return toolError(`No contact ${contactId}. Call list_contacts first.`);
        if (!contact.notifiableOutsideVisits) {
          return toolError(
            `${contact.displayName} is not approved for contact. The person controls that list, and CareFlow will not route around it.`,
          );
        }

        return this.requireConfirmation(
          {
            type: 'message_contact',
            contactId,
            message,
            summary: `send ${contact.displayName} a message saying "${message}"`,
          },
          ctx,
        );
      },
    );

    this.register(
      {
        name: 'call_contact',
        title: 'Call someone',
        description:
          'Start a call to someone in the care circle. Requires confirmation first. CareFlow cannot call emergency services — for an emergency the person must dial directly, and you should say so.',
        inputSchema: {
          type: 'object',
          properties: {
            contactId: { type: 'string', description: 'From list_contacts.' },
            reason: { type: 'string', description: 'Why, in one short phrase.' },
          },
          required: ['contactId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async (args, ctx) => {
        const contactId = str(args, 'contactId');
        if (!contactId) return toolError('Provide a contactId.');

        const plan = await this.deps.getCarePlan();
        const contact = plan.contacts.find((c) => c.contactId === contactId);
        if (!contact) return toolError(`No contact ${contactId}. Call list_contacts first.`);
        if (!contact.notifiableOutsideVisits) {
          return toolError(`${contact.displayName} is not approved for contact.`);
        }

        const reason = str(args, 'reason');
        return this.requireConfirmation(
          {
            type: 'call_contact',
            contactId,
            ...(reason ? { message: reason } : {}),
            summary: `call ${contact.displayName}${reason ? ` about ${reason}` : ''}`,
          },
          ctx,
        );
      },
    );
  }

  // --- medication ----------------------------------------------------------

  private registerMedicationTools(): void {
    this.register(
      {
        name: 'list_medications',
        title: 'Their medications',
        description:
          'Medication names, schedules, and how many days of supply remain. Names and timing only — CareFlow holds no doses, conditions, or history, and must never advise on medication. If asked whether to take something, say you cannot answer and offer to pass the question to their care team.',
        inputSchema: NO_ARGS,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const plan = await this.deps.getCarePlan();
        const medications = plan.medications.map((m) => ({
          medicationId: m.medicationId,
          name: m.name,
          schedule: m.schedule,
          daysSupplyRemaining: m.daysSupplyRemaining,
          refillsRemaining: m.refillsRemaining,
          runningLow: m.daysSupplyRemaining <= 7,
        }));
        const low = medications.filter((m) => m.runningLow);
        return toolResult(
          medications.map((m) => `${m.name}: ${m.schedule}, ${m.daysSupplyRemaining} days left`).join('; ') +
            (low.length ? ` Running low: ${low.map((m) => m.name).join(', ')}.` : ''),
          { medications, runningLow: low.map((m) => m.name) },
        );
      },
    );

    this.register(
      {
        name: 'request_medication_refill',
        title: 'Request a refill',
        description:
          'Ask the pharmacy for a refill. Requires confirmation first. This orders a repeat of an existing prescription — it never changes a dose, starts a new medication, or asks for anything not already on their list.',
        inputSchema: {
          type: 'object',
          properties: {
            medicationId: { type: 'string', description: 'From list_medications.' },
          },
          required: ['medicationId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async (args, ctx) => {
        const medicationId = str(args, 'medicationId');
        if (!medicationId) return toolError('Provide a medicationId.');

        const plan = await this.deps.getCarePlan();
        const med = plan.medications.find((m) => m.medicationId === medicationId);
        if (!med) return toolError(`No medication ${medicationId}. Call list_medications first.`);
        if (med.refillsRemaining <= 0) {
          return toolError(
            `There are no refills left on ${med.name}. Their prescriber has to authorise more — offer to message the care team instead.`,
          );
        }

        return this.requireConfirmation(
          {
            type: 'request_refill',
            message: `Refill request for ${med.name} at ${med.pharmacy}.`,
            summary: `ask ${med.pharmacy} to refill your ${med.name}`,
          },
          ctx,
        );
      },
    );
  }

  // --- appointments --------------------------------------------------------

  private registerAppointmentTools(): void {
    this.register(
      {
        name: 'list_appointments',
        title: 'Upcoming appointments',
        description:
          'Appointments coming up, with times, places, and whether transport is needed.',
        inputSchema: NO_ARGS,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const plan = await this.deps.getCarePlan();
        const appointments = plan.appointments
          .filter((a) => new Date(a.startsAt).getTime() > Date.now() - 3_600_000)
          .map((a) => ({
            appointmentId: a.appointmentId,
            title: a.title,
            withWhom: a.withWhom,
            when: new Date(a.startsAt).toLocaleString('en-US', {
              weekday: 'long',
              hour: 'numeric',
              minute: '2-digit',
            }),
            location: a.location,
            transportNeeded: a.transportNeeded ?? false,
          }));

        return toolResult(
          appointments.length === 0
            ? 'Nothing scheduled.'
            : appointments.map((a) => `${a.title} with ${a.withWhom}, ${a.when}`).join('; '),
          { appointments },
        );
      },
    );

    this.register(
      {
        name: 'book_appointment',
        title: 'Request an appointment',
        description:
          'Ask the care team to book an appointment. Requires confirmation first. This is a request to humans, not a confirmed booking — say so when you report back.',
        inputSchema: {
          type: 'object',
          properties: {
            withWhom: { type: 'string', description: 'Who the appointment is with.' },
            reason: { type: 'string', description: 'Why, in the person\'s own words.' },
            preferredTime: { type: 'string', description: 'Any preference they expressed.' },
          },
          required: ['withWhom'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async (args, ctx) => {
        const withWhom = str(args, 'withWhom');
        if (!withWhom) return toolError('Provide withWhom.');
        const reason = str(args, 'reason');
        const preferred = str(args, 'preferredTime');

        return this.requireConfirmation(
          {
            type: 'book_appointment',
            message: `Appointment request with ${withWhom}${reason ? `: ${reason}` : ''}${
              preferred ? ` (prefers ${preferred})` : ''
            }.`,
            summary: `ask your care team to book an appointment with ${withWhom}`,
          },
          ctx,
        );
      },
    );
  }

  // --- safety --------------------------------------------------------------

  private registerSafetyTools(): void {
    this.register(
      {
        name: 'get_support_resources',
        title: 'Human support, right now',
        description:
          "Crisis lines and the person's own on-call care team. Call this whenever someone expresses distress, hopelessness, or thoughts of harming themselves — then read the details out, stay warm, and offer to contact someone. Never attempt counselling, never assess how serious it is, and never imply you have contacted anyone. This tool is always available and never needs confirmation.",
        inputSchema: NO_ARGS,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const plan = await this.deps.getCarePlan();
        const resources = plan.supportResources;
        return toolResult(
          resources.map((r) => `${r.name}: ${r.contact} (${r.hours}). ${r.note ?? ''}`).join(' '),
          {
            resources,
            guidance:
              'Read these out warmly. Stay with them. Offer to contact a trusted person or their care team. Do not counsel, do not assess risk, do not claim to have called anyone.',
          },
        );
      },
    );

    this.register(
      {
        name: 'escalate_to_care_team',
        title: 'Get a human involved',
        description:
          "Tell the person's care team and trusted contact that they need someone. Requires confirmation first. Use it when the person asks for help, or agrees that a human should be involved. This notifies people — it does not contact emergency services, and you must say that plainly.",
        inputSchema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: "Why, in the person's own words where possible. No assessment.",
            },
          },
          required: ['reason'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async (args, ctx) => {
        const reason = str(args, 'reason');
        if (!reason) return toolError('Provide a reason, in their own words.');

        const plan = await this.deps.getCarePlan();
        const recipients = plan.contacts
          .filter((c) => c.role === 'care_coordinator' || c.role === 'trusted_contact')
          .map((c) => c.displayName)
          .join(' and ');

        return this.requireConfirmation(
          {
            type: 'escalate_care_team',
            message: `${reason} — relayed by CareFlow at their request. No assessment was made.`,
            note: 'Companion escalation: the person asked for a human.',
            summary: `let ${recipients || 'your care team'} know you need someone`,
          },
          ctx,
        );
      },
    );
  }

  // --- the gate ------------------------------------------------------------

  private registerConfirmation(): void {
    this.register(
      {
        name: 'confirm_action',
        title: 'Confirm or cancel',
        description:
          'Carry out, or cancel, an action that is waiting for the person to confirm. Only call this after you have asked them out loud and heard an answer. Never call it on their behalf, and never guess — if you are unsure what they meant, ask again.',
        inputSchema: {
          type: 'object',
          properties: {
            confirmationId: { type: 'string', description: 'From the pending action.' },
            affirmative: {
              type: 'boolean',
              description: 'true if they said yes, false if they said no.',
            },
          },
          required: ['confirmationId', 'affirmative'],
          additionalProperties: false,
        },
      },
      async (args, ctx) => {
        const id = str(args, 'confirmationId');
        if (!id) return toolError('Provide a confirmationId.');
        if (typeof args.affirmative !== 'boolean') {
          return toolError('affirmative must be true or false. Ask them again rather than guessing.');
        }

        this.sweepPending();
        const pending = this.pending.get(id);
        if (!pending) {
          return toolError(
            'That confirmation has expired or was already answered. Nothing was done. Ask again if they still want it.',
          );
        }

        // Single use, whatever the answer — so a "yes" cannot be replayed.
        this.pending.delete(id);

        if (!args.affirmative) {
          pending.machine.confirm(false);
          return toolResult(`Cancelled. Nothing was sent.`, {
            status: 'cancelled',
            willDo: pending.action.summary,
          });
        }

        pending.machine.confirm(true);
        const descriptor = toDescriptor(pending.action);
        // Last line of defence: throws unless this is exactly the approved action.
        pending.machine.assertExecutable(descriptor);

        const plan = await this.deps.getCarePlan();
        const result = await executeAction(pending.action, {
          // The consent machine has already done the gating, so the session shim exists
          // only to satisfy the shared executor's shape.
          session: {
            sessionId: `mcp:${ctx.sessionId}`,
            mode: 'companion',
            state: 'acting',
            turns: [],
            results: [],
          } as never,
          plan,
          confirmed: pending.action,
          demoMode: this.deps.demoMode,
          log: this.deps.log,
        });
        pending.machine.complete({ ok: result.ok, detail: result.detail });

        await this.deps.store.appendAudit({
          sessionId: `mcp:${ctx.sessionId}`,
          at: result.at,
          actor: 'careflow',
          event: `action_executed:${pending.action.type}`,
          from: 'awaiting_confirmation',
          to: 'done',
          action: pending.action,
          result,
        });
        await this.deps.store.appendTimeline({
          sessionId: `mcp:${ctx.sessionId}`,
          kind: 'action',
          at: result.at,
          text: result.detail,
          detail: `Confirmed by the person before anything happened. Channel: ${result.via}.`,
        });

        this.deps.log('mcp: action executed after confirmation', {
          action: pending.action.type,
        });

        return toolResult(result.detail, {
          status: 'done',
          action: pending.action.type,
          via: result.via,
          at: result.at,
        });
      },
    );
  }
}
