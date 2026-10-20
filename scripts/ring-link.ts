/**
 * Link a Ring account to CareFlow (OAuth 2.0 with PKCE).
 *
 *   npm run ring:link
 *
 * Prints the authorize URL, waits on a loopback redirect for the code, exchanges it for
 * tokens, and stores them in .ring-tokens.json (gitignored).
 *
 * Needs RING_CLIENT_ID and RING_CLIENT_SECRET from the Amazon Developer Portal. Staging
 * credentials are fine, and staging allows up to ten linked users.
 *
 * Note: the partner-initiated flow grants `ava.v1:read`, so a linked account gives CareFlow
 * read access to devices and event history and nothing more. CareFlow could not unlock a
 * door even if it wanted to, which is a design feature rather than a limitation to route
 * around.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForTokens,
  type RingCredentials,
} from '@careflow/ring';

const clientId = process.env.RING_CLIENT_ID;
const clientSecret = process.env.RING_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'Set RING_CLIENT_ID and RING_CLIENT_SECRET first (see .env.example).\n' +
      'Get them from the Amazon Developer Portal -> Ring -> your app.',
  );
  process.exit(1);
}

const port = Number(process.env.RING_LINK_PORT ?? 8788);
const redirectUri = process.env.RING_REDIRECT_URI ?? `http://localhost:${port}/ring/oauth/callback`;

const credentials: RingCredentials = { clientId, clientSecret, redirectUri };
const pkce = createPkcePair();
const state = randomBytes(16).toString('hex');

const authorizeUrl = buildAuthorizeUrl(credentials, pkce, state);

console.log('\nOpen this URL, sign in with Ring, and authorize CareFlow:\n');
console.log(authorizeUrl);
console.log(`\nWaiting for the redirect on ${redirectUri} …\n`);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (!url.pathname.endsWith('/callback')) {
      res.writeHead(404).end();
      return;
    }

    const returnedState = url.searchParams.get('state');
    const returnedCode = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    // Checking state is what stops an attacker handing us a code for their account.
    if (returnedState !== state) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('State mismatch. Try again.');
      server.close();
      reject(new Error('state_mismatch'));
      return;
    }
    if (error || !returnedCode) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end(`Authorization failed: ${error}`);
      server.close();
      reject(new Error(error ?? 'missing_code'));
      return;
    }

    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<h1>CareFlow is linked.</h1><p>You can close this tab.</p>');
    server.close();
    resolve(returnedCode);
  });

  server.listen(port);
  setTimeout(() => {
    server.close();
    reject(new Error('timed_out_waiting_for_redirect'));
  }, 5 * 60_000).unref();
});

const tokens = await exchangeCodeForTokens(credentials, code, pkce.verifier);

// Refresh tokens rotate on every refresh, so whatever stores them has to be writable and
// has to be written on each refresh or the link silently dies about 30 days later.
await writeFile('.ring-tokens.json', JSON.stringify(tokens, null, 2), 'utf8');

console.log('Linked. Tokens written to .ring-tokens.json (gitignored).');
console.log(`Access token expires ${new Date(tokens.expiresAt).toLocaleString()}.`);
console.log('\nNext: npm run ring:devices');
