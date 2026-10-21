/**
 * Every hard requirement from the spec has a test here that would fail if the guarantee
 * were only a convention. Where a test is really describing an attack, the comment says so.
 */

import { describe, expect, it } from 'vitest';
import {
  ConsentStateError,
  createConsentMachine,
  type ActionDescriptor,
} from '../src/index.js';

const BLOCKED = ['unlock_door', 'disarm_alarm', 'medical_advice', 'emergency_dispatch'];

const notify: ActionDescriptor = {
  id: 'notify_trusted_contact',
  label: 'Contact Maya',
  sensitive: true,
  payload: { contactId: 'con_maya', message: 'Someone is at the door.' },
};

const doNothing: ActionDescriptor = { id: 'do_nothing', label: 'Do nothing', sensitive: false };

function machine(overrides: Parameters<typeof createConsentMachine>[0] = {}) {
  return createConsentMachine({ blockedActions: BLOCKED, ...overrides });
}

/** Walk a machine to the point where a sensitive action is awaiting confirmation. */
function awaitingConfirmation(overrides: Parameters<typeof createConsentMachine>[0] = {}) {
  const m = machine(overrides);
  m.observe({ kind: 'doorbell' });
  m.offer([notify, doNothing]);
  m.choose(notify.id);
  return m;
}

describe('the happy path', () => {
  it('walks observe -> offer -> choose -> confirm -> complete', () => {
    const m = machine();
    expect(m.state).toBe('idle');
    expect(m.observe({ kind: 'doorbell' })).toBe('observed');
    expect(m.offer([notify, doNothing])).toBe('awaiting_choice');
    expect(m.choose(notify.id)).toBe('awaiting_confirmation');
    expect(m.confirm(true)).toBe('acting');
    m.assertExecutable(m.confirmedAction!);
    expect(m.complete({ ok: true })).toBe('done');
  });

  it('sends a non-sensitive action straight to acting, with no confirmation', () => {
    const m = machine();
    m.observe();
    m.offer([notify, doNothing]);
    // There is nothing to undo about doing nothing, so asking would be noise.
    expect(m.choose(doNothing.id)).toBe('acting');
    expect(m.confirmedAction?.id).toBe(doNothing.id);
  });
});

// Requirement 1
describe('confirm() requires awaiting_confirmation', () => {
  it.each([
    ['idle', (m: ReturnType<typeof machine>) => m],
    ['observed', (m: ReturnType<typeof machine>) => (m.observe(), m)],
    ['awaiting_choice', (m: ReturnType<typeof machine>) => (m.observe(), m.offer([notify]), m)],
  ])('throws from %s', (_label, setup) => {
    const m = setup(machine());
    expect(() => m.confirm(true)).toThrow(ConsentStateError);
    expect(m.confirmedAction).toBeUndefined();
  });

  it('throws from cancelled', () => {
    const m = awaitingConfirmation();
    m.confirm(false);
    expect(m.state).toBe('cancelled');
    expect(() => m.confirm(true)).toThrow(ConsentStateError);
  });
});

// Requirement 2
describe('the executed action is the action that was confirmed', () => {
  it('accepts exactly the confirmed action', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    expect(() => m.assertExecutable(m.confirmedAction!)).not.toThrow();
  });

  it('rejects a different action with the same id', () => {
    // The subtle attack: approval obtained for one message, a different message sent.
    const m = awaitingConfirmation();
    m.confirm(true);
    const swapped: ActionDescriptor = {
      ...notify,
      payload: { contactId: 'con_maya', message: 'Come straight in, the door is open.' },
    };
    expect(() => m.assertExecutable(swapped)).toThrow(/does not match the confirmed action/);
  });

  it('rejects a different action entirely', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    expect(() => m.assertExecutable(doNothing)).toThrow(ConsentStateError);
  });

  it('ignores key order when comparing', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    const reordered: ActionDescriptor = {
      sensitive: true,
      label: 'Contact Maya',
      id: 'notify_trusted_contact',
      payload: { message: 'Someone is at the door.', contactId: 'con_maya' },
    };
    // Same effect, different serialization: this must pass, or every round-trip through
    // JSON would look like tampering.
    expect(() => m.assertExecutable(reordered)).not.toThrow();
  });

  it('freezes the action so it cannot be mutated after approval', () => {
    const mutable: ActionDescriptor = {
      id: 'notify_trusted_contact',
      label: 'Contact Maya',
      sensitive: true,
      payload: { message: 'original' },
    };
    const m = machine();
    m.observe();
    m.offer([mutable]);
    m.choose(mutable.id);
    m.confirm(true);

    const approved = m.confirmedAction!;
    // Frozen objects swallow writes in sloppy mode and throw in strict mode; either way
    // the value must not change.
    try {
      (approved.payload as { message: string }).message = 'tampered';
    } catch {
      // Expected under strict mode.
    }
    expect((approved.payload as { message: string }).message).toBe('original');
  });

  it('refuses to execute anything once complete', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    const action = m.confirmedAction!;
    m.complete({ ok: true });
    expect(() => m.assertExecutable(action)).toThrow(/only "acting"/);
  });
});

// Requirement 3
describe('a repeated confirmation is not a second send', () => {
  it('is a recorded no-op', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    expect(m.confirm(true)).toBe('acting');
    expect(m.confirm(true)).toBe('acting');

    const confirmations = m.history().filter((h) => h.type === 'confirmed');
    const duplicates = m.history().filter((h) => h.type === 'duplicate_confirmation');
    // One consent, two ignored repeats — and the repeats are visible in the audit trail
    // rather than silently dropped.
    expect(confirmations).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
  });

  it('is still a no-op after completion', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    m.complete({ ok: true });
    expect(m.confirm(true)).toBe('done');
    expect(m.history().filter((h) => h.type === 'confirmed')).toHaveLength(1);
  });
});

// Requirement 4
describe('blocked actions are refused in every state', () => {
  const unlock: ActionDescriptor = { id: 'unlock_door', label: 'Unlock the door', sensitive: true };

  it('reports why, without mutating state', () => {
    const m = machine();
    const verdict = m.can('unlock_door');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/blocked capability/);
    expect(m.state).toBe('idle');
  });

  it('is filtered out of the offered options', () => {
    const m = machine();
    m.observe();
    m.offer([unlock, notify, doNothing]);
    // Never offer what would then be refused: being told "yes, and then no" is worse than
    // a clear no.
    expect(m.options.map((o) => o.id)).toEqual([notify.id, doNothing.id]);
    expect(m.history().some((h) => h.type === 'refused' && h.actionId === 'unlock_door')).toBe(true);
  });

  it('cannot be chosen even if the caller asks for it directly', () => {
    const m = machine();
    m.observe();
    m.offer([notify]);
    expect(() => m.choose('unlock_door')).toThrow(/blocked capability/);
    expect(m.state).toBe('awaiting_choice');
  });

  it('cannot be executed even if it somehow became the confirmed action', () => {
    // Belt and braces: a machine rehydrated from a snapshot written before the action was
    // blocked must still refuse it.
    const m = createConsentMachine(
      { blockedActions: BLOCKED },
      {
        state: 'acting',
        options: [],
        confirmedAction: unlock,
        history: [],
      },
    );
    expect(() => m.assertExecutable(unlock)).toThrow(/blocked capability/);
  });

  it('is refused at the moment of consent if the blocklist changed', () => {
    const snapshot = (() => {
      const permissive = createConsentMachine({ blockedActions: [] });
      permissive.observe();
      permissive.offer([unlock]);
      permissive.choose(unlock.id);
      return permissive.snapshot();
    })();

    const strict = createConsentMachine({ blockedActions: BLOCKED }, snapshot);
    expect(() => strict.confirm(true)).toThrow(/blocked capability/);
    expect(strict.state).toBe('cancelled');
  });
});

// Requirement 5
describe('ambiguous input never advances the machine', () => {
  it('requires an exact action id', () => {
    const m = machine();
    m.observe();
    m.offer([notify, doNothing]);

    // The failure mode this prevents: a model emitting something close enough to look
    // right, and a fuzzy matcher turning it into a message to a real person.
    for (const guess of ['notify', 'notify_trusted', 'NOTIFY_TRUSTED_CONTACT', 'contact maya', '']) {
      expect(() => m.choose(guess)).toThrow(ConsentStateError);
    }
    expect(m.state).toBe('awaiting_choice');
    expect(m.pendingAction).toBeUndefined();
  });

  it('rejects an action that was never offered', () => {
    const m = machine();
    m.observe();
    m.offer([doNothing]);
    expect(() => m.choose(notify.id)).toThrow(/not one of the offered actions/);
  });

  it('records every refusal with a reason', () => {
    const m = machine();
    m.observe();
    m.offer([notify]);
    expect(() => m.choose('something_else')).toThrow();
    const refusal = m.history().find((h) => h.type === 'refused');
    expect(refusal?.reason).toContain('not one of the offered actions');
  });
});

// Requirement 6
describe('confirmations expire', () => {
  /** Controllable clock, so TTL behaviour is tested without sleeping. */
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('moves to timed_out once the TTL passes', () => {
    const c = clock();
    const m = awaitingConfirmation({ confirmationTtlMs: 60_000, now: c.now });
    expect(m.state).toBe('awaiting_confirmation');

    c.advance(59_999);
    expect(m.state).toBe('awaiting_confirmation');

    c.advance(2);
    // "Yes" a long time after the question may be answering something else entirely.
    expect(m.state).toBe('timed_out');
    expect(m.pendingAction).toBeUndefined();
  });

  it('refuses a late confirmation', () => {
    const c = clock();
    const m = awaitingConfirmation({ confirmationTtlMs: 1_000, now: c.now });
    c.advance(5_000);
    expect(() => m.confirm(true)).toThrow(/expired/);
    expect(m.confirmedAction).toBeUndefined();
  });

  it('expires on rehydration, not on a timer that died with the process', () => {
    const c = clock();
    const snapshot = awaitingConfirmation({ confirmationTtlMs: 1_000, now: c.now }).snapshot();
    c.advance(10_000);
    const revived = createConsentMachine({ confirmationTtlMs: 1_000, now: c.now }, snapshot);
    expect(revived.state).toBe('timed_out');
  });

  it('defaults to a 60 second window', () => {
    const c = clock();
    const m = awaitingConfirmation({ now: c.now });
    c.advance(60_001);
    expect(m.state).toBe('timed_out');
  });
});

// Requirement 7
describe('history is an append-only audit trail', () => {
  it('records who, what, and when for every transition', () => {
    const m = machine({ actor: 'patient:pat_eleanor', now: () => 1_700_000_000_000 });
    m.observe({ kind: 'doorbell', detail: { deviceId: 'front-door-001' } });
    m.offer([notify, doNothing]);
    m.choose(notify.id);
    m.confirm(true);
    m.complete({ ok: true, detail: 'Notified Maya' });

    const types = m.history().map((h) => h.type);
    expect(types).toEqual(['observed', 'offered', 'chosen', 'confirmed', 'completed']);

    for (const entry of m.history()) {
      expect(entry.actor).toBe('patient:pat_eleanor');
      expect(entry.at).toBe(1_700_000_000_000);
      expect(entry.from).toBeDefined();
      expect(entry.to).toBeDefined();
    }
    expect(m.history().map((h) => h.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('cannot be edited from outside', () => {
    const m = machine();
    m.observe();
    const stolen = m.history();
    (stolen as unknown as unknown[]).push({ seq: 99, type: 'confirmed' });
    (stolen[0] as { type: string }).type = 'tampered';

    // An audit trail a caller can rewrite is not an audit trail.
    expect(m.history()).toHaveLength(1);
    expect(m.history()[0]?.type).toBe('observed');
  });

  it('records a decline distinctly from a cancellation', () => {
    const declined = awaitingConfirmation();
    declined.confirm(false);
    expect(declined.history().some((h) => h.type === 'declined')).toBe(true);

    const cancelled = awaitingConfirmation();
    cancelled.cancel('patient walked away');
    const entry = cancelled.history().find((h) => h.type === 'cancelled');
    expect(entry?.reason).toBe('patient walked away');
  });
});

describe('snapshots', () => {
  it('round-trip through JSON and continue mid-conversation', () => {
    const original = awaitingConfirmation();
    const revived = createConsentMachine(
      { blockedActions: BLOCKED },
      JSON.parse(JSON.stringify(original.snapshot())),
    );

    expect(revived.state).toBe('awaiting_confirmation');
    expect(revived.pendingAction?.id).toBe(notify.id);
    expect(revived.confirm(true)).toBe('acting');
    expect(() => revived.assertExecutable(revived.confirmedAction!)).not.toThrow();
  });
});

describe('a new observation clears the previous decision', () => {
  it('drops a stale confirmed action', () => {
    const m = awaitingConfirmation();
    m.confirm(true);
    m.complete({ ok: true });
    const stale = m.confirmedAction!;

    m.observe({ kind: 'doorbell' });
    expect(m.confirmedAction).toBeUndefined();
    // Consent for the last visitor is not consent for this one.
    expect(() => m.assertExecutable(stale)).toThrow(ConsentStateError);
  });
});
