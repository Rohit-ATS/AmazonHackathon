/**
 * Deterministic orchestrator.
 *
 * Two jobs:
 *   1. Make the whole pipeline demoable from day one, before Bedrock is wired.
 *   2. Be the fallback when Bedrock errors or is slow, so the agent never goes silent in
 *      front of a judge. A warm, slightly stiff sentence beats dead air.
 *
 * It follows the same Observe -> Explain -> Ask -> Confirm -> Act -> Summarize shape as the
 * Bedrock path, and it is held to the same safety rules, so swapping between them changes
 * the wording and not the behaviour.
 */

import type {
  AgentTurn,
  CarePlan,
  CareSession,
  Orchestrator,
  OrchestratorDeps,
  SensitiveAction,
} from '@careflow/shared';
import {
  AI_DISCLOSURE,
  EMERGENCY_PROTOTYPE_POLICY,
  isSensitive,
} from '@careflow/shared';
import { checkBoundary } from './safety.js';

const YES = /\b(yes|yeah|yep|sure|ok|okay|please do|go ahead|do it|correct|that's right)\b/i;
const NO = /\b(no|nope|don't|do not|cancel|stop|never mind|nevermind)\b/i;

export function createScriptedOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const plan = deps.carePlan;

  return {
    async open(session) {
      if (session.mode === 'emergency_assist_prototype') return openEmergency(plan);
      return session.match.status === 'scheduled' ? openScheduled(session, plan) : openUnscheduled(session, plan);
    },

    async respond(session, transcript) {
      // Boundaries first. Nothing a patient says should be able to route around these,
      // and an intent extractor that sees the text first is a way for that to happen.
      const boundary = checkBoundary(transcript);
      if (boundary) {
        deps.log('safety boundary triggered', { kind: boundary.kind, sessionId: session.sessionId });

        if (boundary.kind === 'emergency_claim') {
          // `escalate_care_team` is reserved for the patient-started prototype. In an
          // ordinary visitor session, offer the normal caregiver notification instead.
          const care = caregiver(plan);
          const action: SensitiveAction =
            session.mode === 'emergency_assist_prototype'
              ? escalationAction(plan, 'The patient asked for urgent help.')
              : {
                  type: 'notify_caregiver',
                  ...(care ? { contactId: care.contactId } : {}),
                  message: 'The patient asked the care team to contact them. No medical assessment was made.',
                  note: 'Patient requested help after being directed to call emergency services directly if needed.',
                  summary: `tell ${care?.displayName ?? 'your care team'} you need help`,
                };
          return {
            say: boundary.say,
            state: 'awaiting_confirmation',
            pendingAction: action,
            engine: 'scripted',
            rationale: boundary.rationale,
            options: [
              { actionId: 'confirm_yes', label: 'Yes, tell my care team' },
              { actionId: 'confirm_no', label: 'No, not now' },
            ],
          };
        }

        if (boundary.kind === 'medical_advice') {
          const action: SensitiveAction = {
            type: 'notify_caregiver',
            contactId: caregiver(plan)?.contactId,
            message: `Eleanor asked a question for the care team: "${transcript.trim()}"`,
            note: 'Question forwarded unanswered. CareFlow does not give medical advice.',
            summary: `Send your question to ${caregiver(plan)?.displayName ?? 'your care team'}`,
          };
          return {
            say: boundary.say,
            state: 'awaiting_confirmation',
            pendingAction: action,
            engine: 'scripted',
            rationale: boundary.rationale,
            options: [
              { actionId: 'confirm_yes', label: 'Yes, send it' },
              { actionId: 'confirm_no', label: 'No' },
            ],
          };
        }

        // Door unlock and identification: re-offer the real choices, stay in choice state.
        return {
          say: boundary.say,
          state: 'awaiting_choice',
          engine: 'scripted',
          rationale: boundary.rationale,
          options: choicesFor(session, plan),
        };
      }

      // A plain yes/no while a confirmation is pending is a confirmation, not a new intent.
      if (session.state === 'awaiting_confirmation' && session.pendingAction) {
        if (YES.test(transcript)) return confirmTurn(session, true);
        if (NO.test(transcript)) return confirmTurn(session, false);
      }

      const action = extractIntent(transcript, session, plan);
      if (!action) {
        const useButtons = previousAgentTurnWasUnrecognised(session);
        return {
          say: useButtons
            ? "I'm still having trouble understanding. Please use the buttons on screen."
            : "Sorry, I didn't catch that. You can tell me to let them know you're ready, contact someone you trust, or do nothing.",
          state: 'awaiting_choice',
          engine: 'scripted',
          rationale: useButtons
            ? 'Two unrecognised requests in a row; switched to the on-screen buttons.'
            : 'Unrecognised request; re-offered the available choices.',
          options: choicesFor(session, plan),
        };
      }

      if (!isSensitive(action.type)) {
        // Benign actions skip confirmation: there is nothing to undo about a note.
        return {
          say: `Okay. ${action.summary}.`,
          state: 'acting',
          executeAction: action,
          engine: 'scripted',
          rationale: 'Non-sensitive action; no confirmation required.',
        };
      }

      return {
        say: `Just to confirm — ${confirmQuestion(action)}`,
        state: 'awaiting_confirmation',
        pendingAction: action,
        engine: 'scripted',
        rationale: `Explicit confirmation required before ${action.type}.`,
        options: [
          { actionId: 'confirm_yes', label: 'Yes, do that' },
          { actionId: 'confirm_no', label: 'No, cancel' },
        ],
      };
    },

    async confirm(session, affirmative) {
      return confirmTurn(session, affirmative);
    },

    async cancel(session) {
      return {
        say: "Okay, I won't do anything. I'm here if you change your mind.",
        state: 'cancelled',
        engine: 'scripted',
        rationale: 'Patient cancelled; no action taken.',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

function openScheduled(session: CareSession, plan: CarePlan): AgentTurn {
  const contact = session.match.contact;
  const name = contact?.displayName ?? 'your scheduled visitor';
  // "appears to be" rather than "is": we matched a schedule, we did not identify a person,
  // and the wording should not claim more than the system knows.
  const confident = session.match.minutesFromWindow === 0;

  return {
    say: `${AI_DISCLOSURE} ${
      confident
        ? `Your scheduled care provider, ${name}, appears to be at the ${session.event.deviceName.toLowerCase()}.`
        : `Someone is at the ${session.event.deviceName.toLowerCase()}, and it looks like ${name}, who is due for a visit.`
    } Would you like to tell them you're ready, or ask for a few more minutes?`,
    state: 'awaiting_choice',
    disclosure: true,
    engine: 'scripted',
    rationale: session.match.reason,
    options: choicesFor(session, plan),
  };
}

function openUnscheduled(session: CareSession, plan: CarePlan): AgentTurn {
  const trusted = trustedContact(plan);
  const next = session.match.nearestVisit;
  const nextText = next
    ? ` Your next visit isn't until ${new Date(next.startsAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })}.`
    : '';

  return {
    say: `${AI_DISCLOSURE} There is someone at the ${session.event.deviceName.toLowerCase()}, but I don't see a scheduled visit.${nextText} Would you like me to say you're unavailable, contact ${
      trusted?.displayName ?? 'someone you trust'
    }, or do nothing?`,
    state: 'awaiting_choice',
    disclosure: true,
    engine: 'scripted',
    rationale: session.match.reason,
    options: choicesFor(session, plan),
  };
}

function openEmergency(plan: CarePlan): AgentTurn {
  // Confirmation-only by policy: one offer, one confirmation, no inference, and the safety
  // line is spoken before anything else.
  return {
    say: `${AI_DISCLOSURE} ${EMERGENCY_PROTOTYPE_POLICY.spokenSafetyLine} Would you like me to tell them now?`,
    state: 'awaiting_confirmation',
    disclosure: true,
    pendingAction: escalationAction(plan, 'The patient used the help button.'),
    engine: 'scripted',
    rationale:
      'Emergency-assist prototype: patient-initiated, confirmation-only, no severity assessment, no emergency dispatch.',
    options: [
      { actionId: 'confirm_yes', label: 'Yes, tell my care team' },
      { actionId: 'confirm_no', label: 'No, not now' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/**
 * Keyword intent extraction. Intentionally conservative: anything it is not sure about
 * returns undefined and the patient is re-offered the choices, because a wrong guess here
 * sends a message to somebody's daughter.
 */
function extractIntent(
  transcript: string,
  session: CareSession,
  plan: CarePlan,
): SensitiveAction | undefined {
  const t = transcript.toLowerCase();
  const caregiverContact = session.match.contact?.notifiableOutsideVisits
    ? session.match.contact
    : caregiver(plan);
  const trusted = trustedContact(plan);

  if (/\b(nothing|ignore|leave it|don't answer)\b/.test(t)) {
    return { type: 'do_nothing', summary: 'take no action' };
  }

  if (
    (/\b(daughter|maya|trusted|my family|son|neighbour|neighbor)\b/.test(t) ||
      /\bcontact (someone|somebody)\b/.test(t)) &&
    trusted
  ) {
    return {
      type: 'notify_trusted_contact',
      contactId: trusted.contactId,
      message: `There was an unexpected visitor at Eleanor's ${session.event.deviceName.toLowerCase()} and she asked me to let you know.`,
      summary: `notify ${trusted.displayName}`,
    };
  }

  if (/\b(unavailable|not available|can't answer|cannot answer|busy|away)\b/.test(t)) {
    return {
      type: 'message_visitor',
      message: "Eleanor isn't available right now.",
      summary: "let the visitor know you're unavailable",
    };
  }

  if (/\b(ready|coming|minute|minutes|moment|tell|let .* know)\b/.test(t) && caregiverContact) {
    const readyIn = parseMinutes(t);
    const note = extractNote(transcript);
    const action: SensitiveAction = {
      type: 'notify_caregiver',
      contactId: caregiverContact.contactId,
      message: readyIn
        ? `Eleanor will be ready in about ${readyIn} minutes.`
        : 'Eleanor says she is ready for you.',
      summary: readyIn
        ? `tell ${caregiverContact.displayName} you'll be ready in ${readyIn} minutes`
        : `tell ${caregiverContact.displayName} you're ready`,
    };
    // Non-clinical handoff note. "Help organising medications" is a task, not a dosage
    // decision — relaying it is coordination, which is squarely inside what CareFlow does.
    if (note) action.note = note;
    return action;
  }

  return undefined;
}

function parseMinutes(t: string): number | undefined {
  const words: Record<string, number> = {
    a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20,
  };
  const digit = t.match(/\b(\d{1,2})\s*(?:minute|min)/);
  if (digit?.[1]) return Number(digit[1]);
  const word = t.match(/\b(a|one|two|three|four|five|ten|fifteen|twenty)\s*(?:minute|min)/);
  if (word?.[1]) return words[word[1]];
  if (/\bmoment|\bsecond\b/.test(t)) return 2;
  return undefined;
}

/** Pull a care task out of the patient's sentence, e.g. "I need help with my medications". */
function extractNote(transcript: string): string | undefined {
  const m = transcript.match(
    /\b(?:remind (?:them|him|her)|i need|i'd like|help(?:ing)? (?:me )?with)\b([^.?!]*)/i,
  );
  if (!m?.[1]) return undefined;
  const tail = m[1].trim().replace(/^(that|to)\s+/i, '');
  if (tail.length < 4) return undefined;
  return `Patient request: ${tail}`;
}

/**
 * The backend appends the current patient turn before calling `respond()`, so the most
 * recent agent turn is the response to the preceding patient turn. Its fixed rationale is
 * not stored in `CareSession`; the fixed spoken prefix is therefore the durable marker.
 */
function previousAgentTurnWasUnrecognised(session: CareSession): boolean {
  const previousAgent = [...session.turns].reverse().find((turn) => turn.speaker === 'agent');
  return previousAgent?.text.startsWith("Sorry, I didn't catch that.") ?? false;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

function confirmTurn(session: CareSession, affirmative: boolean): AgentTurn {
  const pending = session.pendingAction;
  if (!pending) {
    return {
      say: "I don't have anything waiting for your approval right now.",
      state: session.state === 'awaiting_confirmation' ? 'awaiting_choice' : session.state,
      engine: 'scripted',
      rationale: 'Confirmation received with no pending action.',
    };
  }

  if (!affirmative) {
    return {
      say: `Okay, I won't ${pending.summary}. Nothing has been sent.`,
      state: 'cancelled',
      engine: 'scripted',
      rationale: 'Patient declined; no action taken.',
    };
  }

  return {
    say: `Okay. I'll ${pending.summary} now.`,
    state: 'acting',
    // The backend re-checks that this equals the confirmed action before anything executes.
    executeAction: pending,
    engine: 'scripted',
    rationale: 'Patient explicitly confirmed; executing the confirmed action.',
  };
}

function confirmQuestion(action: SensitiveAction): string {
  return `should I ${action.summary}?`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function caregiver(plan: CarePlan) {
  return plan.contacts.find((c) => c.role === 'caregiver' && c.notifiableOutsideVisits);
}

function trustedContact(plan: CarePlan) {
  // Patient-controlled notification permissions are an input to the catalogue, not a
  // check postponed until execution. Never offer a choice that the backend must refuse.
  return plan.contacts.find(
    (c) => c.role === 'trusted_contact' && c.notifiableOutsideVisits,
  );
}

function escalationAction(plan: CarePlan, why: string): SensitiveAction {
  const recipients = plan.contacts
    .filter(
      (c) =>
        (c.role === 'care_coordinator' || c.role === 'trusted_contact') &&
        c.notifiableOutsideVisits,
    )
    .map((c) => c.displayName)
    .join(' and ');
  return {
    type: 'escalate_care_team',
    message: `${why} No medical assessment was made.`,
    note: 'Emergency-assist prototype: patient-initiated request for help.',
    summary: `let ${recipients || 'your care team'} know you need help`,
  };
}

function choicesFor(session: CareSession, plan: CarePlan) {
  const trusted = trustedContact(plan);
  const care = session.match.contact?.notifiableOutsideVisits
    ? session.match.contact
    : caregiver(plan);

  if (session.match.status === 'scheduled' && care) {
    return [
      { actionId: 'ready_now', label: `Tell ${care.displayName} I'm ready` },
      { actionId: 'need_minutes', label: 'Ask for a few more minutes' },
      { actionId: 'do_nothing', label: 'Do nothing' },
    ];
  }

  return [
    { actionId: 'say_unavailable', label: "Say I'm unavailable" },
    ...(trusted ? [{ actionId: 'notify_trusted', label: `Contact ${trusted.displayName}` }] : []),
    { actionId: 'do_nothing', label: 'Do nothing' },
  ];
}
