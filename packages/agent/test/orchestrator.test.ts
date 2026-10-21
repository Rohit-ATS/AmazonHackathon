import { describe, expect, it, vi } from 'vitest';
import type { CarePlan, CareSession, OrchestratorDeps } from '@careflow/shared';
import { AI_DISCLOSURE } from '@careflow/shared';
import {
  createBedrockOrchestrator,
  type BedrockRuntime,
} from '../src/bedrock.js';
import { createScriptedOrchestrator } from '../src/scripted.js';

const carePlan = {
  patient: { patientId: 'pat_eleanor', displayName: 'Eleanor Reyes', preferredName: 'Eleanor' },
  contacts: [
    {
      contactId: 'con_jordan',
      displayName: 'Jordan Mbeki',
      role: 'caregiver',
      relationship: 'Home-health nurse',
      notifiableOutsideVisits: true,
    },
    {
      contactId: 'con_maya',
      displayName: 'Maya Reyes',
      role: 'trusted_contact',
      relationship: 'Daughter',
      notifiableOutsideVisits: true,
    },
  ],
} as unknown as CarePlan;

function session(overrides: Partial<CareSession> = {}): CareSession {
  return {
    sessionId: 'ses_test',
    mode: 'visitor',
    event: {
      eventId: 'evt_test',
      kind: 'doorbell',
      ringType: 'button_press',
      deviceName: 'Front door',
    },
    match: {
      status: 'scheduled',
      reason: 'Inside the scheduled visit window.',
      minutesFromWindow: 0,
      contact: carePlan.contacts[0],
    },
    state: 'awaiting_choice',
    turns: [],
    results: [],
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  } as CareSession;
}

function deps(): OrchestratorDeps {
  return {
    carePlan,
    bedrockModelId: 'amazon.nova-lite-v1:0',
    awsRegion: 'us-east-1',
    log: vi.fn(),
  };
}

describe('scripted orchestrator', () => {
  it('includes the exact AI disclosure in the first turn', async () => {
    const turn = await createScriptedOrchestrator(deps()).open(session());
    expect(turn.disclosure).toBe(true);
    expect(turn.say.startsWith(AI_DISCLOSURE)).toBe(true);
    expect(turn.state).toBe('awaiting_choice');
  });

  it('switches to on-screen buttons only after two unrecognised turns in a row', async () => {
    const orchestrator = createScriptedOrchestrator(deps());
    const first = await orchestrator.respond(session(), 'purple bananas');
    expect(first.say).not.toMatch(/buttons on screen/i);

    const secondSession = session({
      turns: [
        { turnId: 'p1', speaker: 'patient', text: 'purple bananas', at: '2026-10-20T12:00:01Z' },
        { turnId: 'a1', speaker: 'agent', text: first.say, at: '2026-10-20T12:00:02Z' },
        { turnId: 'p2', speaker: 'patient', text: 'silver clouds', at: '2026-10-20T12:00:03Z' },
      ],
    });
    const second = await orchestrator.respond(secondSession, 'silver clouds');
    expect(second.say).toMatch(/use the buttons on screen/i);
    expect(second.options?.length).toBeGreaterThan(0);
  });

  it('extracts time and a non-clinical care note deterministically', async () => {
    const turn = await createScriptedOrchestrator(deps()).respond(
      session(),
      "Tell Jordan I'll be ready in two minutes and I need help with my medications",
    );
    expect(turn.state).toBe('awaiting_confirmation');
    expect(turn.pendingAction).toMatchObject({
      type: 'notify_caregiver',
      contactId: 'con_jordan',
      message: 'Eleanor will be ready in about 2 minutes.',
      note: 'Patient request: help with my medications',
    });
    expect(turn.executeAction).toBeUndefined();
  });

  it('never offers or selects a trusted contact who disabled outside-visit notifications', async () => {
    const restrictedPlan = {
      ...carePlan,
      contacts: carePlan.contacts.map((contact) =>
        contact.role === 'trusted_contact'
          ? { ...contact, notifiableOutsideVisits: false }
          : contact,
      ),
    } as CarePlan;
    const orchestrator = createScriptedOrchestrator({
      ...deps(),
      carePlan: restrictedPlan,
    });

    const opening = await orchestrator.open(
      session({ match: { status: 'unscheduled', reason: 'No matching visit.' } as never }),
    );
    const request = await orchestrator.respond(
      session({ match: { status: 'unscheduled', reason: 'No matching visit.' } as never }),
      'Contact my daughter',
    );

    expect(opening.options?.some((option) => option.actionId === 'notify_trusted')).toBe(false);
    expect(request.pendingAction).toBeUndefined();
    expect(request.executeAction).toBeUndefined();
  });

  it('never uses the prototype-only escalation action in a visitor session', async () => {
    const turn = await createScriptedOrchestrator(deps()).respond(session(), 'Call 911');

    expect(turn.state).toBe('awaiting_confirmation');
    expect(turn.pendingAction?.type).toBe('notify_caregiver');
    expect(turn.pendingAction?.type).not.toBe('escalate_care_team');
    expect(turn.executeAction).toBeUndefined();
  });

  it('keeps escalation confirmation-only in a patient-started emergency prototype', async () => {
    const emergency = session({ mode: 'emergency_assist_prototype' });
    const turn = await createScriptedOrchestrator(deps()).respond(emergency, 'Call 911');

    expect(turn.state).toBe('awaiting_confirmation');
    expect(turn.pendingAction?.type).toBe('escalate_care_team');
    expect(turn.executeAction).toBeUndefined();
  });
});

describe('Bedrock orchestrator', () => {
  it('uses Bedrock only to phrase the opening while keeping scripted state and choices', async () => {
    const converse = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [
            {
              text: `${AI_DISCLOSURE} Jordan appears to be at the front door for the scheduled visit. Would you like to tell Jordan you're ready?`,
            },
          ],
        },
      },
    });
    const runtime: BedrockRuntime = { converse };
    const turn = await createBedrockOrchestrator(deps(), runtime).open(session());

    expect(turn.engine).toBe('bedrock');
    expect(turn.state).toBe('awaiting_choice');
    expect(turn.options?.map((option) => option.actionId)).toEqual([
      'ready_now',
      'need_minutes',
      'do_nothing',
    ]);
    expect(converse).toHaveBeenCalledOnce();
  });

  it('extracts a structured offered action but never executes it before confirmation', async () => {
    const converse = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [
            {
              toolUse: {
                name: 'choose_action',
                input: {
                  action_id: 'notify_caregiver',
                  message: 'Eleanor will be ready in two minutes.',
                  note: 'help with medications',
                },
              },
            },
          ],
        },
      },
    });
    const turn = await createBedrockOrchestrator(deps(), { converse }).respond(
      session(),
      "Tell Jordan I'll be ready in two minutes and I need help with my meds",
    );

    expect(turn.engine).toBe('bedrock');
    expect(turn.state).toBe('awaiting_confirmation');
    expect(turn.pendingAction).toMatchObject({
      type: 'notify_caregiver',
      contactId: 'con_jordan',
      message: 'Eleanor will be ready in two minutes.',
      note: 'Patient request: help with medications',
    });
    expect(turn.executeAction).toBeUndefined();
  });

  it('runs medical and door boundaries before calling Bedrock', async () => {
    const converse = vi.fn();
    const orchestrator = createBedrockOrchestrator(deps(), { converse });

    const medical = await orchestrator.respond(session(), 'Should I double my dose?');
    const door = await orchestrator.respond(session(), 'Let them in');

    expect(converse).not.toHaveBeenCalled();
    expect(medical.say).toMatch(/not a medical professional/i);
    expect(medical.executeAction).toBeUndefined();
    expect(door.say).toMatch(/not able to unlock or open doors/i);
    expect(door.executeAction).toBeUndefined();
  });

  it('falls back to scripted handling when Bedrock returns unclear intent', async () => {
    const converse = vi.fn().mockResolvedValue({
      output: {
        message: {
          content: [
            { toolUse: { name: 'choose_action', input: { action_id: 'do_nothing', unclear: true } } },
          ],
        },
      },
    });
    const turn = await createBedrockOrchestrator(deps(), { converse }).respond(
      session(),
      'something else, perhaps later',
    );

    expect(turn.engine).toBe('scripted');
    expect(turn.state).toBe('awaiting_choice');
    expect(turn.executeAction).toBeUndefined();
  });
});
