/**
 * Session service: the spine of CareFlow.
 *
 * Everything the agent proposes passes through `applyTurn`, which is the one place that
 * decides whether an action is allowed to happen. The orchestrator can propose anything —
 * it is a language model — and this layer refuses whatever breaks the contract:
 *
 *   - the first agent turn of a session must carry the AI disclosure
 *   - `executeAction` is only honoured from `awaiting_confirmation` after an affirmative
 *   - the executed action must structurally equal the action the patient confirmed
 *   - blocked capabilities never execute, from any state, for any reason
 *
 * Refusals are not silent: each one lands in the timeline as a `refusal` entry, because a
 * safety property nobody can see is indistinguishable from one that does not exist.
 */

import { randomUUID } from 'node:crypto';
import type {
  ActionResult,
  AgentTurn,
  CareEvent,
  CarePlan,
  CareSession,
  ConsentState,
  Orchestrator,
  RingWebhookPayload,
  SensitiveAction,
  SessionMode,
  Turn,
} from '@careflow/shared';
import {
  AI_DISCLOSURE,
  BLOCKED_CAPABILITIES,
  isSensitive,
  nowIso,
  sameAction,
} from '@careflow/shared';
import { isPatientFacing, normalizeRingEvent } from '@careflow/ring';
import { ConsentStateError, type MachineSnapshot } from '@careflow/consent-engine';
import { createMachine, toDescriptor } from './consent.js';
import { ActionRefused, assertAllowed, executeAction } from './actions.js';
import type { Bus } from './bus.js';
import { matchVisit } from './match.js';
import type { Store } from './store.js';

export interface SessionServiceDeps {
  store: Store;
  bus: Bus;
  /**
   * Resolves the care plan for *now*. A function rather than a value because demo-anchored
   * visit windows are relative to the current minute, and a plan captured at startup would
   * drift out from under the matcher on a long-running server.
   */
  getCarePlan: () => Promise<CarePlan>;
  orchestrator: Orchestrator;
  demoMode: boolean;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export type IntakeResult =
  | { outcome: 'session_created'; session: CareSession }
  | { outcome: 'duplicate'; requestId: string }
  | { outcome: 'logged_only'; event: CareEvent };

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  /**
   * Handle a verified Ring delivery.
   *
   * Called from the webhook handler after signature verification. Ring expects a 200 within
   * five seconds, so the caller returns as soon as this resolves and nothing slow belongs
   * in here — the orchestrator's first turn is the one risk, which is why it has a deadline.
   */
  async intakeRingEvent(
    payload: RingWebhookPayload,
    source: 'ring' | 'simulator',
  ): Promise<IntakeResult> {
    const plan = await this.deps.getCarePlan();
    const event = normalizeRingEvent(payload, { carePlan: plan, source });

    // Ring retries on any non-2xx, and dedupes on meta.request_id. Without this check a
    // retried doorbell press starts a second conversation about the same visitor.
    const fresh = await this.deps.store.claimRingDelivery(event.requestId, event.eventId);
    if (!fresh) {
      this.deps.log('duplicate Ring delivery ignored', { requestId: event.requestId });
      return { outcome: 'duplicate', requestId: event.requestId };
    }

    // Sorted on receipt time, not the event's own timestamp, so every entry belonging to
    // one session stays contiguous in the timeline. Sorting on the device clock would put
    // the AI's decision above the event that caused it whenever the two disagree — which
    // they do, since Ring timestamps the device and we timestamp the delivery.
    await this.publishTimeline({
      kind: 'ring_event',
      at: nowIso(),
      text: `${describeRingEvent(event)} at the ${event.deviceName.toLowerCase()}`,
      detail: `Ring ${event.ringType}${event.subType ? ` (${event.subType})` : ''} · event timestamp ${new Date(
        event.occurredAt,
      ).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · delivery ${
        source === 'ring' ? 'from Ring' : 'from the CareFlow Ring simulator'
      } · signature verified`,
    });

    if (!isPatientFacing(event)) {
      // Logged for the audit trail, but the house stays quiet.
      this.deps.log('event logged without starting a conversation', { kind: event.kind });
      return { outcome: 'logged_only', event };
    }

    const session = await this.openSession(event, 'visitor');
    return { outcome: 'session_created', session };
  }

  /**
   * Start the emergency-assist prototype. Patient-initiated only — there is no code path
   * that reaches this from an inference about audio, motion, or inactivity, and that is a
   * deliberate design limit rather than an unfinished feature.
   */
  async startEmergencyAssist(): Promise<CareSession> {
    const at = nowIso();
    const event: CareEvent = {
      eventId: `patient_help_${Date.now()}`,
      requestId: randomUUID(),
      deviceId: 'careflow-app',
      deviceName: 'CareFlow app',
      kind: 'patient_request',
      ringType: 'button_press',
      occurredAt: at,
      source: 'patient',
    };

    await this.publishTimeline({
      kind: 'patient_choice',
      at,
      text: 'Patient asked CareFlow for help',
      detail:
        'Emergency-assist prototype, started by the patient. CareFlow does not detect emergencies and does not contact emergency services.',
    });

    return this.openSession(event, 'emergency_assist_prototype');
  }

  private async openSession(event: CareEvent, mode: SessionMode): Promise<CareSession> {
    const match = matchVisit(event, await this.deps.getCarePlan());

    const session: CareSession = {
      sessionId: randomUUID(),
      mode,
      event,
      match,
      state: 'observed',
      turns: [],
      results: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // Open the consent machine on the event itself, so its audit trail starts where the
    // session does rather than at the first action.
    const machine = createMachine(session.sessionId);
    machine.observe({
      id: event.eventId,
      kind: event.kind,
      detail: { deviceId: event.deviceId, requestId: event.requestId, source: event.source },
    });
    session.consent = machine.snapshot();

    await this.deps.store.saveSession(session);
    await this.deps.store.appendAudit({
      sessionId: session.sessionId,
      at: session.createdAt,
      actor: event.source === 'patient' ? 'patient' : 'ring',
      event: `session_opened:${mode}`,
      to: 'observed',
    });

    if (match.status !== 'not_applicable') {
      await this.publishTimeline({
        sessionId: session.sessionId,
        kind: 'ai_decision',
        at: nowIso(),
        text:
          match.status === 'scheduled'
            ? `CareFlow matched a scheduled visit${match.contact ? ` with ${match.contact.displayName}` : ''}`
            : 'CareFlow identified an unexpected visitor',
        detail: match.reason,
      });
    }

    const turn = await this.deps.orchestrator.open(session);
    return this.applyTurn(session, turn, { requireDisclosure: true });
  }

  // -------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------

  async respond(sessionId: string, transcript: string): Promise<{ session: CareSession; turn: AgentTurn }> {
    const session = await this.require(sessionId);
    this.assertLive(session);

    const patientTurn: Turn = {
      turnId: randomUUID(),
      speaker: 'patient',
      text: transcript,
      at: nowIso(),
    };
    session.turns.push(patientTurn);
    await this.deps.store.saveSession(session);
    await this.publishTimeline({
      sessionId,
      kind: 'patient_choice',
      at: patientTurn.at,
      text: `Patient said: "${transcript}"`,
    });

    const turn = await this.deps.orchestrator.respond(session, transcript);
    const updated = await this.applyTurn(session, turn);
    return { session: updated, turn };
  }

  async confirm(sessionId: string, affirmative: boolean): Promise<{ session: CareSession; turn: AgentTurn }> {
    const session = await this.require(sessionId);
    this.assertLive(session);

    if (session.state !== 'awaiting_confirmation' || !session.pendingAction) {
      // Refuse rather than guess. A confirmation with nothing pending is a sign the UI and
      // the backend disagree about state, and guessing would mean acting on an assumption.
      throw new SessionError(
        'no_pending_confirmation',
        `Session is in state "${session.state}" with no action awaiting confirmation.`,
        409,
      );
    }

    await this.deps.store.appendAudit({
      sessionId,
      at: nowIso(),
      actor: 'patient',
      event: affirmative ? 'consent_granted' : 'consent_declined',
      from: session.state,
      action: session.pendingAction,
    });
    await this.publishTimeline({
      sessionId,
      kind: 'consent',
      at: nowIso(),
      text: affirmative
        ? `Patient approved: ${session.pendingAction.summary}`
        : `Patient declined: ${session.pendingAction.summary}`,
      detail: affirmative
        ? 'Explicit confirmation recorded before any action was taken.'
        : 'No action taken.',
    });

    const turn = await this.deps.orchestrator.confirm(session, affirmative);
    const updated = await this.applyTurn(session, turn, { confirmedAffirmative: affirmative });
    return { session: updated, turn };
  }

  async cancel(sessionId: string): Promise<{ session: CareSession; turn: AgentTurn }> {
    const session = await this.require(sessionId);
    const turn = await this.deps.orchestrator.cancel(session);
    const updated = await this.applyTurn(session, turn);
    return { session: updated, turn };
  }

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  private async applyTurn(
    session: CareSession,
    turn: AgentTurn,
    opts: { requireDisclosure?: boolean; confirmedAffirmative?: boolean } = {},
  ): Promise<CareSession> {
    const previousState = session.state;

    // Invariant: the patient is told they are talking to an AI, every session, first turn.
    if (opts.requireDisclosure && !turn.say.includes(AI_DISCLOSURE)) {
      this.deps.log('orchestrator omitted the AI disclosure; prepending it', {
        sessionId: session.sessionId,
      });
      turn = { ...turn, say: `${AI_DISCLOSURE} ${turn.say}`, disclosure: true };
    }

    const agentTurn: Turn = {
      turnId: randomUUID(),
      speaker: 'agent',
      text: turn.say,
      at: nowIso(),
    };
    if (turn.disclosure || opts.requireDisclosure) agentTurn.disclosure = true;
    session.turns.push(agentTurn);

    // The consent engine, rehydrated from the session. It runs the same rules
    // independently of the checks below — see lib/consent.ts for why the redundancy is
    // deliberate rather than wasteful.
    const machine = createMachine(
      session.sessionId,
      session.consent as MachineSnapshot<SensitiveAction> | undefined,
    );

    try {
      // A confirmation answer moves the machine first, so that an expired or already-
      // answered confirmation is caught before anything looks at the proposed action.
      if (opts.confirmedAffirmative !== undefined && machine.state === 'awaiting_confirmation') {
        machine.confirm(opts.confirmedAffirmative);
      }

      // An action proposed this turn has to be offered and chosen before it can be
      // confirmed. `choose` requires an exact id, so an action the agent invented on the
      // spot cannot slip through.
      const proposed = turn.pendingAction ?? (opts.confirmedAffirmative === undefined ? turn.executeAction : undefined);
      if (proposed) {
        const descriptor = toDescriptor(proposed);
        machine.offer([descriptor]);
        machine.choose(descriptor.id);
      }
    } catch (err) {
      session.consent = machine.snapshot();
      return this.refuse(session, turn, err, previousState);
    }

    if (turn.pendingAction) {
      try {
        // Check before offering, so the patient is never asked to approve something that
        // would then be refused. Being told "yes, and then no" is worse than a clear no.
        assertAllowed(turn.pendingAction, await this.deps.getCarePlan());
        session.pendingAction = turn.pendingAction;
      } catch (err) {
        session.consent = machine.snapshot();
        return this.refuse(session, turn, err, previousState);
      }
    }

    let executed: SensitiveAction | undefined = turn.executeAction;

    if (executed) {
      const violation = this.checkExecutionAllowed(executed, session, previousState, opts);
      if (violation) {
        session.consent = machine.snapshot();
        return this.refuse(session, turn, new ActionRefused(violation.code, violation.message), previousState);
      }

      // Second, independent check: the engine refuses unless this exact descriptor —
      // payload included — is the one it saw confirmed, and unless it is in `acting`.
      try {
        machine.assertExecutable(toDescriptor(executed));
      } catch (err) {
        this.deps.log('consent engine refused an execution the domain gate allowed', {
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        session.consent = machine.snapshot();
        return this.refuse(
          session,
          turn,
          new ActionRefused('not_confirmed', err instanceof Error ? err.message : String(err)),
          previousState,
        );
      }
    }

    session.state = turn.state;
    session.updatedAt = nowIso();
    if (turn.options) session.options = turn.options;

    if (executed) {
      session.confirmedAction = session.pendingAction ?? executed;
      let result: ActionResult;
      try {
        result = await executeAction(executed, {
          session,
          plan: await this.deps.getCarePlan(),
          confirmed: session.confirmedAction,
          demoMode: this.deps.demoMode,
          log: this.deps.log,
        });
      } catch (err) {
        return this.refuse(session, turn, err, previousState);
      }

      machine.complete({ ok: result.ok, detail: result.detail });
      session.results.push(result);
      session.state = 'done';
      session.handoff = buildHandoff(session, executed);
      delete session.pendingAction;

      await this.deps.store.appendAudit({
        sessionId: session.sessionId,
        at: result.at,
        actor: 'careflow',
        event: `action_executed:${executed.type}`,
        from: 'acting',
        to: 'done',
        action: executed,
        result,
      });
      await this.publishTimeline({
        sessionId: session.sessionId,
        kind: 'action',
        at: result.at,
        text: result.detail,
        detail: `Channel: ${result.via}. No door was unlocked and no medical advice was given.`,
      });
    }

    session.consent = machine.snapshot();
    await this.deps.store.saveSession(session);
    if (previousState !== session.state) {
      await this.deps.store.appendAudit({
        sessionId: session.sessionId,
        at: session.updatedAt,
        actor: 'careflow',
        event: 'state_changed',
        from: previousState,
        to: session.state,
      });
    }

    this.deps.bus.publish({ type: 'session', session, turn });
    return session;
  }

  /** Returns a violation when the proposed execution breaks the consent contract. */
  private checkExecutionAllowed(
    action: SensitiveAction,
    session: CareSession,
    previousState: ConsentState,
    opts: { confirmedAffirmative?: boolean },
  ): { code: 'blocked_capability' | 'not_confirmed' | 'action_mismatch'; message: string } | null {
    if ((BLOCKED_CAPABILITIES as readonly string[]).includes(action.type)) {
      return {
        code: 'blocked_capability',
        message: `${action.type} is a blocked capability.`,
      };
    }

    if (!isSensitive(action.type)) return null;

    if (previousState !== 'awaiting_confirmation') {
      return {
        code: 'not_confirmed',
        message: `Sensitive action proposed from "${previousState}" without a confirmation turn.`,
      };
    }
    if (opts.confirmedAffirmative === false) {
      return {
        code: 'not_confirmed',
        message: 'Sensitive action proposed after the patient declined.',
      };
    }
    if (!sameAction(action, session.pendingAction)) {
      return {
        code: 'action_mismatch',
        message: 'Action to execute differs from the action the patient confirmed.',
      };
    }
    return null;
  }

  /**
   * Record a refusal and tell the patient plainly. The session stays usable: a refused
   * action should not strand somebody mid-conversation with no way forward.
   */
  private async refuse(
    session: CareSession,
    turn: AgentTurn,
    err: unknown,
    previousState: ConsentState,
  ): Promise<CareSession> {
    // Refusals arrive from two places: the domain gate (ActionRefused) and the consent
    // engine (ConsentStateError). Normalize both, because what the patient hears has to
    // match the actual reason — telling someone "I didn't have your approval" when the
    // truth is "I can't do that at all" is a small lie that erodes the whole product.
    const code = refusalCode(err);
    const message = err instanceof Error ? err.message : String(err);

    this.deps.log('action refused by the consent gate', {
      sessionId: session.sessionId,
      code,
      message,
    });

    session.state = previousState === 'observed' ? 'awaiting_choice' : previousState;
    session.updatedAt = nowIso();
    delete session.pendingAction;

    // Clear any consent the engine was holding. A refused turn must not leave an approved
    // action sitting there for a later call to pick up.
    const machine = createMachine(
      session.sessionId,
      session.consent as MachineSnapshot<SensitiveAction> | undefined,
    );
    machine.cancel(`refused:${code}`);
    session.consent = machine.snapshot();

    const say =
      code === 'blocked_capability'
        ? "That isn't something I'm able to do. I can let your care team know, or contact someone you trust."
        : code === 'expired'
          ? "I waited a while and didn't hear back, so I haven't done anything. Would you like to tell me again?"
          : code === 'contact_not_notifiable'
            ? "I'm not set up to contact them. You can change who I'm allowed to contact in your settings. Is there someone else?"
            : "I didn't have your clear approval for that, so I haven't done anything. Would you like to tell me again?";

    session.turns.push({ turnId: randomUUID(), speaker: 'agent', text: say, at: nowIso() });

    await this.deps.store.saveSession(session);
    await this.deps.store.appendAudit({
      sessionId: session.sessionId,
      at: session.updatedAt,
      actor: 'careflow',
      event: `action_refused:${code}`,
      from: previousState,
      to: session.state,
    });
    await this.publishTimeline({
      sessionId: session.sessionId,
      kind: 'refusal',
      at: session.updatedAt,
      text: 'CareFlow refused an action',
      detail: `${code}: ${message}`,
    });

    const refusedTurn: AgentTurn = {
      say,
      state: session.state,
      engine: turn.engine ?? 'scripted',
      rationale: `${code}: ${message}`,
    };
    this.deps.bus.publish({ type: 'session', session, turn: refusedTurn });
    return session;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async get(sessionId: string): Promise<CareSession | undefined> {
    return this.deps.store.getSession(sessionId);
  }

  async list(limit = 25): Promise<CareSession[]> {
    return this.deps.store.listAllSessions(limit);
  }

  private async require(sessionId: string): Promise<CareSession> {
    const session = await this.deps.store.getSession(sessionId);
    if (!session) throw new SessionError('session_not_found', `No session ${sessionId}.`, 404);
    return session;
  }

  private assertLive(session: CareSession): void {
    if (session.state === 'done' || session.state === 'cancelled') {
      throw new SessionError(
        'session_closed',
        `Session is already ${session.state}; start a new one.`,
        409,
      );
    }
  }

  private async publishTimeline(entry: Parameters<Store['appendTimeline']>[0]): Promise<void> {
    const saved = await this.deps.store.appendTimeline(entry);
    this.deps.bus.publish({ type: 'timeline', entry: saved });
  }
}

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

function describeRingEvent(event: CareEvent): string {
  if (event.kind === 'doorbell') return 'Doorbell pressed';
  if (event.kind === 'motion') {
    return event.subType === 'package'
      ? 'Package detected'
      : event.subType === 'human'
        ? 'Person detected'
        : 'Motion detected';
  }
  return event.ringType.replace(/_/g, ' ');
}

/** The structured handoff the caregiver dashboard renders. Non-clinical by construction. */
function buildHandoff(session: CareSession, action: SensitiveAction): CareSession['handoff'] {
  const patientWords = [...session.turns].reverse().find((t) => t.speaker === 'patient')?.text;
  const handoff: NonNullable<CareSession['handoff']> = {
    request: patientWords ?? action.summary,
    note: action.note ?? action.summary,
  };
  const mins = action.message?.match(/(\d{1,2})\s*minutes/);
  if (mins?.[1]) handoff.readyInMinutes = Number(mins[1]);
  return handoff;
}

/**
 * Normalize a refusal from either enforcement layer into one vocabulary.
 *
 * `ActionRefused` comes from the domain gate, `ConsentStateError` from the consent engine.
 * They overlap deliberately — see lib/consent.ts — so the same underlying refusal can
 * surface from either, and the patient-facing wording must not depend on which one got
 * there first.
 */
function refusalCode(err: unknown): string {
  if (err instanceof ActionRefused) return err.code;
  if (err instanceof ConsentStateError) {
    switch (err.code) {
      case 'blocked_action':
        return 'blocked_capability';
      case 'expired':
        return 'expired';
      case 'wrong_state':
      case 'no_pending_action':
        return 'not_confirmed';
      case 'unknown_action':
        return 'action_mismatch';
      default:
        return 'not_confirmed';
    }
  }
  return 'unknown';
}
