/**
 * careflow-consent-engine
 *
 * A dependency-free consent state machine for AI agents that can take real-world actions.
 * Make the agent propose; make this decide.
 *
 *   import { createConsentMachine } from 'careflow-consent-engine';
 *
 *   const machine = createConsentMachine({
 *     blockedActions: ['unlock_door', 'medical_advice'],
 *     confirmationTtlMs: 60_000,
 *   });
 *
 *   machine.observe({ kind: 'doorbell' });
 *   machine.offer([
 *     { id: 'notify_daughter', label: 'Contact Maya', sensitive: true },
 *     { id: 'do_nothing', label: 'Do nothing', sensitive: false },
 *   ]);
 *   machine.choose('notify_daughter');   // -> awaiting_confirmation
 *   machine.confirm(true);               // -> acting
 *
 *   const action = machine.confirmedAction!;
 *   machine.assertExecutable(action);    // throws unless this is exactly what was approved
 *   await notify(action);
 *   machine.complete({ ok: true });      // -> done
 */

export { createConsentMachine, DEFAULT_CONFIRMATION_TTL_MS } from './machine.js';
export type { ConsentMachine, MachineSnapshot } from './machine.js';
export { ConsentStateError } from './types.js';
export type {
  ActionDescriptor,
  CompletionResult,
  ConsentConfig,
  ConsentState,
  GuardResult,
  HistoryEntry,
  HistoryEventType,
  ObservedEvent,
} from './types.js';
