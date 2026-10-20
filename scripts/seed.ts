/**
 * Validate and print the demo care plan.
 *
 *   npm run seed
 *
 * There is nothing to seed in local mode — the plan is materialized from the fixture on
 * every load — so this script's job is to catch a broken fixture before a demo rather than
 * during one. It fails loudly on the mistakes that are easy to make by hand: a visit
 * pointing at a contact or device that does not exist, or a plan with real-looking contact
 * details in it.
 */

import { loadCarePlan } from '../services/api/src/lib/careplan.js';

const plan = await loadCarePlan();
const problems: string[] = [];

const contactIds = new Set(plan.contacts.map((c) => c.contactId));
const deviceIds = new Set(plan.devices.map((d) => d.deviceId));

for (const visit of plan.visits) {
  if (!contactIds.has(visit.contactId)) {
    problems.push(`visit ${visit.visitId} references unknown contact ${visit.contactId}`);
  }
  if (!deviceIds.has(visit.deviceId)) {
    problems.push(`visit ${visit.visitId} references unknown device ${visit.deviceId}`);
  }
  if (new Date(visit.endsAt) <= new Date(visit.startsAt)) {
    problems.push(`visit ${visit.visitId} ends before it starts`);
  }
}

// No real patient data is a submission requirement, so check rather than trust. Fictional
// addresses should be .invalid, example.com, or a 555 number.
for (const contact of plan.contacts) {
  const address = contact.channel.address;
  const looksFictional =
    /\.invalid$/.test(address) ||
    /@example\.(com|org|net)$/.test(address) ||
    /555-?01\d\d/.test(address);
  if (!looksFictional) {
    problems.push(
      `contact ${contact.contactId} has a contact address that does not look fictional: ${address}`,
    );
  }
}

if (!plan.contacts.some((c) => c.role === 'caregiver')) problems.push('no caregiver in the plan');
if (!plan.contacts.some((c) => c.role === 'trusted_contact')) {
  problems.push('no trusted contact in the plan');
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

console.log(`\nPatient: ${plan.patient.displayName}`);
if (plan.patient.careContext) console.log(`Context: ${plan.patient.careContext.situation}`);

console.log('\nVisits today:');
for (const visit of plan.visits) {
  const contact = plan.contacts.find((c) => c.contactId === visit.contactId);
  console.log(
    `  ${fmt(visit.startsAt)}–${fmt(visit.endsAt)}  ${contact?.displayName ?? visit.contactId}` +
      `  (${visit.status})  ${visit.purpose}`,
  );
}

console.log('\nContacts:');
for (const contact of plan.contacts) {
  console.log(
    `  ${contact.displayName} — ${contact.role}` +
      `${contact.notifiableOutsideVisits ? '' : ' (not approved for notifications)'}`,
  );
}

console.log('\nDevices:');
for (const device of plan.devices) console.log(`  ${device.deviceId}  ${device.displayName}`);

if (problems.length > 0) {
  console.error('\nProblems found in the care plan:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nCare plan is valid.\n');
