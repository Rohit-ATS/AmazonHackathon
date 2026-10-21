import { describe, expect, it } from 'vitest';
import { handleRequest, type AppContext, type AppRequest } from '../src/app.js';
import type { Config } from '../src/lib/config.js';
import { Store } from '../src/lib/store.js';

const request = (path: string, authorization?: string, body?: unknown): AppRequest => ({
  method: body === undefined ? 'GET' : 'POST',
  path,
  query: {},
  headers: authorization ? { authorization } : {},
  rawBody: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
});

const context = {
  config: {
    apiAuthToken: 'api-test-token',
    storage: 'local',
    tts: 'browser',
    demoMode: true,
    requireSignatureVerification: true,
    awsRegion: 'us-east-1',
    pollyVoiceId: 'Joanna',
  } as Config,
  carePlan: { patient: { displayName: 'Test' }, visits: [] },
  log: () => {},
  mcp: {
    pendingForHuman: () => [{ confirmationId: 'confirmation-1', summary: 'notify the care team', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    confirmFromHuman: async (confirmationId: string, affirmative: boolean) => ({
      content: [{ type: 'text', text: 'approved' }],
      structuredContent: { confirmationId, affirmative, status: 'done' },
    }),
  },
} as unknown as AppContext;

describe('API authentication boundary', () => {
  it('rejects protected care data without a bearer token', async () => {
    const result = await handleRequest(context, request('/api/care-plan'));
    expect(result.status).toBe(401);
  });

  it('rejects an incorrect token and accepts the configured token', async () => {
    expect((await handleRequest(context, request('/api/care-plan', 'Bearer wrong'))).status).toBe(401);
    expect((await handleRequest(context, request('/api/care-plan', 'Bearer api-test-token'))).status).toBe(200);
  });

  it('keeps health public without exposing care records', async () => {
    const result = await handleRequest(context, request('/healthz'));
    expect(result.status).toBe(200);
    expect(result.body).not.toContain('Test');
  });

  it('does not start Ring account linking from an anonymous GET', async () => {
    const result = await handleRequest(context, request('/ring/link'));
    expect(result.status).toBe(200);
    expect(result.body).toContain('CareFlow access token');
    expect(result.headers.location).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
    expect(result.headers['referrer-policy']).toBe('no-referrer');
  });

  it('requires API authentication before starting Ring account linking', async () => {
    const ringContext = {
      ...context,
      config: {
        ...context.config,
        ringClientId: 'client-abc',
        ringClientSecret: 'secret-xyz',
        ringRedirectUri: 'https://example.invalid/ring/oauth/callback',
      },
      store: new Store({ ...context.config, storage: 'local', localStatePath: ':memory:' } as Config),
    } as AppContext;

    const anonymous = await handleRequest(ringContext, {
      ...request('/ring/link', undefined, { apiToken: 'wrong' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toContain('CareFlow access token');
    expect(anonymous.headers['cache-control']).toBe('no-store');

    const authorizedLink = await handleRequest(ringContext, {
      method: 'POST',
      path: '/ring/link',
      query: {},
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: Buffer.from('apiToken=api-test-token'),
    });
    expect(authorizedLink.status).toBe(303);
    expect(new URL(authorizedLink.headers.location!).host).toBe('account.ring.com');
    expect(authorizedLink.headers['cache-control']).toBe('no-store');
  });

  it('fails Ring account linking closed when no API token is configured', async () => {
    const result = await handleRequest({
      ...context,
      config: { ...context.config, apiAuthToken: undefined },
    } as AppContext, {
      method: 'POST',
      path: '/ring/link',
      query: {},
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: Buffer.from('apiToken=anything'),
    });
    expect(result.status).toBe(401);
  });

  it('keeps the Ring OAuth callback public for the provider redirect', async () => {
    const result = await handleRequest(context, {
      ...request('/ring/oauth/callback'),
      query: { code: 'code', state: 'unknown' },
    });
    expect(result.status).toBe(400);
    expect(result.body).not.toContain('valid CareFlow bearer token');
  });

  it('accepts MCP approval only through the API-authenticated patient channel', async () => {
    const body = { confirmationId: 'confirmation-1', affirmative: true };
    expect((await handleRequest(context, request('/api/mcp/confirm', undefined, body))).status).toBe(401);
    const approved = await handleRequest(context, request('/api/mcp/confirm', 'Bearer api-test-token', body));
    expect(approved.status).toBe(200);
    expect(approved.body).toContain('confirmation-1');
  });

  it('shows pending MCP approvals only to the API-authenticated patient channel', async () => {
    expect((await handleRequest(context, request('/api/mcp/pending'))).status).toBe(401);
    const result = await handleRequest(context, request('/api/mcp/pending', 'Bearer api-test-token'));
    expect(result.status).toBe(200);
    expect(result.body).toContain('confirmation-1');
  });
});
