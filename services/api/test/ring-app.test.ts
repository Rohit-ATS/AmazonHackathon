/**
 * The Ring Appstore app surface: account linking.
 *
 * Link initiation is authenticated at the HTTP boundary. These tests cover the second
 * boundary: state and PKCE bind the public callback to the authorized initiation.
 */

import { describe, expect, it } from 'vitest';
import { completeAccountLink, startAccountLink, LINK_TTL_MS } from '../src/lib/ringapp.js';
import { Store } from '../src/lib/store.js';
import type { Config } from '../src/lib/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    storage: 'local',
    localStatePath: ':memory:',
    tableName: 'careflow',
    awsRegion: 'us-east-1',
    ringClientId: 'client-abc',
    ringClientSecret: 'secret-xyz',
    ringRedirectUri: 'https://example.invalid/ring/oauth/callback',
    selfUrl: 'https://example.invalid',
    webAppUrl: 'https://app.example.invalid',
    ...overrides,
  } as unknown as Config;
}

describe('starting an account link', () => {
  it('builds a PKCE authorize URL against Ring', async () => {
    const config = makeConfig();
    const store = new Store(config);
    const result = await startAccountLink(config, store);

    expect('authorizeUrl' in result).toBe(true);
    if (!('authorizeUrl' in result)) return;

    const url = new URL(result.authorizeUrl);
    expect(url.host).toBe('account.ring.com');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Read-only by design: CareFlow cannot unlock a door, and says so to the user.
    expect(url.searchParams.get('scope')).toBe('ava.v1:read');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect((url.searchParams.get('state') ?? '').length).toBeGreaterThan(20);
  });

  it('generates a different state and challenge every time', async () => {
    const config = makeConfig();
    const store = new Store(config);
    const a = await startAccountLink(config, store);
    const b = await startAccountLink(config, store);
    if (!('authorizeUrl' in a) || !('authorizeUrl' in b)) throw new Error('expected URLs');

    const stateA = new URL(a.authorizeUrl).searchParams.get('state');
    const stateB = new URL(b.authorizeUrl).searchParams.get('state');
    expect(stateA).not.toBe(stateB);
  });

  it('explains itself rather than throwing when no credentials are configured', async () => {
    const config = makeConfig({ ringClientId: undefined, ringClientSecret: undefined });
    const result = await startAccountLink(config, new Store(config));
    expect('error' in result).toBe(true);
  });
});

describe('completing an account link', () => {
  it('rejects a state we never issued', async () => {
    // The attack: somebody sends our callback a code for an account that is not ours.
    const config = makeConfig();
    const result = await completeAccountLink(config, new Store(config), {
      code: 'code-from-somewhere-else',
      state: 'never-issued',
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('no longer valid') });
  });

  it('rejects a replayed callback', async () => {
    const config = makeConfig();
    const store = new Store(config);
    const started = await startAccountLink(config, store);
    if (!('authorizeUrl' in started)) throw new Error('expected a URL');
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;

    // Consume it directly rather than through completeAccountLink, which would make a
    // real network call to oauth.ring.com from a unit test. What is under test is that a
    // consumed link cannot be used again.
    expect(await store.takePendingLink(state)).toBeDefined();

    const second = await completeAccountLink(config, store, { code: 'code-1', state });

    expect(second).toEqual({ ok: false, reason: expect.stringContaining('no longer valid') });
  });

  it('rejects an expired link attempt', async () => {
    const config = makeConfig();
    const store = new Store(config);
    const state = 'deliberately-stale';
    await store.savePendingLink(state, {
      verifier: 'v'.repeat(43),
      createdAt: Date.now() - LINK_TTL_MS * 2,
      expiresAt: Date.now() - 1000,
    });

    const result = await completeAccountLink(config, store, { code: 'code', state });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('expired') });
  });

  it('rejects a callback with no code', async () => {
    const config = makeConfig();
    const result = await completeAccountLink(config, new Store(config), { state: 'anything' });
    expect(result.ok).toBe(false);
  });

  it('passes through an error Ring reports', async () => {
    const config = makeConfig();
    const result = await completeAccountLink(config, new Store(config), {
      error: 'access_denied',
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('access_denied') });
  });
});

describe('token storage', () => {
  it('round-trips rotated tokens', async () => {
    // Ring rotates the refresh token on every refresh, so whatever stores them has to be
    // written each time or the link dies silently about thirty days later.
    const store = new Store(makeConfig());
    expect(await store.getRingTokens()).toBeUndefined();

    await store.saveRingTokens({ accessToken: 'a1', refreshToken: 'r1', expiresAt: 1000 });
    expect(await store.getRingTokens()).toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: 1000,
    });

    await store.saveRingTokens({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 2000 });
    expect((await store.getRingTokens())?.refreshToken).toBe('r2');
  });
});
