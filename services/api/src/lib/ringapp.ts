/**
 * The Ring Appstore app surface.
 *
 * A Ring partner app is not a bundle you upload — it is a registration in the Ring
 * Developer Console pointing at URLs you host. Four of them, and until now CareFlow only
 * implemented one:
 *
 *   Account Link URL   GET  /ring/link            a page Ring opens in the user's browser
 *                                                 to authenticate them and start linking
 *   Token Exchange URL POST /ring/token-exchange  Ring POSTs the authorization code here;
 *                                                 the backend swaps it for tokens
 *   Webhook URL        POST /ring/webhook         signed device events (already built)
 *   Default Redirect   GET  /ring/redirect        where the user lands after linking
 *
 * Implementing all four is what makes CareFlow registerable as a real Ring app rather than
 * a program that happens to parse Ring payloads. Public apps are listed in the Ring
 * Appstore after certification; private ones appear under "My Ring Apps" for connected
 * accounts, which is the route a hackathon project would take.
 *
 * Listing copy and the console field values live in `ring-app/listing.json`.
 */

import { randomBytes } from 'node:crypto';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForTokens,
  type RingCredentials,
} from '@careflow/ring';
import type { Config } from './config.js';
import type { Store } from './store.js';

/**
 * How long a half-finished link attempt stays valid.
 *
 * The PKCE verifier is useless to an attacker without the matching code, but a pending
 * link is still state we are holding on a user's behalf, so it expires quickly.
 */
export const LINK_TTL_MS = 10 * 60_000;

export function ringCredentials(config: Config): RingCredentials | undefined {
  if (!config.ringClientId || !config.ringClientSecret) return undefined;
  return {
    clientId: config.ringClientId,
    clientSecret: config.ringClientSecret,
    redirectUri: config.ringRedirectUri,
  };
}

/**
 * Begin account linking.
 *
 * Generates a PKCE pair and an unguessable `state`, stores them, and sends the browser to
 * Ring's authorize page. The `state` check on the way back is what stops someone handing
 * us an authorization code unrelated to an authenticated link attempt.
 */
export async function startAccountLink(
  config: Config,
  store: Store,
): Promise<{ authorizeUrl: string } | { error: string }> {
  const credentials = ringCredentials(config);
  if (!credentials) {
    return {
      error:
        'This CareFlow deployment has no Ring client credentials configured, so it cannot link a Ring account yet.',
    };
  }

  const pkce = createPkcePair();
  const state = randomBytes(24).toString('base64url');

  await store.savePendingLink(state, {
    verifier: pkce.verifier,
    createdAt: Date.now(),
    expiresAt: Date.now() + LINK_TTL_MS,
  });

  return { authorizeUrl: buildAuthorizeUrl(credentials, pkce, state) };
}

export type LinkCompletion =
  | { ok: true; linkedAt: string }
  | { ok: false; reason: string };

/**
 * Finish account linking from the redirect, or from Ring's token-exchange POST.
 *
 * Both paths end in the same place: a code plus a state, swapped for tokens that are then
 * persisted. Ring rotates the refresh token on every refresh, so whatever stores them has
 * to be written each time or the link dies silently about thirty days later.
 */
export async function completeAccountLink(
  config: Config,
  store: Store,
  params: { code?: string; state?: string; error?: string },
): Promise<LinkCompletion> {
  if (params.error) return { ok: false, reason: `Ring reported: ${params.error}` };
  if (!params.code || !params.state) {
    return { ok: false, reason: 'The link request was missing its code or state.' };
  }

  const credentials = ringCredentials(config);
  if (!credentials) return { ok: false, reason: 'No Ring client credentials configured.' };

  const pending = await store.takePendingLink(params.state);
  if (!pending) {
    // Either a replayed callback, an expired attempt, or a forged one. All three get the
    // same answer: start again.
    return { ok: false, reason: 'That link request is no longer valid. Please start again.' };
  }
  if (Date.now() > pending.expiresAt) {
    return { ok: false, reason: 'That link request expired. Please start again.' };
  }

  try {
    const tokens = await exchangeCodeForTokens(credentials, params.code, pending.verifier);
    await store.saveRingTokens(tokens);
    return { ok: true, linkedAt: new Date().toISOString() };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Token exchange failed.',
    };
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Ring opens these in the user's browser, so they are server-rendered HTML rather than
 * part of the React app — there is no guarantee the SPA has loaded, and an account-link
 * page that depends on a JavaScript bundle is a page that sometimes does not appear.
 *
 * Styled to match the app: same lime, same near-black, same type.
 */
export function linkPage(opts: {
  authError?: string;
  error?: string;
  appName: string;
}): string {
  const loginForm = `<form method="post" action="/ring/link">
         <label for="apiToken">CareFlow access token</label>
         <input id="apiToken" name="apiToken" type="password" autocomplete="current-password" required>
         <button class="btn" type="submit">Continue to Ring</button>
       </form>`;
  const body = opts.error
    ? `<p class="error">${escapeHtml(opts.error)}</p>
       <p class="muted">Ask whoever set up this CareFlow deployment to add the Ring client
       credentials, then try again.</p>`
    : `${opts.authError ? `<p class="error">${escapeHtml(opts.authError)}</p>` : ''}
       <p>CareFlow needs permission to see when someone is at your door, so it can tell you
         who is there and ask what you would like to do.</p>
       <ul>
         <li><strong>What it can do:</strong> see your devices and their events.</li>
         <li><strong>What it cannot do:</strong> unlock doors, disarm alarms, or view live
             video. Ring grants CareFlow read-only access, and CareFlow refuses those
             actions besides.</li>
       </ul>
       ${loginForm}
       <p class="muted small">You will be asked to sign in to Ring. CareFlow never sees your
          Ring password.</p>`;

  return shell(`Connect ${escapeHtml(opts.appName)} to Ring`, body);
}

export function linkResultPage(result: LinkCompletion, appUrl: string): string {
  const body = result.ok
    ? `<p class="ok">Your Ring account is connected.</p>
       <p>CareFlow will now tell you when someone is at your door, and ask what you would
          like to do about it. It will never contact anyone without asking you first.</p>
       <a class="btn" href="${escapeHtml(appUrl)}">Open CareFlow</a>`
    : `<p class="error">${escapeHtml(result.reason)}</p>
       <a class="btn" href="/ring/link">Try again</a>`;

  return shell(result.ok ? 'Connected to Ring' : 'Could not connect', body);
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · CareFlow</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    background: #f2f3ee; color: #0c0d0c;
    font: 500 17px/1.55 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 34rem; width: 100%; background: #fff; border-radius: 28px; padding: 2.2rem; }
  .mark { display:inline-flex; align-items:center; gap:.5rem; font-weight:800; letter-spacing:-.03em; }
  .dot { width:1.6em; height:1.6em; border-radius:50%; background:#d9f550; display:grid;
         place-items:center; font-size:.62rem; font-weight:800; }
  h1 { font-size: clamp(1.6rem, 1.2rem + 1.6vw, 2.3rem); letter-spacing:-.035em; margin:1.2rem 0 .8rem; }
  p { margin: 0 0 1rem; }
  ul { margin: 0 0 1.4rem; padding-left: 1.1rem; }
  li { margin-bottom: .5rem; }
  .btn { display:inline-flex; align-items:center; min-height:54px; padding:0 1.6rem;
         border-radius:999px; background:#0c0d0c; color:#fff; font-weight:700;
         text-decoration:none; }
  .btn:focus-visible { outline:3px solid #0c0d0c; outline-offset:3px; }
  .muted { color:#63675c; }
  .small { font-size:.86rem; }
  .ok { font-weight:700; }
  .error { font-weight:700; color:#8e2419; }
</style>
</head>
<body>
  <main>
    <span class="mark"><span class="dot">CF</span> CareFlow</span>
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
