/**
 * Amazon Bedrock orchestrator.
 *
 * Bedrock does exactly two jobs here, and deliberately not a third:
 *
 *   1. **Phrase** the Observe/Explain/Ask turn from a normalized Ring event and a visit
 *      match that deterministic code already decided.
 *   2. **Extract intent** from free speech into a structured choice among actions that were
 *      already offered.
 *
 * It never decides whether an action may run, never selects a recipient that was not
 * offered, and never executes anything. Visit matching is plain code, because a model that
 * occasionally invents a scheduled visit would be worse than no feature at all.
 *
 * Everything the model returns is treated as untrusted input: intent comes back as a tool
 * call with a fixed schema, the chosen action id must be one we offered, and the phrasing
 * is length-checked and disclosure-checked before it reaches a patient. Safety boundaries
 * run on the transcript *before* the model is called, because a prompt instruction is not a
 * control.
 *
 * `index.ts` races every call against MODEL_DEADLINE_MS and falls back to the scripted
 * orchestrator on error or timeout, so none of this can leave a patient in silence.
 */

import type {
  AgentTurn,
  CarePlan,
  CareSession,
  Orchestrator,
  OrchestratorDeps,
  SensitiveAction,
} from '@careflow/shared';
import { AI_DISCLOSURE, EMERGENCY_PROTOTYPE_POLICY, isSensitive } from '@careflow/shared';
import { createScriptedOrchestrator } from './scripted.js';
import { checkBoundary } from './safety.js';

/** Hard cap on what the model may say in one turn. Patients get one question at a time. */
const MAX_SAY_CHARS = 420;

export function createBedrockOrchestrator(
  deps: OrchestratorDeps,
  runtimeOverride?: BedrockRuntime,
): Orchestrator {
  // The scripted orchestrator supplies the action catalogue and every state transition.
  // Bedrock only supplies words and a choice between actions that already exist, which is
  // what keeps the state machine deterministic while the voice sounds natural.
  const scripted = createScriptedOrchestrator(deps);
  const plan = deps.carePlan;

  return {
    async open(session) {
      const base = await scripted.open(session);
      if (session.mode === 'emergency_assist_prototype') {
        // The emergency wording is fixed by policy. There is no upside to a model
        // improvising here and a very clear downside.
        return base;
      }

      const say = await phraseOpening(session, plan, deps, runtimeOverride);
      if (!say) return base;

      // Keep the scripted turn's state, options, and rationale; swap only the words.
      return { ...base, say, engine: 'bedrock', rationale: base.rationale };
    },

    async respond(session, transcript) {
      // Boundaries first, on the raw transcript. A model that sees the text before these
      // run is a way for a medical question to get an answer.
      const boundary = checkBoundary(transcript);
      if (boundary) return scripted.respond(session, transcript);

      if (session.state === 'awaiting_confirmation' && session.pendingAction) {
        // Yes/no while something is pending is a confirmation, not a new request. Routing
        // it through intent extraction would re-interpret the word "yes".
        return scripted.respond(session, transcript);
      }

      const options = offeredActions(session, plan);
      const extracted = await extractIntent(transcript, options, deps, runtimeOverride);
      if (!extracted) return scripted.respond(session, transcript);

      const action = options.find((o) => o.action.type === extracted.actionId);
      if (!action) {
        // The model named something that was not offered. Fall back rather than improvise.
        deps.log('bedrock returned an action that was not offered', {
          actionId: extracted.actionId,
        });
        return scripted.respond(session, transcript);
      }

      const chosen: SensitiveAction = {
        ...action.action,
        ...(extracted.message ? { message: extracted.message } : {}),
        ...(extracted.note ? { note: extracted.note } : {}),
      };

      if (!isSensitive(chosen.type)) {
        return {
          say: `Okay. ${chosen.summary}.`,
          state: 'acting',
          executeAction: chosen,
          engine: 'bedrock',
          rationale: 'Non-sensitive action; no confirmation required.',
        };
      }

      return {
        say: `Just to confirm — should I ${chosen.summary}?`,
        state: 'awaiting_confirmation',
        pendingAction: chosen,
        engine: 'bedrock',
        rationale: `Explicit confirmation required before ${chosen.type}.`,
        options: [
          { actionId: 'confirm_yes', label: 'Yes, do that' },
          { actionId: 'confirm_no', label: 'No, cancel' },
        ],
      };
    },

    // Confirmation and cancellation are pure state transitions with fixed wording. There is
    // nothing for a model to add, and plenty for it to get wrong.
    confirm: (session, affirmative) => scripted.confirm(session, affirmative),
    cancel: (session) => scripted.cancel(session),
  };
}

// ---------------------------------------------------------------------------
// Bedrock calls
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the voice of CareFlow, an assistant that helps a person receiving care at home decide what to do when someone is at their door.

How to speak:
- Warm, calm, and brief. Two or three short sentences, never a paragraph.
- Exactly one question per turn.
- Plain words. The listener may be older, hard of hearing, or tired.
- Never pretend to be human. Never claim to be a nurse, doctor, or family member.

Hard rules:
- You do not give medical advice, name conditions, or comment on symptoms or medication.
- You cannot unlock doors, disarm alarms, or contact emergency services. Never imply otherwise.
- You cannot see or identify who is at the door. You only know whether a visit is scheduled.
- Never claim an action has happened. You are only speaking; something else acts.
- Say "appears to be" about a matched visit. A schedule match is not an identification.`;

export interface BedrockRuntime {
  converse(input: {
    modelId: string;
    system?: { text: string }[];
    messages: { role: 'user' | 'assistant'; content: { text?: string; toolResult?: unknown }[] }[];
    inferenceConfig?: { maxTokens?: number; temperature?: number };
    toolConfig?: unknown;
  }): Promise<BedrockResponse>;
}

interface BedrockResponse {
  output?: {
    message?: {
      content?: { text?: string; toolUse?: { name?: string; input?: unknown } }[];
    };
  };
  stopReason?: string;
}

let runtimePromise: Promise<BedrockRuntime | undefined> | undefined;

/**
 * Lazily construct the Bedrock client.
 *
 * Cached, including failure, so a machine without the SDK installed or without credentials
 * pays one failed import rather than one per turn.
 */
function getRuntime(deps: OrchestratorDeps): Promise<BedrockRuntime | undefined> {
  runtimePromise ??= (async () => {
    try {
      const { BedrockRuntimeClient, ConverseCommand } = await import(
        '@aws-sdk/client-bedrock-runtime'
      );
      const client = new BedrockRuntimeClient({ region: deps.awsRegion ?? 'us-east-1' });
      return {
        converse: (input) =>
          client.send(new ConverseCommand(input as never)) as unknown as Promise<BedrockResponse>,
      };
    } catch (err) {
      deps.log('bedrock runtime unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  })();
  return runtimePromise;
}

/** Ask the model to phrase the opening turn. Returns undefined to mean "use scripted". */
async function phraseOpening(
  session: CareSession,
  plan: CarePlan,
  deps: OrchestratorDeps,
  runtimeOverride?: BedrockRuntime,
): Promise<string | undefined> {
  const runtime = runtimeOverride ?? (await getRuntime(deps));
  if (!runtime || !deps.bedrockModelId) return undefined;

  const contact = session.match.contact;
  const next = session.match.nearestVisit;
  const trusted = plan.contacts.find(
    (c) => c.role === 'trusted_contact' && c.notifiableOutsideVisits,
  );

  // The facts are given; the model's only job is wording. It is not asked to decide
  // whether the visit matched, because it is not allowed to have an opinion about that.
  const facts = [
    `Event: ${describeEvent(session)}`,
    `Location: ${session.event.deviceName}`,
    `Visit match: ${session.match.status}`,
    `Why: ${session.match.reason}`,
    contact ? `Expected visitor: ${contact.displayName}, ${contact.relationship ?? contact.role}` : null,
    next
      ? `Next scheduled visit: ${new Date(next.startsAt).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        })}`
      : null,
    trusted ? `Trusted contact the listener can reach: ${trusted.displayName}` : null,
    `Listener's name: ${plan.patient.preferredName ?? plan.patient.displayName}`,
    plan.patient.careContext ? `Context: ${plan.patient.careContext.situation}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const choices =
    session.match.status === 'scheduled'
      ? `Offer exactly these choices, in your own words: tell them you're ready; ask for a few more minutes; do nothing.`
      : `Offer exactly these choices, in your own words: say you're unavailable; contact ${
          trusted?.displayName ?? 'someone you trust'
        }; do nothing.`;

  const prompt = `${facts}

Write what CareFlow says first. Structure it as:
1. Observe what happened.
2. Explain whether it matches a scheduled visit.
3. Ask one question.

${choices}

Begin with exactly this sentence, word for word: "${AI_DISCLOSURE}"
Then your own two or three short sentences. Return only the words to be spoken.`;

  try {
    const res = await runtime.converse({
      modelId: deps.bedrockModelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      // Low temperature: this is a care product, not a creative writing exercise, and the
      // same event should produce roughly the same words every time.
      inferenceConfig: { maxTokens: 300, temperature: 0.3 },
    });

    const text = res.output?.message?.content?.map((c) => c.text ?? '').join('').trim();
    if (!text) return undefined;

    return validateSpokenText(text, deps);
  } catch (err) {
    deps.log('bedrock phrasing failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

interface ExtractedIntent {
  actionId: string;
  message?: string;
  note?: string;
}

/**
 * Turn free speech into one of the offered actions.
 *
 * Uses a tool schema rather than asking for JSON in prose: the model has to produce a
 * structured call with an enumerated action id, which is far harder to get subtly wrong
 * than "respond with JSON".
 */
async function extractIntent(
  transcript: string,
  options: { action: SensitiveAction; description: string }[],
  deps: OrchestratorDeps,
  runtimeOverride?: BedrockRuntime,
): Promise<ExtractedIntent | undefined> {
  const runtime = runtimeOverride ?? (await getRuntime(deps));
  if (!runtime || !deps.bedrockModelId || options.length === 0) return undefined;

  // Widened to string on purpose: this list is what we check the model's answer against,
  // and the model can return anything at all.
  const actionIds: string[] = options.map((o) => o.action.type);

  const toolConfig = {
    tools: [
      {
        toolSpec: {
          name: 'choose_action',
          description:
            'Record which of the offered actions the person asked for, plus anything they want passed on.',
          inputSchema: {
            json: {
              type: 'object',
              properties: {
                action_id: {
                  type: 'string',
                  enum: actionIds,
                  description: 'The offered action the person asked for.',
                },
                message: {
                  type: 'string',
                  description:
                    "What to pass on, in the person's own words where possible. Omit if they said nothing to relay.",
                },
                note: {
                  type: 'string',
                  description:
                    'A non-clinical care task they mentioned, e.g. "help organising medications". Never a dose, a symptom, or medical advice. Omit if there is none.',
                },
                unclear: {
                  type: 'boolean',
                  description:
                    'True if you are not confident which action they asked for. Prefer this over guessing.',
                },
              },
              required: ['action_id'],
            },
          },
        },
      },
    ],
    toolChoice: { tool: { name: 'choose_action' } },
  };

  const catalogue = options.map((o) => `- ${o.action.type}: ${o.description}`).join('\n');

  try {
    const res = await runtime.converse({
      modelId: deps.bedrockModelId,
      system: [
        {
          text: `Map what the person said onto one of the offered actions. Do not invent actions. If you are not confident, set unclear to true — a wrong guess sends a message to a real person, so being unsure is the better answer.`,
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              text: `Offered actions:\n${catalogue}\n\nThey said: "${transcript}"\n\nRecord the action.`,
            },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 300, temperature: 0 },
      toolConfig,
    });

    const toolUse = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
    if (!toolUse?.input) return undefined;

    const input = toolUse.input as {
      action_id?: string;
      message?: string;
      note?: string;
      unclear?: boolean;
    };

    // The model saying "I'm not sure" is a useful answer, and acting on an unsure guess is
    // exactly the failure this whole design exists to prevent.
    if (input.unclear) {
      deps.log('bedrock reported unclear intent; falling back to the offered choices');
      return undefined;
    }
    if (!input.action_id || !actionIds.includes(input.action_id)) return undefined;

    return {
      actionId: input.action_id,
      ...(input.message ? { message: clip(input.message, 240) } : {}),
      ...(input.note ? { note: clip(`Patient request: ${input.note}`, 240) } : {}),
    };
  } catch (err) {
    deps.log('bedrock intent extraction failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

/**
 * Check the model's words before a patient hears them.
 *
 * Returns undefined to mean "discard this and use the scripted line". Three things matter:
 * the disclosure has to be present, the turn has to be short, and the model must not have
 * claimed a capability CareFlow does not have.
 */
export function validateSpokenText(text: string, deps: OrchestratorDeps): string | undefined {
  let say = text.replace(/^["']|["']$/g, '').trim();

  if (!say.includes(AI_DISCLOSURE)) {
    // Prepend rather than discard: the words may be fine, and the disclosure is
    // non-negotiable either way.
    say = `${AI_DISCLOSURE} ${say}`;
  }

  if (say.length > MAX_SAY_CHARS) {
    deps.log('bedrock turn too long; using scripted wording', { length: say.length });
    return undefined;
  }

  const overclaims = [
    /\bI (have |'ve )?(unlocked|opened|let .* in|disarmed)\b/i,
    /\bI (have |'ve )?(called|contacted|notified|told|messaged|sent)\b/i,
    /\b(911|emergency services|ambulance)\b/i,
    /\byou should (take|stop|skip)\b/i,
    /\bI(?:'| a)m a (nurse|doctor|human|person)\b/i,
  ];
  for (const pattern of overclaims) {
    if (pattern.test(say)) {
      // Either a claim about an action that has not happened, or a capability we do not
      // have. Both are worse than slightly stiffer wording.
      deps.log('bedrock turn overclaimed; using scripted wording', {
        matched: pattern.source,
      });
      return undefined;
    }
  }

  // Two questions in one turn is the most common accessibility failure in voice UIs.
  if ((say.match(/\?/g) ?? []).length > 1) {
    deps.log('bedrock turn asked more than one question; using scripted wording');
    return undefined;
  }

  return say;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The action catalogue for the current session.
 *
 * Built from the care plan in code, never by the model. The model may only pick from this
 * list, so it cannot name a recipient the patient has not approved.
 */
function offeredActions(
  session: CareSession,
  plan: CarePlan,
): { action: SensitiveAction; description: string }[] {
  const caregiver = session.match.contact?.notifiableOutsideVisits
    ? session.match.contact
    : plan.contacts.find((c) => c.role === 'caregiver' && c.notifiableOutsideVisits);
  const trusted = plan.contacts.find((c) => c.role === 'trusted_contact');
  const name = plan.patient.preferredName ?? plan.patient.displayName;
  const out: { action: SensitiveAction; description: string }[] = [];

  if (caregiver) {
    out.push({
      action: {
        type: 'notify_caregiver',
        contactId: caregiver.contactId,
        message: `${name} says she is ready for you.`,
        summary: `tell ${caregiver.displayName} you're ready`,
      },
      description: `Tell ${caregiver.displayName} that they are ready, or how long they need.`,
    });
  }
  if (trusted && trusted.notifiableOutsideVisits) {
    out.push({
      action: {
        type: 'notify_trusted_contact',
        contactId: trusted.contactId,
        message: `There was an unexpected visitor at ${name}'s ${session.event.deviceName.toLowerCase()} and she asked me to let you know.`,
        summary: `notify ${trusted.displayName}`,
      },
      description: `Contact ${trusted.displayName} (${trusted.relationship ?? trusted.role}).`,
    });
  }
  out.push({
    action: {
      type: 'message_visitor',
      message: `${name} isn't available right now.`,
      summary: "let the visitor know you're unavailable",
    },
    description: 'Let the person at the door know they are unavailable.',
  });
  out.push({
    action: { type: 'do_nothing', summary: 'take no action' },
    description: 'Do nothing at all.',
  });

  if (session.mode === 'emergency_assist_prototype') {
    out.push({
      action: {
        type: 'escalate_care_team',
        message: 'The patient asked for help.',
        summary: 'let your care team know you need help',
      },
      description: `Let the care team know help is needed. ${EMERGENCY_PROTOTYPE_POLICY.spokenSafetyLine}`,
    });
  }

  return out;
}

function describeEvent(session: CareSession): string {
  if (session.event.kind === 'doorbell') return 'Someone pressed the doorbell';
  if (session.event.kind === 'motion') {
    return session.event.subType === 'human' ? 'A person was detected' : 'Motion was detected';
  }
  return session.event.ringType.replace(/_/g, ' ');
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
