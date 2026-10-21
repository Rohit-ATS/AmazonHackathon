/**
 * Drive the CareFlow MCP server as a real client would.
 *
 *   npm run mcp:demo
 *
 * Walks a full companion conversation over Streamable HTTP — initialize, tools/list, a
 * chat that remembers, a medication refill, and an escalation — asserting the transport
 * rules and the consent gate at each step. This is the script to run on camera: it is the
 * proof that the MCP server is real and that nothing reaches a person without a yes.
 */

import { COMPANION_INSTRUCTIONS } from '../services/api/src/mcp/index.js';

const base = process.env.CAREFLOW_API ?? 'http://localhost:8787';
const endpoint = new URL('/mcp', base).toString();
const PROTOCOL = '2025-11-25';

let sessionId: string | undefined;
let nextId = 1;
let failures = 0;

function step(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function check(ok: boolean, label: string) {
  if (ok) console.log(`  \x1b[32mok\x1b[0m ${label}`);
  else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}
function say(who: string, text: string) {
  const colour = who === 'CareFlow' ? '\x1b[36m' : who === 'Eleanor' ? '\x1b[33m' : '\x1b[90m';
  console.log(`  ${colour}${who}:\x1b[0m ${text}`);
}

async function rpc(
  method: string,
  params?: Record<string, unknown>,
  opts: { expectStatus?: number; omitSession?: boolean; protocolVersion?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // The spec requires the client to list both.
    accept: 'application/json, text/event-stream',
  };
  if (sessionId && !opts.omitSession) headers['mcp-session-id'] = sessionId;
  if (method !== 'initialize') {
    headers['mcp-protocol-version'] = opts.protocolVersion ?? PROTOCOL;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.body?.result;
  return {
    status: res.status,
    isError: Boolean(result?.isError),
    text: (result?.content ?? []).map((c: any) => c.text).join('\n'),
    structured: result?.structuredContent as Record<string, any> | undefined,
    raw: res.body,
  };
}

// ---------------------------------------------------------------------------

step('1. initialize — Streamable HTTP handshake');
{
  const res = await rpc('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'careflow-demo-client', version: '1.0.0' },
  });
  sessionId = res.headers.get('mcp-session-id') ?? undefined;

  check(res.status === 200, `HTTP 200 (${res.status})`);
  check(Boolean(sessionId), 'server assigned an MCP-Session-Id header');
  check(res.body?.result?.protocolVersion === PROTOCOL, `negotiated ${PROTOCOL}`);
  check(res.body?.result?.capabilities?.tools !== undefined, 'declares the tools capability');
  check(
    res.body?.result?.instructions?.includes('not a therapist'),
    'instructions state it is not a therapist',
  );
  console.log(`  \x1b[90m· session ${sessionId}\x1b[0m`);
}

step('2. transport rules');
{
  const noSession = await rpc('tools/list', undefined, { omitSession: true });
  check(noSession.status === 400, `a request without a session id is rejected (${noSession.status})`);

  const badVersion = await rpc('tools/list', undefined, { protocolVersion: '1999-01-01' });
  check(badVersion.status === 400, `an unsupported protocol version is rejected (${badVersion.status})`);

  const origin = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://evil.example',
      'mcp-session-id': sessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'ping' }),
  });
  check(origin.status === 403, `a disallowed Origin is rejected (${origin.status})`);

  const notification = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId!,
      'mcp-protocol-version': PROTOCOL,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  check(notification.status === 202, `a notification gets 202 Accepted (${notification.status})`);

  const unknown = await rpc('tools/call', { name: 'definitely_not_a_tool', arguments: {} });
  check(
    unknown.body?.error?.code === -32601,
    'an unknown tool is a protocol error, not a tool result',
  );
}

step('3. tools/list');
{
  const res = await rpc('tools/list');
  const tools: any[] = res.body?.result?.tools ?? [];
  check(tools.length >= 15, `${tools.length} tools exposed`);
  check(
    tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object'),
    'every tool has a valid inputSchema object',
  );
  for (const t of tools) console.log(`  \x1b[90m· ${t.name}\x1b[0m`);
}

step('4. a conversation that remembers');
{
  const profile = await callTool('get_care_profile');
  say('CareFlow', `(reads profile) ${profile.structured?.name}, ${profile.structured?.context}`);

  await callTool('save_memory', {
    text: 'Her grandson Theo is visiting on Sunday and she is looking forward to it.',
    topic: 'family',
  });
  await callTool('save_memory', {
    text: 'Finds the evenings hardest since coming home.',
    topic: 'worry',
  });
  const recall = await callTool('recall_memories');
  // Asserted by content, not count: memory persists across runs by design, so an exact
  // count would fail the second time the demo is run — which is every time but the first.
  check(
    String(recall.text).includes('Theo') && String(recall.text).includes('evenings'),
    'both memories are recalled in a later turn',
  );
  say('Eleanor', 'Morning.');
  say(
    'CareFlow',
    'Morning, Eleanor. Sunday is getting closer — is Theo still coming? And how was the evening?',
  );

  const checkIn = await callTool('log_check_in', {
    summary: 'Slept badly, but in good spirits about Sunday.',
    mood: 'tired but cheerful',
    initiatedBy: 'careflow',
  });
  check(!checkIn.isError, 'check-in recorded for the care team');
}

step('5. medication refill — nothing happens without a yes');
{
  const meds = await callTool('list_medications');
  const low = meds.structured?.runningLow ?? [];
  check(low.includes('Lisinopril'), `noticed a medication running low (${low.join(', ')})`);
  say('CareFlow', `Your ${low[0]} is down to about a week. Shall I ask the pharmacy for more?`);
  say('Eleanor', 'Yes please.');

  const request = await callTool('request_medication_refill', { medicationId: 'med_lisin' });
  check(
    request.structured?.status === 'confirmation_required',
    'the tool returns a confirmation request, not a refill',
  );
  say('CareFlow', String(request.structured?.askExactly));

  const confirmationId = String(request.structured?.confirmationId);

  const replayGuard = await callTool('confirm_action', {
    confirmationId: 'made-up-id',
    affirmative: true,
  });
  check(replayGuard.isError, 'a made-up confirmation id is refused');

  const done = await callTool('confirm_action', { confirmationId, affirmative: true });
  check(done.structured?.status === 'done', 'the refill goes through after an explicit yes');
  say('CareFlow', done.text.split('\n')[0] ?? '');

  const replay = await callTool('confirm_action', { confirmationId, affirmative: true });
  check(replay.isError, 'the same confirmation cannot be replayed');
}

step('6. saying no means nothing happens');
{
  const request = await callTool('message_contact', {
    contactId: 'con_maya',
    message: 'Mum says she is fine but a bit tired.',
  });
  const confirmationId = String(request.structured?.confirmationId);
  say('CareFlow', String(request.structured?.askExactly));
  say('Eleanor', "No, don't bother her.");

  const cancelled = await callTool('confirm_action', { confirmationId, affirmative: false });
  check(cancelled.structured?.status === 'cancelled', 'declining cancels and sends nothing');
  say('CareFlow', cancelled.text.split('\n')[0] ?? '');
}

step('7. the boundaries');
{
  const notApproved = await callTool('message_contact', {
    contactId: 'con_coord',
    message: 'anything',
  });
  check(notApproved.isError, 'a contact the person has not approved is refused');

  const support = await callTool('get_support_resources');
  check(!support.isError, 'crisis resources are always available, with no confirmation');
  check(
    String(support.structured?.guidance).includes('Do not counsel'),
    'guidance tells the model to hand over, not to counsel',
  );
  say('Eleanor', "Some days I wonder what the point is.");
  say(
    'CareFlow',
    "I'm glad you told me. I'm not a counsellor, but I don't want you sitting with that alone — " +
      'you can reach the 988 Lifeline any time, and your own on-call nurse is there too. ' +
      'Would you like me to let Maya know you could use some company?',
  );

  const escalate = await callTool('escalate_to_care_team', {
    reason: 'She said she has been feeling low in the evenings and would like someone to call.',
  });
  check(
    escalate.structured?.status === 'confirmation_required',
    'even an escalation asks first',
  );
  const done = await callTool('confirm_action', {
    confirmationId: String(escalate.structured?.confirmationId),
    affirmative: true,
  });
  check(done.structured?.status === 'done', 'and goes through once she agrees');
  say('CareFlow', done.text.split('\n')[0] ?? '');
}

step('8. ending the session');
{
  const res = await fetch(endpoint, {
    method: 'DELETE',
    headers: { 'mcp-session-id': sessionId!, 'mcp-protocol-version': PROTOCOL },
  });
  check(res.status === 204, `DELETE terminates the session (${res.status})`);

  const after = await rpc('tools/list');
  check(after.status === 404, `a terminated session returns 404 (${after.status})`);
}

console.log(
  failures === 0
    ? `\n\x1b[32mAll MCP checks passed.\x1b[0m Instructions are ${COMPANION_INSTRUCTIONS.length} characters.\n`
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
