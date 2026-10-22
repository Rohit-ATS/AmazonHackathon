/**
 * Local dev server.
 *
 * Node's http module, no framework: one fewer dependency to explain in the product
 * feedback, and raw access to the request bytes, which Ring signature verification needs.
 * A framework that helpfully parses JSON for you is actively unhelpful here.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleRequest, type AppRequest } from './app.js';
import { getRuntime } from './context.js';
import { timingSafeEqual } from 'node:crypto';
import { assertSafeLocalServerConfig, corsHeaders } from './lib/local-server-security.js';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Ring payloads are small; anything larger is a mistake or an attack, and buffering it
    // would just hand an attacker our memory.
    if (size > 256 * 1024) throw new Error('payload_too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const runtime = await getRuntime();
assertSafeLocalServerConfig(runtime.config);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const cors = corsHeaders(req.headers.origin, runtime.config.webAppUrl);

  // Do this before body parsing or routing: omitting ACAO prevents reading a response, but
  // it does not stop a browser from sending a simple cross-origin state-changing request.
  if (req.headers.origin && !cors['access-control-allow-origin']) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'origin_not_allowed', message: 'Origin not allowed.' } }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }

  // Server-sent events: the live feed the patient screen and dashboard both read.
  if (req.method === 'GET' && url.pathname === '/events/stream') {
    if (!authorized(req.headers.authorization, runtime.config.apiAuthToken)) {
      res.writeHead(401, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'A valid CareFlow bearer token is required.' } }));
      return;
    }
    streamEvents(url, res, cors);
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch {
    res.writeHead(413, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'payload_too_large', message: 'Body too large.' } }));
    return;
  }

  const appReq: AppRequest = {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers as Record<string, string | undefined>,
    rawBody,
  };

  const result = await handleRequest(runtime, appReq);
  res.writeHead(result.status, { ...cors, ...result.headers });
  res.end(result.body);
});

function authorized(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function streamEvents(url: URL, res: ServerResponse, cors: Record<string, string>) {
  res.writeHead(200, {
    ...cors,
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends will buffer SSE into uselessness without this.
    'x-accel-buffering': 'no',
  });

  const send = (event: { type: string } & Record<string, unknown>) => {
    const { type, ...data } = event;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay anything the client missed while reconnecting, so a dropped connection
  // mid-demo does not leave the timeline with a hole in it.
  const since = url.searchParams.get('since');
  if (since) for (const event of runtime.bus.replaySince(since)) send(event);

  send({ type: 'ready', at: new Date().toISOString() });
  const unsubscribe = runtime.bus.subscribe(send);

  // Proxies and browsers drop idle connections; a comment every 20s keeps it alive without
  // registering as an event.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);

  res.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

server.listen(runtime.config.port, runtime.config.host, () => {
  const { config, carePlan } = runtime;
  console.log(`
CareFlow API listening on http://${config.host}:${config.port}

  storage       ${config.storage}${config.storage === 'local' ? ` (${config.localStatePath})` : ` (${config.tableName})`}
  voice         ${config.tts}${config.tts === 'polly' ? ` (${config.pollyVoiceId})` : ' (browser speech synthesis)'}
  agent         ${config.bedrockModelId ?? 'scripted'}
  patient       ${carePlan.patient.displayName}, ${carePlan.visits.length} visits today

Try it:
  npm run demo:scheduled     a signed Ring doorbell press inside the nursing visit window
  npm run demo:unexpected    a signed Ring doorbell press with no scheduled visit
  curl localhost:${config.port}/healthz
`);
});
