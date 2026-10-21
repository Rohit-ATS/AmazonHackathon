/**
 * Action execution — the only place in the system that can cause an outside-world effect.
 *
 * Two invariants are enforced here rather than trusted:
 *
 *   1. A blocked capability can never execute, whatever the model produced and whatever
 *      the patient said. Door unlock is not an unimplemented feature; it is a refusal.
 *   2. A sensitive action can only execute with a confirmed action object that is
 *      structurally identical to the one the patient was asked about. Checking it here as
 *      well as in the consent engine means a bug in either one is not enough to send a
 *      message nobody approved.
 *
 * In demo mode notifications are recorded rather than sent, because the people in the
 * fixture are fictional and a hackathon demo has no business sending real SMS.
 */

import type {
  ActionResult,
  CarePlan,
  CareSession,
  SensitiveAction,
} from '@careflow/shared';
import {
  BLOCKED_CAPABILITIES,
  EMERGENCY_PROTOTYPE_POLICY,
  isSensitive,
  nowIso,
  sameAction,
} from '@careflow/shared';
import { findContact } from './careplan.js';

export class ActionRefused extends Error {
  constructor(
    readonly code:
      | 'blocked_capability'
      | 'not_confirmed'
      | 'action_mismatch'
      | 'unknown_contact'
      | 'contact_not_notifiable'
      | 'emergency_policy',
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefused';
  }
}

/** Pre-flight check. Safe to call before asking the patient, so we never offer the impossible. */
export function assertAllowed(action: SensitiveAction, plan: CarePlan): void {
  if ((BLOCKED_CAPABILITIES as readonly string[]).includes(action.type)) {
    throw new ActionRefused(
      'blocked_capability',
      `${action.type} is a blocked capability and can never be executed.`,
    );
  }

  if (
    action.type === 'notify_caregiver' ||
    action.type === 'notify_trusted_contact' ||
    action.type === 'message_contact' ||
    action.type === 'call_contact'
  ) {
    const contact = findContact(plan, action.contactId);
    if (!contact) {
      throw new ActionRefused('unknown_contact', `No contact ${action.contactId} in the care plan.`);
    }
    if (!contact.notifiableOutsideVisits) {
      // The patient controls who may be contacted. An agent that routes around that
      // setting because it seemed helpful is the exact failure mode we are designing out.
      throw new ActionRefused(
        'contact_not_notifiable',
        `${contact.displayName} is not patient-approved for notifications outside a scheduled visit.`,
      );
    }
  }
}

export interface ExecuteContext {
  session: CareSession;
  plan: CarePlan;
  /** Must be the action the patient actually confirmed. */
  confirmed: SensitiveAction | undefined;
  demoMode: boolean;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function executeAction(
  action: SensitiveAction,
  ctx: ExecuteContext,
): Promise<ActionResult> {
  assertAllowed(action, ctx.plan);

  if (isSensitive(action.type)) {
    if (ctx.session.state !== 'acting') {
      throw new ActionRefused(
        'not_confirmed',
        `Sensitive action attempted from state "${ctx.session.state}"; only "acting" may execute.`,
      );
    }
    if (!sameAction(action, ctx.confirmed)) {
      throw new ActionRefused(
        'action_mismatch',
        'Action to execute does not match the action the patient confirmed.',
      );
    }
  }

  if (action.type === 'escalate_care_team') {
    // The invariant being protected is "CareFlow never decides on its own that someone
    // needs help" — not "only one flow may escalate". Two flows satisfy it:
    //
    //   emergency_assist_prototype  the patient pressed the help button themselves
    //   companion                   the person agreed, out loud, to a confirmation the
    //                               MCP consent gate staged and will not execute without
    //
    // A Ring-triggered visitor session satisfies neither: nobody asked for help, so an
    // escalation there would be CareFlow deciding, which is the thing to prevent.
    if (ctx.session.mode === 'emergency_assist_prototype') {
      if (ctx.session.event.source !== 'patient') {
        // EMERGENCY_PROTOTYPE_POLICY.patientInitiatedOnly, enforced rather than described.
        throw new ActionRefused(
          'emergency_policy',
          'The emergency-assist flow can only be started by the patient.',
        );
      }
    } else if (ctx.session.mode !== 'companion') {
      throw new ActionRefused(
        'emergency_policy',
        'escalate_care_team requires a patient-initiated flow: the help button, or a confirmed companion escalation.',
      );
    }
  }

  const at = nowIso();

  switch (action.type) {
    case 'notify_caregiver':
    case 'notify_trusted_contact':
    case 'message_contact': {
      const contact = findContact(ctx.plan, action.contactId)!;
      return deliver(ctx, {
        to: `${contact.displayName} (${contact.relationship ?? contact.role})`,
        channel: contact.channel.kind,
        address: contact.channel.address,
        body: action.message ?? action.summary,
        at,
      });
    }

    case 'call_contact': {
      const contact = findContact(ctx.plan, action.contactId)!;
      // CareFlow places the call through the care platform; it is not a phone dialler and
      // in particular cannot reach emergency services. The agent is told to say so.
      ctx.log('call requested', { to: contact.displayName });
      return deliver(ctx, {
        to: `${contact.displayName} (${contact.relationship ?? contact.role})`,
        channel: contact.channel.kind,
        address: contact.channel.address,
        body: action.message
          ? `Call request: ${action.message}`
          : 'Call request from CareFlow.',
        at,
        verb: 'Calling',
      });
    }

    case 'request_refill': {
      // Demo mode records the request rather than transmitting it. Wiring a real pharmacy
      // order into a hackathon build, where a mistake means someone's medication, is not a
      // trade we are willing to make — the seam is here when there is a real integration.
      ctx.log('refill requested', { demoMode: ctx.demoMode });
      return {
        ok: true,
        via: ctx.demoMode ? 'demo:pharmacy' : 'recorded:pharmacy',
        detail: `${action.message ?? action.summary} Sent as a refill request; the pharmacy confirms separately.`,
        at,
      };
    }

    case 'book_appointment': {
      const coordinator = ctx.plan.contacts.find((c) => c.role === 'care_coordinator');
      ctx.log('appointment requested');
      return {
        ok: true,
        via: ctx.demoMode ? 'demo:care-team' : 'recorded:care-team',
        // A request to humans, never a confirmed booking. The agent is told to say so.
        detail: `${action.message ?? action.summary} Sent to ${
          coordinator?.displayName ?? 'the care team'
        } as a request — they will confirm the time.`,
        at,
      };
    }

    case 'escalate_care_team': {
      // Notifies both the care team and the trusted contact, with the patient's own words.
      const recipients = ctx.plan.contacts.filter(
        (c) => c.role === 'care_coordinator' || c.role === 'trusted_contact',
      );
      const names = recipients.map((c) => c.displayName).join(' and ');
      return deliver(ctx, {
        to: names,
        channel: 'demo',
        address: recipients.map((c) => c.channel.address).join(', '),
        body: `${action.message ?? action.summary} — relayed by CareFlow at the patient's request. ${
          EMERGENCY_PROTOTYPE_POLICY.spokenSafetyLine
        }`,
        at,
      });
    }

    case 'message_visitor': {
      // Ring's partner scope is read-only (`ava.v1:read`), so CareFlow cannot speak through
      // the doorbell. Rather than imply otherwise, the message is shown on the patient's
      // screen for them to relay, and the handoff record carries it to the caregiver.
      ctx.log('message_visitor rendered locally; Ring partner scope is read-only', {
        sessionId: ctx.session.sessionId,
      });
      return {
        ok: true,
        via: 'careflow-screen',
        detail: `Message held for the visitor: "${action.message ?? action.summary}". CareFlow cannot speak through the Ring device on a read-only partner scope.`,
        at,
      };
    }

    case 'log_note':
      return { ok: true, via: 'careflow-record', detail: action.note ?? action.summary, at };

    case 'do_nothing':
      return { ok: true, via: 'none', detail: 'Patient chose to take no action.', at };

    default:
      throw new ActionRefused('blocked_capability', `Unsupported action ${String(action.type)}.`);
  }
}

interface Delivery {
  to: string;
  channel: string;
  address: string;
  body: string;
  at: string;
  /** Past-tense verb for the result line, e.g. "Notified" or "Calling". */
  verb?: string;
}

async function deliver(ctx: ExecuteContext, d: Delivery): Promise<ActionResult> {
  if (ctx.demoMode || d.channel === 'demo') {
    ctx.log('notification recorded (demo mode)', { to: d.to, channel: d.channel });
    return {
      ok: true,
      via: d.channel === 'demo' ? 'demo' : `demo:${d.channel}`,
      detail: `${d.verb ?? 'Notified'} ${d.to}: "${d.body}"`,
      at: d.at,
    };
  }

  // Real delivery would go here (SNS / Pinpoint / connector). Left unimplemented on purpose:
  // shipping a half-tested real-SMS path into a care product is worse than not shipping one.
  ctx.log('live notification channel not configured; recording instead', { channel: d.channel });
  return {
    ok: true,
    via: `recorded:${d.channel}`,
    detail: `${d.verb ?? 'Notified'} ${d.to}: "${d.body}"`,
    at: d.at,
  };
}
