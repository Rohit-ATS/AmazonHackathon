/**
 * Ring webhook payload -> CareFlow's normalized CareEvent.
 *
 * Keeping normalization in one pure function means the rest of the system never has to
 * know Ring's payload shape, and means we can add a second event source later without
 * touching the orchestrator.
 */

import type { CareEvent, CareEventKind, CarePlan, RingWebhookPayload } from '@careflow/shared';

function kindFor(type: RingWebhookPayload['data']['type']): CareEventKind {
  switch (type) {
    case 'button_press':
      return 'doorbell';
    case 'motion_detected':
      return 'motion';
    case 'device_online':
    case 'device_offline':
    case 'device_added':
    case 'device_removed':
      return 'device_status';
    case 'app_integration_added':
    case 'app_integration_removed':
    case 'subscription_activated':
    case 'subscription_deactivated':
      return 'account';
    default:
      return 'other';
  }
}

export function normalizeRingEvent(
  payload: RingWebhookPayload,
  opts: { carePlan?: CarePlan; source: 'ring' | 'simulator' },
): CareEvent {
  const { data, meta } = payload;
  const deviceId = data.attributes.source;
  const device = opts.carePlan?.devices.find((d) => d.deviceId === deviceId);

  const event: CareEvent = {
    eventId: data.id || `${deviceId}_${data.type}_${data.attributes.timestamp}`,
    requestId: meta.request_id,
    deviceId,
    // Fall back to the raw id rather than inventing a name: the UI should never claim
    // to know about a device that is not in the care plan.
    deviceName: device?.displayName ?? deviceId,
    kind: kindFor(data.type),
    ringType: data.type,
    occurredAt: new Date(data.attributes.timestamp).toISOString(),
    source: opts.source,
  };
  if (data.attributes.sub_type) event.subType = data.attributes.sub_type;
  return event;
}

/**
 * Should this event start a conversation with the patient?
 *
 * Device-status and account events are logged but must never make the house start
 * talking — waking someone up to tell them a camera came back online is exactly the
 * kind of thing that gets an assistant unplugged.
 */
export function isPatientFacing(event: CareEvent): boolean {
  if (event.kind === 'doorbell') return true;
  // Only human-classified motion is worth interrupting someone for.
  if (event.kind === 'motion') return event.subType === 'human' || event.subType === undefined;
  return false;
}
