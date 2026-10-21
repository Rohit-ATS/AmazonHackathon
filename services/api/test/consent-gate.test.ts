/**
 * The consent gate.
 *
 * These tests treat the orchestrator as hostile: each one has it propose something the
 * contract forbids, and asserts the backend refuses. That is the point of the design — the
 * agent is a language model, so the guarantee has to live in code that does not ask it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentTurn,
  CarePlan,
  CareSession,
  Orchestrator,
  SensitiveAction,
} from '@careflow/shared';
import { AI_DISCLOSURE } from '@careflow/shared';
import { buildScenario } from '@careflow/ring';
import { Bus } from '../src/lib/bus.js';
import { SessionService } from '../src/lib/sessions.js';
import { Store } from '../src/lib/store.js';
import type { Config } from '../src/lib/config.js';

const carePlan: CarePlan = {
  patient: {
    patientId: 'p1',
    displayName: 'Test Patient',
    preferences: { typicalReadyMinutes: 2, largeTextDefault: true, locale: 'en-US' },
  },
  contacts: [
    {
      contactId: 'con_nurse',
      displayName: 'Nurse Nurse',
      role: 'caregiver',
      channel: { kind: 'demo', address: 'nurse@example.invalid' },
      notifiableOutsideVisits: true,
    },
    {
      contactId: 'con_daughter',
      displayName: 'Daughter Daughter',
      role: 'trusted_contact',
      channel: { kind: 'demo', address: 'daughter@example.invalid' },
      notifiableOutsideVisits: true,
    },
    {
      contactId: 'con_blocked',
      displayName: 'Not Approved',
      role: 'care_coordinator',
      channel: { kind: 'demo', address: 'nope@example.invalid' },
      // The patient has not approved this contact for notifications.
      notifiableOutsideVisits: false,
    },
  ],
  visits: [],
  devices: [{ deviceId: 'front-door-001', displayName: 'Front door', kind: 'doorbell' }],
  medications: [],
  appointments: [],
  supportResources: [],
};

const notifyDaughter: SensitiveAction = {
  type: 'notify_trusted_contact',
  contactId: 'con_daughter',
  message: 'Someone is at the door.',
  summary: 'notify Daughter Daughter',
};

/** An orchestrator whose every turn is scripted by the test. */
function stubOrchestrator(turns: Partial<Record<keyof Orchestrator, AgentTurn>>): Orchestrator {
  const fallback: AgentTurn = { say: `${AI_DISCLOSURE} Something happened.`, state: 'awaiting_choice' };
  return {
    open: async () => turns.open ?? fallback,
    respond: async () => turns.respond ?? fallback,
    confirm: async () => turns.confirm ?? fallback,
    cancel: async () => turns.cancel ?? { say: 'Cancelled.', state: 'cancelled' },
  };
}

function makeService(orchestrator: Orchestrator) {
  const config = {
    storage: 'local',
    // In-memory: tests leave no files behind and cannot leak into each other or into the
    // running dev server's store.
    localStatePath: ':memory:',
    tableName: 'careflow',
    awsRegion: 'us-east-1',
  } as unknown as Config;

  const store = new Store(config);
  const bus = new Bus();
  const service = new SessionService({
    store,
    bus,
    getCarePlan: async () => carePlan,
    orchestrator,
    demoMode: true,
    log: () => {},
  });
  return { service, store, bus };
}

async function openSession(orchestrator: Orchestrator): Promise<{
  service: SessionService;
  session: CareSession;
}> {
  const { service } = makeService(orchestrator);
  const result = await service.intakeRingEvent(buildScenario('unexpected'), 'simulator');
  if (result.outcome !== 'session_created') throw new Error(`unexpected outcome ${result.outcome}`);
  return { service, session: result.session };
}

describe('AI disclosure', () => {
  it('is added to the first turn even if the orchestrator forgets it', async () => {
    const { session } = await openSession(
      stubOrchestrator({ open: { say: 'Someone is at the door.', state: 'awaiting_choice' } }),
    );
    expect(session.turns[0]?.text).toContain(AI_DISCLOSURE);
    expect(session.turns[0]?.disclosure).toBe(true);
  });
});

describe('sensitive actions require confirmation', () => {
  it('refuses an action proposed straight from the opening turn', async () => {
    // The whole attack in one test: a model that decides to notify somebody immediately.
    const { session } = await openSession(
      stubOrchestrator({
        open: {
          say: `${AI_DISCLOSURE} I have let your daughter know.`,
          state: 'acting',
          executeAction: notifyDaughter,
        },
      }),
    );

    expect(session.results).toHaveLength(0);
    expect(session.state).not.toBe('done');
    expect(session.turns.at(-1)?.text).toContain("didn't have your clear approval");
  });

  it('refuses an action proposed from the choice state', async () => {
    const { service, session } = await openSession(
      stubOrchestrator({
        respond: { say: 'Sending now.', state: 'acting', executeAction: notifyDaughter },
      }),
    );
    const after = await service.respond(session.sessionId, 'contact my daughter');
    expect(after.session.results).toHaveLength(0);
  });

  it('executes once the patient has explicitly confirmed', async () => {
    const { service, session } = await openSession(
      stubOrchestrator({
        respond: {
          say: 'Just to confirm, should I notify your daughter?',
          state: 'awaiting_confirmation',
          pendingAction: notifyDaughter,
        },
        confirm: { say: 'Okay, notifying her now.', state: 'acting', executeAction: notifyDaughter },
      }),
    );

    const asked = await service.respond(session.sessionId, 'contact my daughter');
    expect(asked.session.state).toBe('awaiting_confirmation');
    expect(asked.session.results).toHaveLength(0);

    const done = await service.confirm(session.sessionId, true);
    expect(done.session.state).toBe('done');
    expect(done.session.results).toHaveLength(1);
    expect(done.session.results[0]?.detail).toContain('Daughter Daughter');
  });

  it('does not execute when the patient declines', async () => {
    const { service, session } = await openSession(
      stubOrchestrator({
        respond: {
          say: 'Just to confirm, should I notify your daughter?',
          state: 'awaiting_confirmation',
          pendingAction: notifyDaughter,
        },
        // A model that ignores the "no" and sends anyway.
        confirm: { say: 'Done.', state: 'acting', executeAction: notifyDaughter },
      }),
    );

    await service.respond(session.sessionId, 'contact my daughter');
    const declined = await service.confirm(session.sessionId, false);
    expect(declined.session.results).toHaveLength(0);
  });

  it('refuses to substitute a different action for the confirmed one', async () => {
    const swapped: SensitiveAction = {
      type: 'notify_trusted_contact',
      contactId: 'con_daughter',
      // Same type and target, different message: still not what was approved.
      message: 'Eleanor says come straight in, the door is open.',
      summary: 'notify Daughter Daughter',
    };

    const { service, session } = await openSession(
      stubOrchestrator({
        respond: {
          say: 'Just to confirm, should I notify your daughter?',
          state: 'awaiting_confirmation',
          pendingAction: notifyDaughter,
        },
        confirm: { say: 'Sending.', state: 'acting', executeAction: swapped },
      }),
    );

    await service.respond(session.sessionId, 'contact my daughter');
    const result = await service.confirm(session.sessionId, true);
    expect(result.session.results).toHaveLength(0);
    expect(result.session.turns.at(-1)?.text).toContain("didn't have your clear approval");
  });

  it('rejects a confirmation when nothing is pending', async () => {
    const { service, session } = await openSession(stubOrchestrator({}));
    await expect(service.confirm(session.sessionId, true)).rejects.toThrow(/no action awaiting/i);
  });
});

describe('blocked capabilities', () => {
  it('never executes a blocked capability, even after a confirmation', async () => {
    const unlock = {
      type: 'unlock_door',
      summary: 'unlock the front door',
    } as unknown as SensitiveAction;

    const { service, session } = await openSession(
      stubOrchestrator({
        respond: {
          say: 'Should I unlock the door?',
          state: 'awaiting_confirmation',
          pendingAction: unlock,
        },
        confirm: { say: 'Unlocking.', state: 'acting', executeAction: unlock },
      }),
    );

    // Refused at the point it is offered, so the patient is never asked to approve
    // something that would then be refused anyway.
    const offered = await service.respond(session.sessionId, 'open the door');
    expect(offered.session.pendingAction).toBeUndefined();
    expect(offered.session.results).toHaveLength(0);
    expect(offered.session.turns.at(-1)?.text).toContain("isn't something I'm able to do");
  });
});

describe('patient-controlled contacts', () => {
  it('refuses to notify a contact the patient has not approved', async () => {
    const notApproved: SensitiveAction = {
      type: 'notify_caregiver',
      contactId: 'con_blocked',
      summary: 'notify Not Approved',
    };

    const { service, session } = await openSession(
      stubOrchestrator({
        respond: {
          say: 'Should I contact the agency?',
          state: 'awaiting_confirmation',
          pendingAction: notApproved,
        },
      }),
    );

    const offered = await service.respond(session.sessionId, 'contact the agency');
    expect(offered.session.pendingAction).toBeUndefined();
    expect(offered.session.results).toHaveLength(0);
  });
});

describe('emergency-assist prototype', () => {
  it('is only reachable from a patient-initiated session', async () => {
    const escalate: SensitiveAction = {
      type: 'escalate_care_team',
      summary: 'let your care team know you need help',
    };

    // A Ring-initiated session must not be able to escalate: that would be CareFlow
    // deciding somebody needs help, which is exactly what it must never do.
    const { service, session } = await openSession(
      stubOrchestrator({
        respond: {
          say: 'Should I tell your care team you need help?',
          state: 'awaiting_confirmation',
          pendingAction: escalate,
        },
        confirm: { say: 'Telling them.', state: 'acting', executeAction: escalate },
      }),
    );

    await service.respond(session.sessionId, 'I need help');
    const result = await service.confirm(session.sessionId, true);
    expect(result.session.results).toHaveLength(0);
  });

  it('works when the patient started the session', async () => {
    const escalate: SensitiveAction = {
      type: 'escalate_care_team',
      message: 'The patient used the help button.',
      summary: 'let your care team know you need help',
    };

    const { service } = makeService(
      stubOrchestrator({
        open: {
          say: `${AI_DISCLOSURE} Would you like me to tell them?`,
          state: 'awaiting_confirmation',
          pendingAction: escalate,
        },
        confirm: { say: 'Telling them now.', state: 'acting', executeAction: escalate },
      }),
    );

    const session = await service.startEmergencyAssist();
    expect(session.mode).toBe('emergency_assist_prototype');
    expect(session.state).toBe('awaiting_confirmation');
    expect(session.results).toHaveLength(0);

    const done = await service.confirm(session.sessionId, true);
    expect(done.session.results).toHaveLength(1);
    expect(done.session.results[0]?.detail).toContain('Daughter Daughter');
  });
});

describe('idempotency', () => {
  it('ignores a replayed Ring delivery', async () => {
    const { service } = makeService(stubOrchestrator({}));
    const payload = buildScenario('unexpected');

    const first = await service.intakeRingEvent(payload, 'simulator');
    const second = await service.intakeRingEvent(payload, 'simulator');

    expect(first.outcome).toBe('session_created');
    expect(second.outcome).toBe('duplicate');
  });

  it('does not start a conversation for a package or a device event', async () => {
    const { service } = makeService(stubOrchestrator({}));
    expect((await service.intakeRingEvent(buildScenario('delivery'), 'simulator')).outcome).toBe(
      'logged_only',
    );
  });
});

describe('closed sessions', () => {
  let service: SessionService;
  let sessionId: string;

  beforeEach(async () => {
    const opened = await openSession(
      stubOrchestrator({
        respond: { say: 'Noting that.', state: 'acting', executeAction: { type: 'log_note', note: 'n', summary: 'make a note' } },
      }),
    );
    service = opened.service;
    sessionId = opened.session.sessionId;
    await service.respond(sessionId, 'just make a note');
  });

  it('refuses further turns once the session is done', async () => {
    await expect(service.respond(sessionId, 'actually, contact my daughter')).rejects.toThrow(
      /already done/i,
    );
  });
});
