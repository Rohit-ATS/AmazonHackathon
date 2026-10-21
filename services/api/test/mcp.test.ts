/**
 * The MCP server: transport compliance and the consent gate.
 *
 * The transport tests exist because "MUST" in a spec is only true if something checks it.
 * The consent tests exist because MCP leaves human-in-the-loop to the *client*, and we are
 * not willing to let someone's daughter be phoned because a host skipped a dialog — so the
 * gate is server-side, and these prove it holds even when the caller does not cooperate.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { CarePlan } from '@careflow/shared';
import { createMcpServer } from '../src/mcp/index.js';
import type { McpServer } from '../src/mcp/server.js';
import { Store } from '../src/lib/store.js';
import type { Config } from '../src/lib/config.js';

const PROTOCOL = '2025-11-25';

const carePlan: CarePlan = {
  patient: {
    patientId: 'pat_test',
    displayName: 'Test Patient',
    preferredName: 'Tess',
    preferences: { typicalReadyMinutes: 2, largeTextDefault: true, locale: 'en-US' },
  },
  contacts: [
    {
      contactId: 'con_daughter',
      displayName: 'Daughter Daughter',
      role: 'trusted_contact',
      channel: { kind: 'demo', address: 'daughter@example.invalid' },
      notifiableOutsideVisits: true,
    },
    {
      contactId: 'con_blocked',
      displayName: 'Not Approved',
      role: 'care_coordinator',
      channel: { kind: 'demo', address: 'nope@example.invalid' },
      notifiableOutsideVisits: false,
    },
  ],
  visits: [],
  devices: [],
  medications: [
    {
      medicationId: 'med_a',
      name: 'Medication A',
      schedule: 'Morning',
      remindAt: '08:00',
      refillsRemaining: 2,
      daysSupplyRemaining: 5,
      pharmacy: 'Test Pharmacy',
    },
    {
      medicationId: 'med_none',
      name: 'Medication B',
      schedule: 'Evening',
      remindAt: '20:00',
      refillsRemaining: 0,
      daysSupplyRemaining: 3,
      pharmacy: 'Test Pharmacy',
    },
  ],
  appointments: [],
  supportResources: [
    { name: 'Crisis line', contact: '988', region: 'US', hours: '24/7' },
  ],
};

function makeServer(): McpServer {
  const config = { storage: 'local', localStatePath: ':memory:' } as unknown as Config;
  return createMcpServer(
    {
      store: new Store(config),
      getCarePlan: async () => carePlan,
      demoMode: true,
      log: () => {},
    },
    '0.0.0-test',
    ['https://allowed.example'],
  );
}

let server: McpServer;
let sessionId: string;
let id = 0;

async function post(
  body: unknown,
  headers: Record<string, string | undefined> = {},
): ReturnType<McpServer['handle']> {
  return server.handle({
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      'mcp-protocol-version': PROTOCOL,
      ...headers,
    },
    rawBody: Buffer.from(JSON.stringify(body)),
  });
}

async function rpc(method: string, params?: Record<string, unknown>) {
  const res = await post({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });
  return { status: res.status, body: JSON.parse(res.body || '{}'), headers: res.headers };
}

async function initialize() {
  const res = await server.handle({
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream' },
    rawBody: Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'test' } },
      }),
    ),
  });
  sessionId = res.headers['mcp-session-id']!;
  return { status: res.status, body: JSON.parse(res.body), headers: res.headers };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.body.result;
  return {
    isError: Boolean(result?.isError),
    text: (result?.content ?? []).map((c: { text?: string }) => c.text).join('\n'),
    structured: result?.structuredContent as Record<string, unknown> | undefined,
    error: res.body.error,
  };
}

beforeEach(async () => {
  server = makeServer();
  sessionId = '';
  await initialize();
});

describe('Streamable HTTP transport', () => {
  it('assigns a session id at initialize and negotiates the protocol version', async () => {
    const fresh = makeServer();
    server = fresh;
    sessionId = '';
    const res = await initialize();

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toMatch(/[0-9a-f-]{36}/);
    expect(res.body.result.protocolVersion).toBe(PROTOCOL);
    expect(res.body.result.capabilities.tools).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe('careflow');
  });

  it('rejects a request with no session id', async () => {
    const saved = sessionId;
    sessionId = '';
    const res = await rpc('tools/list');
    expect(res.status).toBe(400);
    sessionId = saved;
  });

  it('returns 404 once a session is terminated, so the client re-initializes', async () => {
    const deleted = await server.handle({
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
      rawBody: Buffer.alloc(0),
    });
    expect(deleted.status).toBe(204);

    const after = await rpc('tools/list');
    expect(after.status).toBe(404);
  });

  it('rejects an unsupported protocol version but tolerates an absent one', async () => {
    const bad = await post(
      { jsonrpc: '2.0', id: ++id, method: 'ping' },
      { 'mcp-protocol-version': '1999-01-01' },
    );
    expect(bad.status).toBe(400);

    // Spec: a missing header means assume 2025-03-26, not reject.
    const absent = await post(
      { jsonrpc: '2.0', id: ++id, method: 'ping' },
      { 'mcp-protocol-version': undefined },
    );
    expect(absent.status).toBe(200);
  });

  it('answers a notification with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.body).toBe('');
  });

  it('requires an Accept header listing both content types', async () => {
    const res = await post({ jsonrpc: '2.0', id: ++id, method: 'ping' }, { accept: 'text/plain' });
    expect(res.status).toBe(406);
  });

  describe('Origin validation', () => {
    it('allows a request with no Origin, which is the normal MCP host case', async () => {
      const res = await post({ jsonrpc: '2.0', id: ++id, method: 'ping' });
      expect(res.status).toBe(200);
    });

    it('allows a configured Origin', async () => {
      const res = await post(
        { jsonrpc: '2.0', id: ++id, method: 'ping' },
        { origin: 'https://allowed.example' },
      );
      expect(res.status).toBe(200);
    });

    it('rejects an unrecognised Origin with 403', async () => {
      // This is what DNS rebinding looks like from the server's side.
      const res = await post(
        { jsonrpc: '2.0', id: ++id, method: 'ping' },
        { origin: 'https://evil.example' },
      );
      expect(res.status).toBe(403);
    });
  });

  it('treats an unknown tool as a protocol error, not a tool result', async () => {
    const res = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    // The model cannot fix this by adjusting arguments, so it is -32601 rather than
    // a result carrying isError.
    expect(res.body.error.code).toBe(-32601);
  });
});

describe('tools/list', () => {
  it('exposes every tool with a valid input schema', async () => {
    const res = await rpc('tools/list');
    const tools = res.body.result.tools as { name: string; inputSchema: unknown }[];

    expect(tools.length).toBeGreaterThanOrEqual(15);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.inputSchema).not.toBeNull();
      // Spec guidance on tool names.
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });
});

describe('the consent gate', () => {
  it('does not send a message, it asks first', async () => {
    const result = await callTool('message_contact', {
      contactId: 'con_daughter',
      message: 'Just checking in.',
    });

    expect(result.structured?.status).toBe('confirmation_required');
    expect(result.structured?.confirmationId).toBeTypeOf('string');
    // The model is handed the exact sentence rather than left to paraphrase consent.
    expect(String(result.structured?.askExactly)).toContain('Just to confirm');
  });

  it('executes only after an explicit yes', async () => {
    const staged = await callTool('message_contact', {
      contactId: 'con_daughter',
      message: 'Just checking in.',
    });
    const confirmationId = String(staged.structured?.confirmationId);

    const done = await callTool('confirm_action', { confirmationId, affirmative: true });
    expect(done.structured?.status).toBe('done');
    expect(done.text).toContain('Daughter Daughter');
  });

  it('sends nothing when the person says no', async () => {
    const staged = await callTool('call_contact', { contactId: 'con_daughter' });
    const confirmationId = String(staged.structured?.confirmationId);

    const cancelled = await callTool('confirm_action', { confirmationId, affirmative: false });
    expect(cancelled.structured?.status).toBe('cancelled');
  });

  it('refuses a confirmation id it never issued', async () => {
    const result = await callTool('confirm_action', {
      confirmationId: 'invented',
      affirmative: true,
    });
    expect(result.isError).toBe(true);
  });

  it('refuses to replay a used confirmation', async () => {
    const staged = await callTool('message_contact', {
      contactId: 'con_daughter',
      message: 'Hello.',
    });
    const confirmationId = String(staged.structured?.confirmationId);

    await callTool('confirm_action', { confirmationId, affirmative: true });
    const replay = await callTool('confirm_action', { confirmationId, affirmative: true });

    // A yes is good once. Otherwise a retried request sends twice.
    expect(replay.isError).toBe(true);
  });

  it('refuses a non-boolean answer rather than guessing', async () => {
    const staged = await callTool('message_contact', {
      contactId: 'con_daughter',
      message: 'Hello.',
    });
    const result = await callTool('confirm_action', {
      confirmationId: String(staged.structured?.confirmationId),
      affirmative: 'probably' as unknown as boolean,
    });
    expect(result.isError).toBe(true);
  });
});

describe('boundaries', () => {
  it('refuses to contact someone the person has not approved', async () => {
    const result = await callTool('message_contact', {
      contactId: 'con_blocked',
      message: 'anything',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not approved');
  });

  it('refuses a refill with no refills left, and suggests the real next step', async () => {
    const result = await callTool('request_medication_refill', { medicationId: 'med_none' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('prescriber');
  });

  it('surfaces crisis resources with no confirmation and no counselling', async () => {
    const result = await callTool('get_support_resources');
    expect(result.isError).toBe(false);
    expect(String(result.structured?.guidance)).toContain('Do not counsel');
    expect(String(result.structured?.guidance)).toContain('do not assess risk');
  });

  it('still asks before escalating to a human', async () => {
    const result = await callTool('escalate_to_care_team', { reason: 'She asked for someone.' });
    // Speed would be convenient here. A consent system that bends when it is inconvenient
    // is not one.
    expect(result.structured?.status).toBe('confirmation_required');
  });
});

describe('companionship', () => {
  it('remembers across turns so tomorrow is not a cold start', async () => {
    await callTool('save_memory', { text: 'Her grandson is called Theo.', topic: 'family' });
    const recalled = await callTool('recall_memories', { topic: 'family' });
    expect(String(recalled.text)).toContain('Theo');
  });

  it('records check-ins without inventing a clinical assessment', async () => {
    const result = await callTool('log_check_in', {
      summary: 'Quiet day, did the crossword.',
      mood: 'alright',
    });
    expect(result.isError).toBe(false);

    const recent = await callTool('get_recent_check_ins');
    expect(String(recent.text)).toContain('crossword');
  });

  it('notices a medication running low', async () => {
    const result = await callTool('list_medications');
    expect(result.structured?.runningLow).toContain('Medication A');
  });

  it('rejects an unparseable reminder time instead of inventing one', async () => {
    const result = await callTool('set_reminder', { text: 'Take tablets', dueAt: 'teatime' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ISO-8601');
  });
});
