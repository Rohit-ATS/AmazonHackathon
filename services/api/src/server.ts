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

const CORS = {
  // Dev only: the Vite frontend runs on another port, and locking this down would mean
  // Lee cannot build anything. The deployed stack sets an explicit origin instead.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-signature,x-careflow-simulated',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

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

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  // Server-sent events: the live feed the patient screen and dashboard both read.
  if (req.method === 'GET' && url.pathname === '/events/stream') {
    streamEvents(url, res);
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch {
    res.writeHead(413, { ...CORS, 'content-type': 'application/json' });
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
  res.writeHead(result.status, { ...CORS, ...result.headers });
  res.end(result.body);
});

function streamEvents(url: URL, res: ServerResponse) {
  res.writeHead(200, {
    ...CORS,
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

server.listen(runtime.config.port, () => {
  const { config, carePlan } = runtime;
  console.log(`
CareFlow API listening on http://localhost:${config.port}

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
