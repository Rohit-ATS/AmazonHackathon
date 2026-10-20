/**
 * Ring Partner API client.
 *
 * Endpoints and auth flow per the Ring Partner API documentation:
 *   base     https://api.amazonvision.com
 *   token    https://oauth.ring.com/oauth/token
 *   link     https://account.ring.com/account/integrations/partner-link/authorize
 *
 * Scope note: the partner-initiated flow grants `ava.v1:read`, which is read-only — one of
 * the reasons CareFlow's design never promises to open a door. We cannot, and we say so.
 *
 * Token lifetimes: access ~4h (14400s), refresh ~30 days and rotated on every refresh, so
 * the refresh token must be persisted after each exchange. A refresh token is not usable as
 * a bearer token.
 */

import { createHash, randomBytes } from 'node:crypto';

export const RING_API_BASE = 'https://api.amazonvision.com';
export const RING_TOKEN_URL = 'https://oauth.ring.com/oauth/token';
export const RING_AUTHORIZE_URL =
  'https://account.ring.com/account/integrations/partner-link/authorize';

export interface RingCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: string;
}

export interface RingTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
}

export interface RingDevice {
  id: string;
  name?: string;
  kind?: string;
  status?: Record<string, unknown>;
  capabilities?: unknown;
  location?: unknown;
}

export interface RingHistoryEvent {
  id: string;
  type: string;
  created_at?: string;
  attributes?: Record<string, unknown>;
}

export class RingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'RingApiError';
  }
}

// ---------------------------------------------------------------------------
// PKCE account linking
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Build the URL the patient (or, in staging, us) visits to link a Ring account. */
export function buildAuthorizeUrl(
  creds: RingCredentials,
  pkce: PkcePair,
  state: string,
): string {
  const url = new URL(RING_AUTHORIZE_URL);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', creds.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', creds.scope ?? 'ava.v1:read');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function tokenRequest(
  creds: RingCredentials,
  form: Record<string, string>,
): Promise<RingTokens> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    ...form,
  });

  const res = await fetch(RING_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RingApiError(`Ring token exchange failed (${res.status})`, res.status, text);
  }

  const json = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    // Refresh a minute early rather than discovering expiry mid-request.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
}

export function exchangeCodeForTokens(
  creds: RingCredentials,
  code: string,
  codeVerifier: string,
): Promise<RingTokens> {
  return tokenRequest(creds, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: creds.redirectUri,
    code_verifier: codeVerifier,
  });
}

export function refreshTokens(creds: RingCredentials, refreshToken: string): Promise<RingTokens> {
  return tokenRequest(creds, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export interface RingClientOptions {
  credentials: RingCredentials;
  /** Loads stored tokens; return undefined if the account is not linked yet. */
  loadTokens: () => Promise<RingTokens | undefined>;
  /** Persists rotated tokens. Must be called on every refresh or we lose the account. */
  saveTokens: (tokens: RingTokens) => Promise<void>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class RingClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private tokens?: RingTokens;

  constructor(private readonly opts: RingClientOptions) {
    this.baseUrl = opts.baseUrl ?? RING_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** True when an account is linked and we hold usable tokens. */
  async isLinked(): Promise<boolean> {
    try {
      await this.accessToken();
      return true;
    } catch {
      return false;
    }
  }

  private async accessToken(): Promise<string> {
    this.tokens ??= await this.opts.loadTokens();
    if (!this.tokens) throw new RingApiError('Ring account not linked', 401, '');

    if (Date.now() >= this.tokens.expiresAt) {
      this.tokens = await refreshTokens(this.opts.credentials, this.tokens.refreshToken);
      await this.opts.saveTokens(this.tokens);
    }
    return this.tokens.accessToken;
  }

  private async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    const res = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        accept: 'application/json',
      },
    });

    if (res.status === 429) {
      // Ring documents 100 TPS per partner and a Retry-After header. Surface it rather
      // than hammering, since a partner-wide limit punishes every integration we run.
      const retry = Number(res.headers.get('retry-after') ?? '1');
      throw new RingApiError('Ring rate limit exceeded', 429, await res.text(), retry);
    }
    if (!res.ok) {
      throw new RingApiError(`Ring API ${path} failed (${res.status})`, res.status, await res.text());
    }
    return (await res.json()) as T;
  }

  /** GET /v1/devices */
  listDevices(include = 'status,capabilities,location'): Promise<{ data: RingDevice[] }> {
    return this.get('/v1/devices', { include });
  }

  /** GET /v1/devices/{device_id} */
  getDevice(deviceId: string): Promise<{ data: RingDevice }> {
    return this.get(`/v1/devices/${encodeURIComponent(deviceId)}`);
  }

  /** GET /v1/history/devices/{device_id}/events */
  getDeviceHistory(
    deviceId: string,
    query?: { limit?: number; start_time?: string; end_time?: string },
  ): Promise<{ data: RingHistoryEvent[] }> {
    const q: Record<string, string> = {};
    if (query?.limit) q.limit = String(query.limit);
    if (query?.start_time) q.start_time = query.start_time;
    if (query?.end_time) q.end_time = query.end_time;
    return this.get(`/v1/history/devices/${encodeURIComponent(deviceId)}/events`, q);
  }

  /** GET /v1/users/me — cheapest call that proves the link works. */
  getMe(): Promise<{ data: unknown }> {
    return this.get('/v1/users/me');
  }
}
