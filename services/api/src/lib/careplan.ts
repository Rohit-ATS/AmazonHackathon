/**
 * Care-plan loading.
 *
 * Visit windows live in the fixture as local times of day and are materialized onto the
 * current date at load. That means the demo works on any day without anybody editing
 * timestamps — which matters when the video gets re-recorded the night before submission.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type {
  Appointment,
  CarePlan,
  Contact,
  Medication,
  Patient,
  ScheduledVisit,
  SupportResource,
} from '@careflow/shared';

interface VisitTemplate {
  visitId: string;
  contactId: string;
  /** "HH:MM" local time. */
  startTime: string;
  endTime: string;
  purpose: string;
  deviceId: string;
  status: ScheduledVisit['status'];
  /**
   * Demo anchoring: minutes relative to "now" that this visit window occupies when
   * CAREFLOW_DEMO_ANCHOR is on. Without it, a demo recorded at 11pm shows a doorbell press
   * at 2:10pm next to an AI decision at 11:33pm, which reads as a bug rather than a story.
   * With it, the scheduled-visit scenario is always genuinely happening right now.
   */
  demoOffsetMinutes?: [number, number];
}

interface AppointmentTemplate extends Omit<Appointment, 'startsAt'> {
  /** Relative form: "+2d 10:30", so the demo works on any day. */
  startsAt: string;
}

interface CarePlanFixture {
  patient: Patient;
  contacts: Contact[];
  devices: CarePlan['devices'];
  visitTemplates: VisitTemplate[];
  medications: Medication[];
  appointments: AppointmentTemplate[];
  supportResources: SupportResource[];
}

/** Resolve "+2d 10:30" against now. Anything already ISO is passed straight through. */
function resolveRelative(value: string, now: Date): string {
  const match = value.match(/^\+(\d+)d\s+(\d{1,2}):(\d{2})$/);
  if (!match) return new Date(value).toISOString();
  const d = new Date(now);
  d.setDate(d.getDate() + Number(match[1]));
  d.setHours(Number(match[2]), Number(match[3]), 0, 0);
  return d.toISOString();
}

function atTimeToday(hhmm: string, base: Date): string {
  const parts = hhmm.split(':');
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/** Resolve the fixture path from this module, so cwd does not matter. */
function fixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../fixtures/care-plan.json');
}

function shift(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** Demo anchoring is on unless explicitly disabled, so a fresh clone demos well. */
function anchoringEnabled(): boolean {
  return process.env.CAREFLOW_DEMO_ANCHOR !== 'false';
}

let cached: CarePlan | undefined;
let cachedDay: string | undefined;

export async function loadCarePlan(now = new Date()): Promise<CarePlan> {
  // Anchored plans are relative to the current minute, so they are cached per minute
  // rather than per day; fixed-time plans only need re-materializing after midnight.
  const day = anchoringEnabled() ? now.toISOString().slice(0, 16) : now.toISOString().slice(0, 10);
  if (cached && cachedDay === day) return cached;

  const raw = await readFile(process.env.CAREFLOW_CARE_PLAN ?? fixturePath(), 'utf8');
  const fixture = JSON.parse(raw) as CarePlanFixture;

  const anchor = anchoringEnabled();
  const visits: ScheduledVisit[] = fixture.visitTemplates.map((t) => {
    const useOffset = anchor && t.demoOffsetMinutes;
    return {
      visitId: t.visitId,
      contactId: t.contactId,
      startsAt: useOffset ? shift(now, t.demoOffsetMinutes![0]) : atTimeToday(t.startTime, now),
      endsAt: useOffset ? shift(now, t.demoOffsetMinutes![1]) : atTimeToday(t.endTime, now),
      purpose: t.purpose,
      deviceId: t.deviceId,
      status: t.status,
    };
  });

  cached = {
    patient: fixture.patient,
    contacts: fixture.contacts,
    devices: fixture.devices,
    visits,
    medications: fixture.medications ?? [],
    appointments: (fixture.appointments ?? []).map((a) => ({
      ...a,
      startsAt: resolveRelative(a.startsAt, now),
    })),
    supportResources: fixture.supportResources ?? [],
  };
  cachedDay = day;
  return cached;
}

export function findContact(plan: CarePlan, contactId: string | undefined): Contact | undefined {
  if (!contactId) return undefined;
  return plan.contacts.find((c) => c.contactId === contactId);
}

export function contactByRole(plan: CarePlan, role: Contact['role']): Contact | undefined {
  return plan.contacts.find((c) => c.role === role);
}
