/**
 * Bridge between CareFlow's domain actions and the standalone consent engine.
 *
 * The engine knows nothing about care, Ring, or voice — that is what makes it reusable —
 * so this module translates in both directions and owns CareFlow's policy choices.
 *
 * Why run it at all when `sessions.ts` already enforces the same invariants? Because the
 * redundancy is the design. Two independent implementations of "never act without
 * consent", one generic and unit-tested in isolation, one domain-aware, means a bug in
 * either one is not enough to send a message nobody approved.
 */

import {
  createConsentMachine,
  type ActionDescriptor,
  type ConsentMachine,
  type MachineSnapshot,
} from '@careflow/consent-engine';
import {
  BLOCKED_CAPABILITIES,
  isSensitive,
  type SensitiveAction,
} from '@careflow/shared';

/**
 * How long a pending confirmation stays valid.
 *
 * Ten minutes, not the engine's 60-second default. This is an accessibility decision: the
 * people CareFlow is for may need to find their glasses, cross a room with a walker, or
 * simply think about it. A window that expires while someone is still deciding would
 * punish exactly the users the product exists for.
 */
export const CONFIRMATION_TTL_MS = 10 * 60_000;

export type CareActionDescriptor = ActionDescriptor<SensitiveAction>;

/** CareFlow action -> engine descriptor. The payload carries the whole action, so the
 * engine's structural comparison catches a substituted message, not just a swapped type. */
export function toDescriptor(action: SensitiveAction): CareActionDescriptor {
  return {
    id: action.type,
    label: action.summary,
    sensitive: isSensitive(action.type),
    payload: action,
  };
}

export function createMachine(
  sessionId: string,
  snapshot?: MachineSnapshot<SensitiveAction>,
): ConsentMachine<SensitiveAction> {
  return createConsentMachine<SensitiveAction>(
    {
      blockedActions: BLOCKED_CAPABILITIES,
      confirmationTtlMs: CONFIRMATION_TTL_MS,
      actor: `session:${sessionId}`,
    },
    snapshot,
  );
}
