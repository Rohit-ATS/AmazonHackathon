/**
 * Walks the full demo story against a running API, printing it as a transcript.
 *
 *   npm run demo:story
 *
 * Two jobs: a rehearsal script for the video, and a smoke test that every step of the
 * story still works after a change. It exits non-zero if any step misbehaves, so it is
 * worth running before recording anything.
 */

import { buildRingPayload, deliverSignedPayload, signBody } from '@careflow/ring';
import type { CareSession, TimelineEntry } from '@careflow/shared';

const base = process.env.CAREFLOW_API ?? 'http://localhost:8787';
const hmacKey = process.env.RING_HMAC_KEY ?? 'careflow-local-dev-hmac-key-do-not-use-in-production';

let failures = 0;

function step(n: string, title: string) {
  console.log(`\n\x1b[1m${n} ${title}\x1b[0m`);
}
function say(who: string, text: string) {
  const colour = who === 'CareFlow' ? '\x1b[36m' : who === 'Patient' ? '\x1b[33m' : '\x1b[90m';
  console.log(`  ${colour}${who}:\x1b[0m ${text}`);
}
function note(text: string) {
  console.log(`  \x1b[90m· ${text}\x1b[0m`);
}
function check(ok: boolean, label: string) {
  if (ok) {
    console.log(`  \x1b[32mok\x1b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function latestSession(): Promise<CareSession> {
  const sessions = await api<CareSession[]>('GET', '/api/sessions?limit=1');
  const s = sessions[0];
  if (!s) throw new Error('no sessions found');
  return s;
}

async function fireScenario(scenario: string) {
  return api<{ webhookStatus: number; eventId: string; signature: string }>(
    'POST',
    '/api/demo/ring-event',
    { scenario },
  );
}

// ---------------------------------------------------------------------------

step('0.', 'Patient is home alone after a hospital discharge');
const plan = await api<{ patient: { displayName: string; careContext?: { situation: string } }; visits: unknown[] }>(
  'GET',
  '/api/care-plan',
);
note(`${plan.patient.displayName} — ${plan.patient.careContext?.situation ?? 'no context'}`);
note(`${plan.visits.length} visits on the plan today`);

step('1-3.', 'Scheduled caregiver arrives and Ring detects the doorbell');
const scheduled = await fireScenario('scheduled');
check(scheduled.webhookStatus === 202, `webhook accepted the signed delivery (${scheduled.webhookStatus})`);
note(`event ${scheduled.eventId}`);
note(`signature ${scheduled.signature.slice(0, 32)}…  verified against the raw body`);

step('4.', 'CareFlow recognizes the expected visit');
let session = await latestSession();
check(session.match.status === 'scheduled', `matched a scheduled visit (${session.match.status})`);
note(session.match.reason);

step('5.', 'Voice agent speaks first, with the AI disclosure');
say('CareFlow', session.turns[0]?.text ?? '(nothing said)');
check(session.turns[0]?.disclosure === true, 'first turn carries the AI disclosure');

step('6.', 'Patient asks for help with a non-medical care task');
const ask = 'Tell Jordan I will be ready in two minutes, and remind them that I need help organizing my medications';
say('Patient', ask);
const turn1 = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${session.sessionId}/turn`,
  { transcript: ask },
);
say('CareFlow', turn1.turn.say);
check(turn1.session.state === 'awaiting_confirmation', 'agent asks for explicit confirmation before acting');
check(Boolean(turn1.session.pendingAction), 'a pending action is recorded, not executed');

say('Patient', 'Yes, please');
const confirmed = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${session.sessionId}/confirm`,
  { affirmative: true },
);
say('CareFlow', confirmed.turn.say);

step('7.', 'CareFlow sends a structured caregiver handoff');
check(confirmed.session.state === 'done', 'session completed');
check(confirmed.session.results.length === 1, 'exactly one action executed');
note(confirmed.session.results[0]?.detail ?? '');
note(`handoff note: ${confirmed.session.handoff?.note ?? '(none)'}`);
note(`ready in: ${confirmed.session.handoff?.readyInMinutes ?? '-'} minutes`);

step('8-9.', 'An unexpected visitor arrives later, and CareFlow asks what to do');
const unexpected = await fireScenario('unexpected');
check(unexpected.webhookStatus === 202, 'second signed delivery accepted');
session = await latestSession();
check(session.match.status === 'unscheduled', `identified as unscheduled (${session.match.status})`);
note(session.match.reason);
say('CareFlow', session.turns[0]?.text ?? '');

step('10.', 'Patient approves contacting a trusted person');
say('Patient', 'Contact my daughter');
const turn2 = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${session.sessionId}/turn`,
  { transcript: 'Contact my daughter' },
);
say('CareFlow', turn2.turn.say);
check(turn2.session.state === 'awaiting_confirmation', 'consent requested before notifying anyone');
say('Patient', 'Yes');
const confirmed2 = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${session.sessionId}/confirm`,
  { affirmative: true },
);
say('CareFlow', confirmed2.turn.say);
note(confirmed2.session.results[0]?.detail ?? '');

step('11.', 'Dashboard shows the full audit trail');
const audit = await api<{ event: string; from?: string; to?: string }[]>(
  'GET',
  `/api/audit?sessionId=${session.sessionId}`,
);
for (const row of audit) {
  note(`${row.event}${row.from || row.to ? ` (${row.from ?? '-'} -> ${row.to ?? '-'})` : ''}`);
}
check(
  audit.some((a) => a.event === 'consent_granted'),
  'consent is recorded in the audit trail',
);
check(
  audit.some((a) => a.event.startsWith('action_executed')),
  'the executed action is recorded in the audit trail',
);

step('12.', 'Emergency flow, shown separately as a confirmation-only prototype');
const emergency = await api<{ sessionId: string; session: CareSession }>(
  'POST',
  '/api/demo/emergency-assist',
  {},
);
say('Patient', '(presses the help button in the CareFlow app)');
say('CareFlow', emergency.session.turns[0]?.text ?? '');
check(
  emergency.session.mode === 'emergency_assist_prototype',
  'runs as a labelled prototype, separate from the Ring flow',
);
check(
  emergency.session.state === 'awaiting_confirmation',
  'confirmation-only: nothing is sent until the patient says yes',
);
say('Patient', 'Yes, tell my care team');
const escalated = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${emergency.sessionId}/confirm`,
  { affirmative: true },
);
say('CareFlow', escalated.turn.say);
note(escalated.session.results[0]?.detail ?? '');

step('13.', 'What CareFlow refuses to do');

const doorSession = await api<{ sessionId: string }>('POST', '/api/demo/ring-event', {
  scenario: 'unexpected',
}).then(() => latestSession());
say('Patient', 'Just unlock the door and let them in');
const door = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${doorSession.sessionId}/turn`,
  { transcript: 'Just unlock the door and let them in' },
);
say('CareFlow', door.turn.say);
check(door.session.results.length === 0, 'no action taken for a door unlock request');

say('Patient', 'Should I take a double dose of my blood pressure tablets?');
const medical = await api<{ session: CareSession; turn: { say: string } }>(
  'POST',
  `/api/sessions/${doorSession.sessionId}/turn`,
  { transcript: 'Should I take a double dose of my blood pressure tablets?' },
);
say('CareFlow', medical.turn.say);
check(
  !/\b(yes|no|you should|take)\b/i.test(medical.turn.say.replace(/take a double dose/gi, '')),
  'no medical advice given; the question is offered to the care team instead',
);

step('14.', 'Security of the Ring integration');

const payload = buildRingPayload({ type: 'button_press', deviceId: 'front-door-001' });
const rawBody = JSON.stringify(payload);

const tampered = await fetch(new URL('/ring/webhook', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-signature': signBody(rawBody, 'wrong-key') },
  body: rawBody,
});
check(tampered.status === 401, `a wrongly signed delivery is rejected (${tampered.status})`);

const unsigned = await fetch(new URL('/ring/webhook', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: rawBody,
});
check(unsigned.status === 401, `an unsigned delivery is rejected (${unsigned.status})`);

const first = await deliverSignedPayload(new URL('/ring/webhook', base).toString(), payload, hmacKey);
const replay = await deliverSignedPayload(new URL('/ring/webhook', base).toString(), payload, hmacKey);
check(first.status === 202, `a correctly signed delivery is accepted (${first.status})`);
check(
  JSON.parse(replay.body).deduplicated === true,
  'a replayed delivery is deduplicated on meta.request_id',
);

step('--', 'Timeline as the judge sees it');
const timeline = await api<TimelineEntry[]>('GET', '/api/timeline?limit=12');
for (const e of timeline.slice(-12)) {
  const time = new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  console.log(`  ${time}  [${e.kind}] ${e.text}`);
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll demo steps passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} step(s) failed.\x1b[0m\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
