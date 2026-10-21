/**
 * Public types.
 *
 * Deliberately free of any CareFlow or Ring vocabulary. The whole value of this package is
 * that somebody building an unrelated agent can drop it in, so it knows about "actions" and
 * "consent" and nothing else.
 */

export type ConsentState =
  /** Nothing has happened yet. */
  | 'idle'
  /** An event has been observed and explained, but no choices offered. */
  | 'observed'
  /** Choices are on the table; waiting for the user to pick one. */
  | 'awaiting_choice'
  /** A sensitive action is picked; waiting for an explicit yes or no. */
  | 'awaiting_confirmation'
  /** Consent granted. The caller may now execute exactly the confirmed action. */
  | 'acting'
  /** The action finished. Terminal. */
  | 'done'
  /** The user declined, or cancelled. Terminal. */
  | 'cancelled'
  /** Confirmation was not given in time. Terminal. */
  | 'timed_out';

/**
 * An action the agent can offer.
 *
 * `id` is what `choose()` requires, exactly. That is the point: a language model cannot
 * "sort of" select an action, because an approximate id is not an id.
 */
export interface ActionDescriptor<TPayload = unknown> {
  id: string;
  /** Shown or spoken to the user. Should describe the effect, not the mechanism. */
  label: string;
  /**
   * Sensitive actions require a confirmation turn. Non-sensitive ones (making a note,
   * doing nothing) go straight to `acting`, because there is nothing to undo.
   */
  sensitive: boolean;
  payload?: TPayload;
}

export interface ObservedEvent {
  /** Caller's own event id, carried into the history for correlation. */
  id?: string;
  kind?: string;
  /** Anything the caller wants on the audit record. Not interpreted. */
  detail?: Record<string, unknown>;
}

export interface ConsentConfig {
  /**
   * Action ids that can never be chosen, confirmed, or executed, in any state.
   *
   * These are refusals, not unimplemented features. A capability on this list stays
   * refused even if the user explicitly asks for it and confirms it.
   */
  blockedActions?: readonly string[];
  /**
   * How long a pending confirmation stays valid. After this the machine moves to
   * `timed_out` and the action cannot be executed.
   *
   * There is a real safety reason for a short window: "yes" ten minutes after the question
   * may be answering something else entirely.
   */
  confirmationTtlMs?: number;
  /** Injectable clock, so TTL behaviour is testable without waiting. */
  now?: () => number;
  /** Recorded on every history entry, e.g. a user or session id. */
  actor?: string;
}

export type HistoryEventType =
  | 'observed'
  | 'offered'
  | 'chosen'
  | 'confirmed'
  | 'declined'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'refused'
  | 'duplicate_confirmation';

export interface HistoryEntry {
  seq: number;
  at: number;
  type: HistoryEventType;
  from: ConsentState;
  to: ConsentState;
  actor?: string;
  actionId?: string;
  /** Present on refusals. Always explains *why*, so a UI can tell the user something true. */
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface GuardResult {
  allowed: boolean;
  /** Human-readable, safe to show a user. Empty when allowed. */
  reason: string;
}

export interface CompletionResult {
  ok: boolean;
  detail?: string;
}

/** Thrown when a call is made from a state that does not permit it. */
export class ConsentStateError extends Error {
  constructor(
    readonly code:
      | 'wrong_state'
      | 'unknown_action'
      | 'blocked_action'
      | 'no_pending_action'
      | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'ConsentStateError';
  }
}
