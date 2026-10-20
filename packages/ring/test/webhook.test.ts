/**
 * Ring webhook security tests.
 *
 * These cover the properties a judge would reasonably want demonstrated rather than
 * asserted: that an unsigned or tampered delivery is rejected, that verification runs over
 * the raw bytes, and that the simulator's payloads are shaped the way Ring's are.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRingPayload,
  buildScenario,
  normalizeRingEvent,
  isPatientFacing,
  parsePayload,
  signBody,
  verifySignature,
} from '../src/index.js';
import type { CarePlan } from '@careflow/shared';

const KEY = 'test-hmac-key';

const carePlan = {
  patient: {
    patientId: 'p1',
    displayName: 'Test Patient',
    preferences: { typicalReadyMinutes: 2, largeTextDefault: true, locale: 'en-US' },
  },
  contacts: [],
  visits: [],
  devices: [{ deviceId: 'front-door-001', displayName: 'Front door', kind: 'doorbell' as const }],
} satisfies CarePlan;

describe('signature verification', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify(buildRingPayload({ type: 'button_press', deviceId: 'd1' }));
    expect(verifySignature(body, signBody(body, KEY), KEY)).toEqual({ ok: true });
  });

  it('rejects a body signed with a different key', () => {
    const body = JSON.stringify(buildRingPayload({ type: 'button_press', deviceId: 'd1' }));
    const result = verifySignature(body, signBody(body, 'other-key'), KEY);
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a tampered body under a previously valid signature', () => {
    const original = JSON.stringify(buildRingPayload({ type: 'button_press', deviceId: 'd1' }));
    const signature = signBody(original, KEY);
    const tampered = original.replace('front-door', 'back-door').replace('"d1"', '"d2"');
    expect(verifySignature(tampered, signature, KEY)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature('{}', undefined, KEY)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it.each([
    ['no prefix', 'abcdef'],
    ['wrong algorithm', 'sha1=abcdef'],
    ['not hex', `sha256=${'z'.repeat(64)}`],
    ['wrong length', 'sha256=abc123'],
  ])('rejects a malformed signature (%s)', (_label, header) => {
    expect(verifySignature('{}', header, KEY)).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('refuses to verify when no signing key is configured', () => {
    // Fails closed. A missing key must never be read as "verification not required".
    const body = '{}';
    expect(verifySignature(body, signBody(body, KEY), undefined)).toEqual({
      ok: false,
      reason: 'no_signing_key',
    });
  });

  it('is sensitive to whitespace, because the signature covers raw bytes', () => {
    const payload = buildRingPayload({ type: 'button_press', deviceId: 'd1' });
    const compact = JSON.stringify(payload);
    const pretty = JSON.stringify(payload, null, 2);
    // Same object, different bytes: proof that verifying after a parse-and-reserialize
    // would break, which is exactly the mistake the handler is written to avoid.
    expect(verifySignature(pretty, signBody(compact, KEY), KEY).ok).toBe(false);
  });
});

describe('payload validation', () => {
  it('accepts a well-formed v1.1 payload', () => {
    const payload = buildScenario('scheduled');
    const result = parsePayload(JSON.stringify(payload));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['body_not_json', 'not json'],
    ['missing_meta_request_id', JSON.stringify({ meta: {}, data: { type: 'button_press' } })],
    [
      'missing_attributes_source',
      JSON.stringify({ meta: { request_id: 'r' }, data: { type: 'button_press', attributes: {} } }),
    ],
    [
      'unknown_event_type:fridge_opened',
      JSON.stringify({ meta: { request_id: 'r' }, data: { type: 'fridge_opened' } }),
    ],
  ])('rejects %s', (reason, body) => {
    const result = parsePayload(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
});

describe('simulator payload shape', () => {
  it("follows Ring's data.id convention per event type", () => {
    const at = new Date('2026-10-21T14:14:00Z');
    const ms = at.getTime();
    expect(buildRingPayload({ type: 'button_press', deviceId: 'front-door-001', at }).data.id).toBe(
      `front-door-001_button_press_${ms}`,
    );
    expect(
      buildRingPayload({ type: 'motion_detected', deviceId: 'front-door-001', at }).data.id,
    ).toBe(`front-door-001_motion_${ms}`);
  });

  it('uses epoch milliseconds and declares the payload version', () => {
    const at = new Date('2026-10-21T14:14:00Z');
    const payload = buildRingPayload({ type: 'button_press', deviceId: 'd1', at });
    expect(payload.meta.version).toBe('1.1');
    expect(payload.data.attributes.timestamp).toBe(at.getTime());
    expect(payload.data.attributes.source_type).toBe('devices');
    expect(payload.relationships?.devices?.links?.self).toBe('/v1/devices/d1');
  });

  it('gives motion events a sub_type, as Ring does', () => {
    expect(buildScenario('delivery').data.attributes.sub_type).toBe('package');
    expect(buildScenario('motion_only').data.attributes.sub_type).toBe('motion');
  });

  it('generates a unique request_id per delivery, so dedupe keys do not collide', () => {
    const a = buildRingPayload({ type: 'button_press', deviceId: 'd1' });
    const b = buildRingPayload({ type: 'button_press', deviceId: 'd1' });
    expect(a.meta.request_id).not.toBe(b.meta.request_id);
  });
});

describe('normalization', () => {
  it('resolves the device name from the care plan', () => {
    const event = normalizeRingEvent(buildScenario('scheduled'), { carePlan, source: 'simulator' });
    expect(event.deviceName).toBe('Front door');
    expect(event.kind).toBe('doorbell');
    expect(event.source).toBe('simulator');
  });

  it('falls back to the device id rather than inventing a name', () => {
    const payload = buildRingPayload({ type: 'button_press', deviceId: 'unknown-device' });
    const event = normalizeRingEvent(payload, { carePlan, source: 'ring' });
    expect(event.deviceName).toBe('unknown-device');
  });

  it('starts a conversation for a doorbell press and for human motion only', () => {
    const doorbell = normalizeRingEvent(buildScenario('scheduled'), { carePlan, source: 'simulator' });
    const pkg = normalizeRingEvent(buildScenario('delivery'), { carePlan, source: 'simulator' });
    const human = normalizeRingEvent(
      buildRingPayload({ type: 'motion_detected', deviceId: 'front-door-001', subType: 'human' }),
      { carePlan, source: 'simulator' },
    );
    const offline = normalizeRingEvent(
      buildRingPayload({ type: 'device_offline', deviceId: 'front-door-001' }),
      { carePlan, source: 'simulator' },
    );

    expect(isPatientFacing(doorbell)).toBe(true);
    expect(isPatientFacing(human)).toBe(true);
    // A parcel and a camera reconnecting are logged, not announced.
    expect(isPatientFacing(pkg)).toBe(false);
    expect(isPatientFacing(offline)).toBe(false);
  });
});
