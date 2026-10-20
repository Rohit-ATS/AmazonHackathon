/**
 * CareFlow Ring simulator.
 *
 * The Ring Partner API only delivers real webhooks to a staging user with a physical device,
 * an active Ring Protect plan, and a US location. The hackathon rules allow a simulator, so
 * this one is built to be indistinguishable from Ring at the boundary:
 *
 *   - payloads match webhook v1.1 field-for-field, including Ring's `data.id` naming
 *     convention (`<device_id>_button_press_<epoch_ms>`) and epoch-millisecond timestamps
 *   - deliveries are signed with a real HMAC-SHA256 `X-Signature: sha256=<hex>` over the
 *     exact bytes on the wire, and the receiving endpoint verifies them for real
 *
 * The only thing that differs from production is which key signs the request. Nothing in the
 * webhook handler is stubbed or bypassed, which is the point: swapping in live credentials
 * changes configuration, not code.
 */

import { randomUUID } from 'node:crypto';
import type { RingEventType, RingWebhookPayload } from '@careflow/shared';
import { signBody } from './webhook.js';

export type SimulatedScenario = 'scheduled' | 'unexpected' | 'delivery' | 'motion_only';

export interface BuildPayloadOptions {
  type: RingEventType;
  deviceId: string;
  accountId?: string;
  /** Defaults to now. Pass a value to replay a payload deterministically in tests. */
  at?: Date;
  subType?: string;
  componentIds?: string[];
  requestId?: string;
}

/** Ring's id convention differs per event type; mirror it rather than inventing one. */
function dataId(type: RingEventType, deviceId: string, ms: number): string {
  if (type === 'button_press') return `${deviceId}_button_press_${ms}`;
  if (type === 'motion_detected') return `${deviceId}_motion_${ms}`;
  return `${deviceId}_${type}_${ms}`;
}

export function buildRingPayload(opts: BuildPayloadOptions): RingWebhookPayload {
  const at = opts.at ?? new Date();
  const ms = at.getTime();
  const deviceId = opts.deviceId;

  const payload: RingWebhookPayload = {
    meta: {
      version: '1.1',
      time: at.toISOString(),
      request_id: opts.requestId ?? randomUUID(),
      account_id: opts.accountId ?? 'acct_careflow_demo',
    },
    data: {
      id: dataId(opts.type, deviceId, ms),
      type: opts.type,
      attributes: {
        source: deviceId,
        source_type: 'devices',
        timestamp: ms,
      },
    },
    relationships: {
      devices: { links: { self: `/v1/devices/${deviceId}` } },
    },
  };

  if (opts.type === 'motion_detected') {
    payload.data.attributes.timestamp_readable = at.toISOString();
    payload.data.attributes.sub_type = opts.subType ?? 'human';
    if (opts.componentIds) payload.data.attributes.component_ids = opts.componentIds;
  } else if (opts.subType) {
    payload.data.attributes.sub_type = opts.subType;
  }

  return payload;
}

/** The three demo scenarios, as the event Ring would actually have sent. */
export function buildScenario(
  scenario: SimulatedScenario,
  deviceId = 'front-door-001',
  at = new Date(),
): RingWebhookPayload {
  switch (scenario) {
    case 'scheduled':
      // A nurse arriving presses the bell.
      return buildRingPayload({ type: 'button_press', deviceId, at });
    case 'unexpected':
      // An unknown person at the door outside any visit window.
      return buildRingPayload({ type: 'button_press', deviceId, at });
    case 'delivery':
      // Ring classifies package motion rather than a press.
      return buildRingPayload({ type: 'motion_detected', deviceId, at, subType: 'package' });
    case 'motion_only':
      return buildRingPayload({ type: 'motion_detected', deviceId, at, subType: 'motion' });
  }
}

export interface DeliveryResult {
  status: number;
  body: string;
  /** The exact bytes we signed and sent, kept so the demo can show them on screen. */
  rawBody: string;
  signature: string;
  latencyMs: number;
}

/**
 * POST a signed payload to a webhook endpoint exactly as Ring would.
 *
 * `JSON.stringify` output is the signed byte sequence, and the same string is sent as the
 * body — never re-serialize between signing and sending.
 */
export async function deliverSignedPayload(
  endpoint: string,
  payload: RingWebhookPayload,
  hmacKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(payload);
  const signature = signBody(rawBody, hmacKey);
  const started = Date.now();

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
      // Ring identifies itself; mirroring it keeps request logs honest about the source.
      'user-agent': 'CareFlow-Ring-Simulator/1.0 (+webhook v1.1)',
      'x-careflow-simulated': 'true',
    },
    body: rawBody,
  });

  return {
    status: res.status,
    body: await res.text(),
    rawBody,
    signature,
    latencyMs: Date.now() - started,
  };
}
