/**
 * Call the Ring Partner API with a linked account.
 *
 *   npm run ring:devices
 *
 * Lists devices and recent event history. This is the script that demonstrates CareFlow
 * genuinely calling Ring's API (`GET /v1/devices`, `GET /v1/history/devices/{id}/events`)
 * rather than only consuming simulated webhooks — worth showing on camera next to the
 * simulator, since together they cover both halves of the integration.
 *
 * Run `npm run ring:link` first.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { RingApiError, RingClient, type RingTokens } from '@careflow/ring';

const clientId = process.env.RING_CLIENT_ID;
const clientSecret = process.env.RING_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set RING_CLIENT_ID and RING_CLIENT_SECRET (see .env.example).');
  process.exit(1);
}

const TOKEN_PATH = '.ring-tokens.json';

const client = new RingClient({
  credentials: {
    clientId,
    clientSecret,
    redirectUri: process.env.RING_REDIRECT_URI ?? 'http://localhost:8788/ring/oauth/callback',
  },
  loadTokens: async () => {
    try {
      return JSON.parse(await readFile(TOKEN_PATH, 'utf8')) as RingTokens;
    } catch {
      return undefined;
    }
  },
  // Rotated refresh tokens must be persisted or the link expires silently.
  saveTokens: async (tokens) => {
    await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    console.log('(refreshed and saved tokens)');
  },
});

if (!(await client.isLinked())) {
  console.error(`No usable tokens in ${TOKEN_PATH}. Run: npm run ring:link`);
  process.exit(1);
}

try {
  const me = await client.getMe();
  console.log('\nGET /v1/users/me');
  console.log(JSON.stringify(me, null, 2));

  const devices = await client.listDevices();
  console.log(`\nGET /v1/devices — ${devices.data.length} device(s)`);
  for (const device of devices.data) {
    console.log(`  ${device.id}  ${device.name ?? '(unnamed)'}  ${device.kind ?? ''}`);
  }

  const first = devices.data[0];
  if (first) {
    const history = await client.getDeviceHistory(first.id, { limit: 5 });
    console.log(`\nGET /v1/history/devices/${first.id}/events — ${history.data.length} event(s)`);
    for (const event of history.data) {
      console.log(`  ${event.created_at ?? '?'}  ${event.type}  ${event.id}`);
    }
    console.log(
      '\nTo put a real Ring event through CareFlow, point your app\'s webhook URL at ' +
        '/ring/webhook in the Developer Portal. Note that Ring only delivers webhooks for ' +
        'devices on an active Ring Protect plan in the US, which is why the simulator exists.',
    );
  }
} catch (err) {
  if (err instanceof RingApiError) {
    console.error(`\nRing API error ${err.status}: ${err.message}`);
    if (err.retryAfterSeconds) console.error(`Retry after ${err.retryAfterSeconds}s.`);
    console.error(err.body.slice(0, 500));
    process.exit(1);
  }
  throw err;
}
