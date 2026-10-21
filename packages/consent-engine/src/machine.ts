/**
 * The consent state machine.
 *
 * The problem it solves: an LLM agent that can call tools will, sooner or later, call one
 * it should have asked about first. Prompting helps and does not guarantee. This makes the
 * guarantee structural — there is no code path from "the model said something" to "a
 * sensitive action ran" that does not pass through an explicit confirmation.
 *
 *   observe -> offer -> choose -> confirm -> complete
 *   idle     observed  awaiting   awaiting    acting -> done
 *                      _choice    _confirmation
 *
 * Four properties, each enforced here rather than trusted:
 *
 *   1. `confirm()` only works from `awaiting_confirmation`.
 *   2. The action handed back for execution is the exact object that was confirmed — frozen
 *      at choose time, so it cannot be mutated between the question and the answer.
 *   3. A repeated `confirm()` is recorded and ignored, so a double-tap or a retried request
 *      cannot send twice.
 *   4. Blocked actions are refused from every state, including after a confirmation.
 */

import {
  ConsentStateError,
  type ActionDescriptor,
  type CompletionResult,
  type ConsentConfig,
  type ConsentState,
  type GuardResult,
  type HistoryEntry,
  type HistoryEventType,
  type ObservedEvent,
} from './types.js';

export const DEFAULT_CONFIRMATION_TTL_MS = 60_000;

/**
 * Capabilities this package refuses even when the caller supplies no configuration.
 *
 * `blockedActions` extends this list; it cannot remove entries from it. These are safety
 * boundaries, not application preferences, so a missed environment variable or a stale
 * snapshot must not make them available.
 */
export const DEFAULT_BLOCKED_ACTIONS = Object.freeze([
  'unlock_door',
  'disarm_alarm',
  'medical_advice',
  'emergency_dispatch',
] as const);

export interface ConsentMachine<TPayload = unknown> {
  readonly state: ConsentState;
  /** The action awaiting confirmation, frozen. Undefined unless awaiting confirmation. */
  readonly pendingAction: Readonly<ActionDescriptor<TPayload>> | undefined;
  /**
   * The action the user approved, frozen. Only set once `confirm(true)` has succeeded, and
   * it is what the caller must execute — see `assertExecutable`.
   */
  readonly confirmedAction: Readonly<ActionDescriptor<TPayload>> | undefined;
  readonly options: readonly Readonly<ActionDescriptor<TPayload>>[];

  observe(event?: ObservedEvent): ConsentState;
  offer(options: readonly ActionDescriptor<TPayload>[]): ConsentState;
  choose(actionId: string): ConsentState;
  confirm(affirmative: boolean): ConsentState;
  complete(result?: CompletionResult): ConsentState;
  cancel(reason?: string): ConsentState;

  /** Guardrail check. Safe to call in any state, never mutates. */
  can(action: string | ActionDescriptor<TPayload>): GuardResult;
  /**
   * Throws unless `action` is exactly what the user confirmed and the machine is in
   * `acting`. Call this immediately before performing the side effect — it is the last
   * line of defence, and the cheapest one.
   */
  assertExecutable(action: ActionDescriptor<TPayload>): void;
  /** Append-only audit trail. Returns a copy; callers cannot edit history. */
  history(): readonly HistoryEntry[];
  /** Serializable snapshot, for storing a conversation between requests. */
  snapshot(): MachineSnapshot<TPayload>;
}

export interface MachineSnapshot<TPayload = unknown> {
  state: ConsentState;
  options: ActionDescriptor<TPayload>[];
  pendingAction?: ActionDescriptor<TPayload>;
  confirmedAction?: ActionDescriptor<TPayload>;
  pendingSince?: number;
  history: HistoryEntry[];
}

export function createConsentMachine<TPayload = unknown>(
  config: ConsentConfig = {},
  snapshot?: MachineSnapshot<TPayload>,
): ConsentMachine<TPayload> {
  const blocked = new Set<string>([...DEFAULT_BLOCKED_ACTIONS, ...(config.blockedActions ?? [])]);
  const ttl = config.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  const now = config.now ?? (() => Date.now());

  let state: ConsentState = snapshot?.state ?? 'idle';
  let options: ActionDescriptor<TPayload>[] = (snapshot?.options ?? []).map(freeze);
  let pendingAction = snapshot?.pendingAction ? freeze(snapshot.pendingAction) : undefined;
  let confirmedAction = snapshot?.confirmedAction ? freeze(snapshot.confirmedAction) : undefined;
  let pendingSince = snapshot?.pendingSince;
  // A snapshot is caller-owned input. Clone it so mutating the object used to rehydrate a
  // machine cannot rewrite that machine's audit trail afterwards.
  const log: HistoryEntry[] = (snapshot?.history ?? []).map(clone);

  function record(
    type: HistoryEventType,
    from: ConsentState,
    to: ConsentState,
    extra: { actionId?: string; reason?: string; detail?: Record<string, unknown> } = {},
  ) {
    const entry: HistoryEntry = {
      seq: log.length + 1,
      at: now(),
      type,
      from,
      to,
      ...(config.actor !== undefined ? { actor: config.actor } : {}),
      ...extra,
    };
    log.push(entry);
  }

  /**
   * Expire a stale confirmation before answering any question about state.
   *
   * Checked lazily rather than on a timer: a machine rehydrated from storage an hour later
   * must come back as `timed_out`, and a timer that died with the previous process would
   * have let it come back as still-pending.
   */
  function expireIfStale(): void {
    if (state !== 'awaiting_confirmation' || pendingSince === undefined) return;
    if (now() - pendingSince < ttl) return;

    const from = state;
    state = 'timed_out';
    const staleId = pendingAction?.id;
    pendingAction = undefined;
    pendingSince = undefined;
    record('timed_out', from, state, {
      ...(staleId !== undefined ? { actionId: staleId } : {}),
      reason: `Confirmation was not given within ${ttl}ms.`,
    });
  }

  function guard(action: string | ActionDescriptor<TPayload>): GuardResult {
    const id = typeof action === 'string' ? action : action.id;
    if (blocked.has(id)) {
      return {
        allowed: false,
        reason: `"${id}" is a blocked capability and can never be performed.`,
      };
    }
    return { allowed: true, reason: '' };
  }

  function requireState(allowed: readonly ConsentState[], call: string): void {
    if (!allowed.includes(state)) {
      throw new ConsentStateError(
        'wrong_state',
        `${call}() is not allowed from "${state}" (expected ${allowed.join(' or ')}).`,
      );
    }
  }

  return {
    get state() {
      expireIfStale();
      return state;
    },
    get pendingAction() {
      expireIfStale();
      return pendingAction;
    },
    get confirmedAction() {
      return confirmedAction;
    },
    get options() {
      return options;
    },

    observe(event) {
      expireIfStale();
      requireState(['idle', 'done', 'cancelled', 'timed_out'], 'observe');
      const from = state;
      state = 'observed';
      // A new observation resets any previous decision, so a stale confirmed action from
      // an earlier event can never be executed against a new one.
      options = [];
      pendingAction = undefined;
      confirmedAction = undefined;
      pendingSince = undefined;
      record('observed', from, state, {
        ...(event?.id || event?.detail || event?.kind
          ? {
              detail: {
                ...(event.detail ?? {}),
                ...(event.id ? { eventId: event.id } : {}),
                ...(event.kind ? { kind: event.kind } : {}),
              },
            }
          : {}),
      });
      return state;
    },

    offer(nextOptions) {
      expireIfStale();
      requireState(['observed', 'awaiting_choice', 'awaiting_confirmation'], 'offer');

      // Never offer something we would then refuse. Being told "yes, and then no" is worse
      // than a clear no, especially for someone relying on this to get help.
      const refused = nextOptions.filter((o) => !guard(o).allowed);
      for (const option of refused) {
        record('refused', state, state, { actionId: option.id, reason: guard(option).reason });
      }

      options = nextOptions.filter((o) => guard(o).allowed).map(freeze);
      const from = state;
      state = 'awaiting_choice';
      pendingAction = undefined;
      pendingSince = undefined;
      record('offered', from, state, { detail: { options: options.map((o) => o.id) } });
      return state;
    },

    choose(actionId) {
      expireIfStale();
      requireState(['awaiting_choice', 'awaiting_confirmation'], 'choose');

      const blockedCheck = guard(actionId);
      if (!blockedCheck.allowed) {
        record('refused', state, state, { actionId, reason: blockedCheck.reason });
        throw new ConsentStateError('blocked_action', blockedCheck.reason);
      }

      // Exact match only. No fuzzy matching, no prefixes, no "closest option" — an
      // approximate id is how an agent ends up notifying the wrong person.
      const action = options.find((o) => o.id === actionId);
      if (!action) {
        const reason = `"${actionId}" is not one of the offered actions (${
          options.map((o) => o.id).join(', ') || 'none offered'
        }).`;
        record('refused', state, state, { actionId, reason });
        throw new ConsentStateError('unknown_action', reason);
      }

      const from = state;
      if (action.sensitive) {
        pendingAction = action;
        pendingSince = now();
        state = 'awaiting_confirmation';
      } else {
        // Nothing to confirm about a note or a no-op.
        pendingAction = undefined;
        pendingSince = undefined;
        confirmedAction = action;
        state = 'acting';
      }
      record('chosen', from, state, { actionId });
      return state;
    },

    confirm(affirmative) {
      expireIfStale();

      // A repeat confirmation is a double-tap, a retried HTTP request, or a model saying
      // yes twice. Recording and ignoring it is what stops the second one sending again.
      if (state === 'acting' || state === 'done') {
        record('duplicate_confirmation', state, state, {
          ...(confirmedAction?.id !== undefined ? { actionId: confirmedAction.id } : {}),
          reason: 'This action was already confirmed; ignoring the repeat.',
        });
        return state;
      }

      if (state !== 'awaiting_confirmation' || !pendingAction) {
        throw new ConsentStateError(
          state === 'timed_out' ? 'expired' : 'no_pending_action',
          state === 'timed_out'
            ? 'The confirmation expired before it was answered.'
            : `confirm() requires a pending action; state is "${state}".`,
        );
      }

      // Re-check the blocklist at the moment of consent. Configuration can change between
      // the offer and the answer, and this is the point where it matters.
      const blockedCheck = guard(pendingAction);
      if (!blockedCheck.allowed) {
        const from = state;
        const actionId = pendingAction.id;
        pendingAction = undefined;
        pendingSince = undefined;
        state = 'cancelled';
        record('refused', from, state, { actionId, reason: blockedCheck.reason });
        throw new ConsentStateError('blocked_action', blockedCheck.reason);
      }

      const from = state;
      const actionId = pendingAction.id;

      if (!affirmative) {
        pendingAction = undefined;
        pendingSince = undefined;
        state = 'cancelled';
        record('declined', from, state, { actionId });
        return state;
      }

      confirmedAction = pendingAction;
      pendingAction = undefined;
      pendingSince = undefined;
      state = 'acting';
      record('confirmed', from, state, { actionId });
      return state;
    },

    complete(result) {
      expireIfStale();
      requireState(['acting'], 'complete');
      const from = state;
      state = 'done';
      record('completed', from, state, {
        ...(confirmedAction?.id !== undefined ? { actionId: confirmedAction.id } : {}),
        ...(result ? { detail: { ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) } } : {}),
      });
      return state;
    },

    cancel(reason) {
      expireIfStale();
      if (state === 'done' || state === 'cancelled' || state === 'timed_out') return state;
      const from = state;
      const actionId = pendingAction?.id ?? confirmedAction?.id;
      pendingAction = undefined;
      pendingSince = undefined;
      state = 'cancelled';
      record('cancelled', from, state, {
        ...(actionId !== undefined ? { actionId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      return state;
    },

    can: guard,

    assertExecutable(action) {
      expireIfStale();
      if (state !== 'acting') {
        throw new ConsentStateError(
          'wrong_state',
          `Nothing may be executed from "${state}"; only "acting" permits a side effect.`,
        );
      }
      const blockedCheck = guard(action);
      if (!blockedCheck.allowed) {
        throw new ConsentStateError('blocked_action', blockedCheck.reason);
      }
      if (!confirmedAction || !deepEqual(action, confirmedAction)) {
        // Same id but a different payload still fails here. That is intentional: swapping
        // the message after approval is the subtle version of acting without consent.
        throw new ConsentStateError(
          'unknown_action',
          `Action "${action.id}" does not match the confirmed action "${
            confirmedAction?.id ?? 'none'
          }".`,
        );
      }
    },

    history() {
      // Deep copies: nested detail must be just as append-only as the top-level entry.
      return log.map(clone);
    },

    snapshot() {
      expireIfStale();
      return {
        state,
        options: options.map(clone),
        ...(pendingAction ? { pendingAction: clone(pendingAction) } : {}),
        ...(confirmedAction ? { confirmedAction: clone(confirmedAction) } : {}),
        ...(pendingSince !== undefined ? { pendingSince } : {}),
        history: log.map(clone),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Freeze an action so it cannot change between being offered and being executed.
 *
 * Without this, a caller holding a reference could mutate `payload.message` after the user
 * approved it, and every equality check downstream would still pass.
 */
function freeze<T>(action: ActionDescriptor<T>): Readonly<ActionDescriptor<T>> {
  return Object.freeze({
    ...action,
    ...(action.payload !== undefined ? { payload: deepFreeze(action.payload) } : {}),
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Structural equality over the fields that define an action's effect. */
function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** JSON with sorted keys, so key order never changes the comparison. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
