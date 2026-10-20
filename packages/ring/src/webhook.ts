/**
 * Ring webhook signature verification.
 *
 * Ring signs each webhook delivery with an HMAC-SHA256 over the *raw request body bytes*,
 * sent as `X-Signature: sha256=<hex>`. Two details matter and both are easy to get wrong:
 *
 *   1. The body must be hashed exactly as received, before any JSON parsing. Parse-then-
 *      re-serialize changes whitespace and key order and the signature will never match.
 *   2. The comparison must be constant-time, or the endpoint leaks the expected signature
 *      one byte at a time to anyone willing to measure.
 *
 * Our simulator signs with the same algorithm, so simulated deliveries exercise this code
 * path for real rather than bypassing it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RingWebhookPayload } from '@careflow/shared';
import { RING_EVENT_TYPES } from '@careflow/shared';

export const SIGNATURE_HEADER = 'x-signature';
const SIGNATURE_PREFIX = 'sha256=';

export type VerifyFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'signature_mismatch'
  | 'no_signing_key';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/** Compute the `sha256=<hex>` header value Ring would send for this body. */
export function signBody(rawBody: Buffer | string, hmacKey: string): string {
  const mac = createHmac('sha256', hmacKey);
  mac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  return SIGNATURE_PREFIX + mac.digest('hex');
}

/**
 * Verify a delivery. `rawBody` must be the untouched bytes of the request.
 */
export function verifySignature(
  rawBody: Buffer | string,
  headerValue: string | undefined | null,
  hmacKey: string | undefined,
): VerifyResult {
  if (!hmacKey) return { ok: false, reason: 'no_signing_key' };
  if (!headerValue) return { ok: false, reason: 'missing_signature' };
  if (!headerValue.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: 'malformed_signature' };

  const provided = headerValue.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: 'malformed_signature' };

  const expected = signBody(rawBody, hmacKey).slice(SIGNATURE_PREFIX.length);

  // Both are fixed-length hex at this point, so the lengths always match and
  // timingSafeEqual cannot throw.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

export type ParseResult =
  | { ok: true; payload: RingWebhookPayload }
  | { ok: false; reason: string };

/**
 * Parse and structurally validate a Ring webhook body.
 *
 * Deliberately strict about the fields we depend on (`meta.request_id` for idempotency,
 * `data.type`, `data.attributes.source`) and deliberately tolerant about everything else,
 * because Ring may add fields and a 4xx on an unknown field would drop real events.
 */
export function parsePayload(rawBody: Buffer | string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body_not_json' };
  }

  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'body_not_object' };
  const p = json as Partial<RingWebhookPayload>;

  if (!p.meta || typeof p.meta.request_id !== 'string' || !p.meta.request_id) {
    return { ok: false, reason: 'missing_meta_request_id' };
  }
  if (!p.data || typeof p.data.type !== 'string') {
    return { ok: false, reason: 'missing_data_type' };
  }
  if (!RING_EVENT_TYPES.includes(p.data.type as never)) {
    return { ok: false, reason: `unknown_event_type:${p.data.type}` };
  }
  const attrs = p.data.attributes;
  if (!attrs || typeof attrs.source !== 'string' || !attrs.source) {
    return { ok: false, reason: 'missing_attributes_source' };
  }
  if (typeof attrs.timestamp !== 'number') {
    return { ok: false, reason: 'missing_attributes_timestamp' };
  }

  return { ok: true, payload: json as RingWebhookPayload };
}
