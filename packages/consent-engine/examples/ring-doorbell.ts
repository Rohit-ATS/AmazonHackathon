/**
 * Worked example: gating an agent's actions on a real Ring doorbell event.
 *
 *   npx tsx examples/ring-doorbell.ts
 *
 * The event here is a genuine Ring Partner API webhook v1.1 payload (from
 * fixtures/ring-events/), not a sketch. The point of the example is the shape of the
 * control flow: the agent decides what to *say*, and the machine decides what may *happen*.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ConsentStateError,
  createConsentMachine,
  type ActionDescriptor,
} from '../src/index.js';

// --- the event ------------------------------------------------------------

interface RingWebhook {
  meta: { request_id: string; time: string };
  data: { id: string; type: string; attributes: { source: string; sub_type?: string } };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const event = JSON.parse(
  readFileSync(path.resolve(here, '../../../fixtures/ring-events/button-press.json'), 'utf8'),
) as RingWebhook;

// --- the machine ----------------------------------------------------------

const machine = createConsentMachine({
  // Capabilities this agent must never have, whatever a user asks for and whatever a model
  // proposes. Declared refusals, not unimplemented features.
  blockedActions: ['unlock_door', 'disarm_alarm', 'medical_advice', 'emergency_dispatch'],
  confirmationTtlMs: 60_000,
  actor: `ring:${event.data.attributes.source}`,
});

machine.observe({
  id: event.data.id,
  kind: event.data.type,
  detail: { deviceId: event.data.attributes.source, requestId: event.meta.request_id },
});

// --- what the agent offers ------------------------------------------------

const notifyDaughter: ActionDescriptor = {
  id: 'notify_trusted_contact',
  label: 'Contact Maya',
  sensitive: true,
  payload: { contactId: 'con_maya', message: 'Someone is at the front door.' },
};

machine.offer([
  notifyDaughter,
  { id: 'message_visitor', label: "Say I'm unavailable", sensitive: true },
  { id: 'do_nothing', label: 'Do nothing', sensitive: false },
  // Offered by a confused agent, and silently dropped by the machine with a logged reason.
  { id: 'unlock_door', label: 'Let them in', sensitive: true },
]);

console.log('offered:', machine.options.map((o) => o.id).join(', '));

// --- the user chooses -----------------------------------------------------

machine.choose(notifyDaughter.id);
console.log('state after choose:', machine.state); // awaiting_confirmation
console.log('pending:', machine.pendingAction?.label);

// A model that decides to act now, without waiting for the answer, gets nothing:
try {
  machine.assertExecutable(notifyDaughter);
} catch (err) {
  console.log('blocked early execution:', (err as ConsentStateError).message);
}

// --- the user confirms ----------------------------------------------------

machine.confirm(true);
console.log('state after confirm:', machine.state); // acting

// Swapping the message after approval is the subtle version of acting without consent,
// so the machine compares the whole action and not just its id.
try {
  machine.assertExecutable({
    ...notifyDaughter,
    payload: { contactId: 'con_maya', message: 'Come in, the door is open.' },
  });
} catch (err) {
  console.log('blocked substitution:', (err as ConsentStateError).message);
}

// --- the side effect ------------------------------------------------------

const approved = machine.confirmedAction!;
machine.assertExecutable(approved); // the last line of defence, and the cheapest
console.log('executing:', approved.label, JSON.stringify(approved.payload));
machine.complete({ ok: true, detail: 'Notified Maya' });

// A retried request or a double-tap cannot send a second time.
machine.confirm(true);

// --- the audit trail ------------------------------------------------------

console.log('\naudit trail');
for (const entry of machine.history()) {
  const why = entry.reason ? ` — ${entry.reason}` : '';
  console.log(
    `  ${String(entry.seq).padStart(2)} ${entry.type.padEnd(22)} ${entry.from} -> ${entry.to}` +
      `${entry.actionId ? ` (${entry.actionId})` : ''}${why}`,
  );
}
