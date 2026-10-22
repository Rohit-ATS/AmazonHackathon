/**
 * Fire a simulated Ring event at a running CareFlow API.
 *
 *   npm run demo:scheduled
 *   npm run demo:unexpected
 *   npm run demo:delivery
 *
 * Signs the payload locally and POSTs it to /ring/webhook, so this exercises the real
 * verification path. Useful on camera: the signature and the signed bytes are printed, and
 * a judge can see that the endpoint is checking them rather than trusting us.
 */

import { buildScenario, deliverSignedPayload, type SimulatedScenario } from '@careflow/ring';

const scenario = (process.argv[2] ?? 'scheduled') as SimulatedScenario;
const base = process.env.CAREFLOW_API ?? 'http://127.0.0.1:8787';
const hmacKey = process.env.RING_HMAC_KEY ?? 'careflow-local-dev-hmac-key-do-not-use-in-production';
const deviceId = process.env.CAREFLOW_DEVICE_ID ?? 'front-door-001';

/**
 * Offsets from now, matching the demo-anchored visit windows: the scheduled press lands
 * inside the current nursing window, the unexpected one lands 45 minutes out — past the
 * window and past the 20-minute late grace, so it is unambiguously unscheduled without
 * being hours away from the wall clock. Keep in sync with SCENARIOS in services/api/src/app.ts.
 */
const OFFSET_MINUTES: Record<string, number> = { scheduled: 0, unexpected: 45, delivery: -35 };

function timeFor(s: SimulatedScenario): Date {
  return new Date(Date.now() + (OFFSET_MINUTES[s] ?? 0) * 60_000);
}

const payload = buildScenario(scenario, deviceId, timeFor(scenario));
const endpoint = new URL('/ring/webhook', base).toString();

console.log(`\nRing ${payload.data.type} -> ${endpoint}`);
console.log(JSON.stringify(payload, null, 2));

const result = await deliverSignedPayload(endpoint, payload, hmacKey);

console.log(`\nX-Signature: ${result.signature}`);
console.log(`HTTP ${result.status} in ${result.latencyMs}ms`);
console.log(result.body);

if (result.status >= 400) process.exitCode = 1;
