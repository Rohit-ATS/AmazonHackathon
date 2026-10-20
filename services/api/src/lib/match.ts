/**
 * Scheduled-visit matching.
 *
 * Deliberately deterministic and explainable: this decides whether the house tells the
 * patient "your nurse is here" or "I don't recognise this visit", and a model that
 * occasionally hallucinates a scheduled visit would be worse than no feature at all.
 * Bedrock gets to phrase the result; it does not get to decide it.
 *
 * Every match returns a `reason` string that the UI renders verbatim, so a judge can see
 * exactly why the system concluded what it did.
 */

import type { CareEvent, CarePlan, ScheduledVisit, VisitMatch } from '@careflow/shared';
import { findContact } from './careplan.js';

/**
 * How early a caregiver can turn up and still count as "on time". Real visits drift, and
 * an arrival ten minutes early is normal, not suspicious.
 */
export const EARLY_GRACE_MINUTES = 15;
/** How late an arrival still matches its window. */
export const LATE_GRACE_MINUTES = 20;

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60000);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function matchVisit(event: CareEvent, plan: CarePlan): VisitMatch {
  if (event.kind === 'patient_request') {
    return {
      status: 'not_applicable',
      confidence: 1,
      minutesFromWindow: 0,
      reason: 'Patient started this conversation; no visitor event to match.',
    };
  }

  if (event.kind !== 'doorbell' && event.kind !== 'motion') {
    return {
      status: 'not_applicable',
      confidence: 1,
      minutesFromWindow: 0,
      reason: `${event.ringType} is a device event, not a visitor event.`,
    };
  }

  const sameDevice = plan.visits.filter((v) => v.deviceId === event.deviceId);
  const candidates = sameDevice
    .map((visit) => ({ visit, offset: offsetFromWindow(event.occurredAt, visit) }))
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));

  const best = candidates[0];

  if (best && best.offset === 0) {
    const contact = findContact(plan, best.visit.contactId);
    const match: VisitMatch = {
      status: 'scheduled',
      visit: best.visit,
      confidence: 0.95,
      minutesFromWindow: 0,
      reason: `Inside the ${formatTime(best.visit.startsAt)}–${formatTime(
        best.visit.endsAt,
      )} window for ${contact?.displayName ?? 'a scheduled visit'}.`,
    };
    if (contact) match.contact = contact;
    return match;
  }

  if (best && withinGrace(best.offset)) {
    const contact = findContact(plan, best.visit.contactId);
    const early = best.offset < 0;
    const mins = Math.abs(best.offset);
    const match: VisitMatch = {
      status: 'scheduled',
      visit: best.visit,
      // Lower confidence outside the window, and the agent phrases it more tentatively
      // ("appears to be") rather than asserting who is at the door.
      confidence: early ? 0.8 : 0.75,
      minutesFromWindow: best.offset,
      reason: `${mins} minute${mins === 1 ? '' : 's'} ${
        early ? 'before' : 'after'
      } the ${formatTime(best.visit.startsAt)} visit window for ${
        contact?.displayName ?? 'a scheduled visit'
      }.`,
    };
    if (contact) match.contact = contact;
    return match;
  }

  // Unscheduled. Report the nearest upcoming visit so the agent can be useful rather than
  // just alarming: "nobody is expected until four o'clock" is actionable information.
  const upcoming = sameDevice
    .filter((v) => new Date(v.startsAt).getTime() > new Date(event.occurredAt).getTime())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];

  const offsetText = best
    ? `nearest scheduled visit is ${Math.abs(best.offset)} minutes away`
    : 'no visits scheduled on this device today';

  const match: VisitMatch = {
    status: 'unscheduled',
    confidence: best ? 0.9 : 0.98,
    minutesFromWindow: best?.offset ?? 0,
    reason: `No visit window covers ${formatTime(event.occurredAt)} — ${offsetText}.`,
  };
  if (upcoming) match.nearestVisit = upcoming;
  return match;
}

/** 0 when inside the window, negative when early, positive when late. */
function offsetFromWindow(at: string, visit: ScheduledVisit): number {
  const beforeStart = minutesBetween(at, visit.startsAt);
  const afterEnd = minutesBetween(at, visit.endsAt);
  if (beforeStart >= 0 && afterEnd <= 0) return 0;
  return beforeStart < 0 ? beforeStart : afterEnd;
}

function withinGrace(offset: number): boolean {
  return offset < 0 ? offset >= -EARLY_GRACE_MINUTES : offset <= LATE_GRACE_MINUTES;
}
