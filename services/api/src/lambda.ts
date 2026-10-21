/**
 * Lambda entry point for API Gateway HTTP API (payload format 2.0).
 *
 * The same `handleRequest` the dev server uses, so there is no second implementation to
 * keep in sync. The only Lambda-specific concerns are base64 bodies and the fact that SSE
 * has nowhere to live — the frontend polls when it detects no event stream.
 */

import { handleRequest, type AppRequest } from './app.js';
import { getRuntime } from './context.js';

interface ApiGatewayV2Event {
  version: string;
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  requestContext: { http: { method: string; path: string; sourceIp?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  const encodedBytes = event.body ? Buffer.byteLength(event.body, 'utf8') : 0;
  const estimatedBytes = event.isBase64Encoded ? Math.floor((encodedBytes * 3) / 4) : encodedBytes;
  if (estimatedBytes > 256 * 1024) {
    return {
      statusCode: 413,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: { code: 'payload_too_large', message: 'Body too large.' } }),
    };
  }
  const runtime = await getRuntime();

  // Must be the exact bytes Ring signed. API Gateway base64-encodes binary bodies, and
  // decoding to a string first would corrupt any non-ASCII byte before verification.
  const rawBody = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0);

  const req: AppRequest = {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: Object.fromEntries(new URLSearchParams(event.rawQueryString ?? '')),
    headers: lowercaseKeys(event.headers),
    rawBody,
  };

  const result = await handleRequest(runtime, req);

  const isBinary = (result.headers['content-type'] ?? '').startsWith('audio/');
  const bodyBuffer = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);

  return {
    statusCode: result.status,
    headers: result.headers,
    body: isBinary ? bodyBuffer.toString('base64') : bodyBuffer.toString('utf8'),
    isBase64Encoded: isBinary,
  };
}

function lowercaseKeys(h: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
