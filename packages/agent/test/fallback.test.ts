import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarePlan, CareSession, Orchestrator } from '@careflow/shared';

const mocked = vi.hoisted(() => ({ factory: vi.fn() }));

vi.mock('../src/bedrock.js', () => ({
  createBedrockOrchestrator: mocked.factory,
}));

import { MODEL_DEADLINE_MS, createOrchestrator } from '../src/index.js';

const carePlan = {
  patient: { displayName: 'Eleanor Reyes', preferredName: 'Eleanor' },
  contacts: [],
} as unknown as CarePlan;

const session = {
  sessionId: 'ses_fallback',
  mode: 'visitor',
  event: { kind: 'doorbell', ringType: 'button_press', deviceName: 'Front door' },
  match: { status: 'unscheduled', reason: 'No matching visit.' },
  state: 'observed',
  turns: [],
  results: [],
} as unknown as CareSession;

describe('Bedrock fallback', () => {
  beforeEach(() => {
    mocked.factory.mockReset();
  });

  it('uses scripted output when the Bedrock call throws', async () => {
    const primary = {
      open: vi.fn().mockRejectedValue(new Error('credentials revoked')),
    } as unknown as Orchestrator;
    mocked.factory.mockReturnValue(primary);
    const log = vi.fn();
    const orchestrator = createOrchestrator({
      carePlan,
      log,
      bedrockModelId: 'amazon.nova-lite-v1:0',
    });

    const turn = await orchestrator.open(session);

    expect(turn.engine).toBe('scripted');
    expect(turn.say).toBeTruthy();
    expect(log).toHaveBeenCalledWith(
      'orchestrator: falling back to scripted',
      expect.objectContaining({ method: 'open', error: 'credentials revoked' }),
    );
  });

  it('uses scripted output when Bedrock exceeds 2.5 seconds', async () => {
    vi.useFakeTimers();
    try {
      const primary = {
        open: vi.fn(() => new Promise(() => undefined)),
      } as unknown as Orchestrator;
      mocked.factory.mockReturnValue(primary);
      const log = vi.fn();
      const orchestrator = createOrchestrator({
        carePlan,
        log,
        bedrockModelId: 'amazon.nova-lite-v1:0',
      });

      const pending = orchestrator.open(session);
      await vi.advanceTimersByTimeAsync(MODEL_DEADLINE_MS);
      const turn = await pending;

      expect(turn.engine).toBe('scripted');
      expect(log).toHaveBeenCalledWith(
        'orchestrator: falling back to scripted',
        expect.objectContaining({ method: 'open', error: 'model_deadline_exceeded' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
