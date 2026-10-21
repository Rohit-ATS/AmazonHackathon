/**
 * Safety boundaries, and the guard on what the model is allowed to say.
 *
 * These run without AWS, which matters: the properties they protect are exactly the ones
 * that must hold on a laptop with no credentials, in CI, and in front of a judge.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorDeps } from '@careflow/shared';
import { AI_DISCLOSURE } from '@careflow/shared';
import { checkBoundary } from '../src/safety.js';
import { validateSpokenText } from '../src/bedrock.js';

const deps = { log: vi.fn(), carePlan: {} as never } as unknown as OrchestratorDeps;

describe('medical boundary', () => {
  it.each([
    'Should I take a double dose of my blood pressure tablets?',
    'Should I stop taking the white one?',
    'Is this normal after surgery?',
    "What's wrong with me?",
    'My chest hurts',
    'What dosage should I be on?',
  ])('redirects instead of answering: %s', (utterance) => {
    const boundary = checkBoundary(utterance);
    expect(boundary?.kind).toBe('medical_advice');
    expect(boundary?.say).toContain('not a medical professional');
    // A refusal that leaves someone with nothing is not good enough — it must offer a
    // real next step.
    expect(boundary?.say).toMatch(/care team|Jordan/);
  });

  it('leaves ordinary requests alone', () => {
    for (const ok of [
      "Tell Jordan I'll be ready in two minutes",
      'Contact my daughter',
      'I need help organizing my medications',
      'Do nothing',
    ]) {
      expect(checkBoundary(ok)).toBeNull();
    }
  });

  it('treats a request for help with a care task as coordination, not advice', () => {
    // "Help me organise my medications" is a task for a nurse, not a dosage question.
    // Relaying it is exactly what CareFlow is for, so it must not trip the boundary.
    expect(checkBoundary('I need help with my medications at the visit')).toBeNull();
  });
});

describe('door and alarm boundary', () => {
  it.each(['Unlock the door', 'Just open the door', 'Let them in', 'Disarm the alarm'])(
    'refuses and offers an alternative: %s',
    (utterance) => {
      const boundary = checkBoundary(utterance);
      expect(boundary?.kind).toBe('door_unlock');
      expect(boundary?.say).toMatch(/not able to unlock/i);
      expect(boundary?.say).toMatch(/contact someone you trust|let them know/i);
    },
  );
});

describe('emergency boundary', () => {
  it.each(['Call 911', 'Call an ambulance', 'Dial emergency'])(
    'directs to emergency services without claiming to call them: %s',
    (utterance) => {
      const boundary = checkBoundary(utterance);
      expect(boundary?.kind).toBe('emergency_claim');
      expect(boundary?.say).toMatch(/call them directly/i);
      // Never implies it has contacted anyone, and never discourages the person from
      // calling themselves.
      expect(boundary?.say).not.toMatch(/I (have|'ve) (called|contacted)/i);
    },
  );
});

describe('identification boundary', () => {
  it('does not pretend to recognise people', () => {
    const boundary = checkBoundary('Who is that at the door?');
    expect(boundary?.kind).toBe('identify_person');
    expect(boundary?.say).toMatch(/can't identify/i);
  });
});

describe('guard on what the model may say', () => {
  it('accepts a good turn unchanged', () => {
    const good = `${AI_DISCLOSURE} Your nurse Jordan appears to be at the front door. Would you like to tell them you're ready?`;
    expect(validateSpokenText(good, deps)).toBe(good);
  });

  it('prepends a missing disclosure rather than discarding good words', () => {
    const say = validateSpokenText('Someone is at the front door. Shall I contact Maya?', deps);
    expect(say).toContain(AI_DISCLOSURE);
  });

  it.each([
    ['claims an action already happened', `${AI_DISCLOSURE} I have notified Maya for you.`],
    ['claims to have unlocked', `${AI_DISCLOSURE} I have unlocked the door.`],
    ['mentions emergency services', `${AI_DISCLOSURE} I will call 911 for you.`],
    ['gives medical advice', `${AI_DISCLOSURE} You should take your tablets now.`],
    ['claims to be human', `${AI_DISCLOSURE} I am a nurse and I can help.`],
  ])('discards a turn that %s', (_label, text) => {
    // Falling back to slightly stiffer scripted wording is always better than a warm
    // sentence that is not true.
    expect(validateSpokenText(text, deps)).toBeUndefined();
  });

  it('discards a turn asking more than one question', () => {
    const twoQuestions = `${AI_DISCLOSURE} Is that you, Jordan? Would you like me to open up?`;
    expect(validateSpokenText(twoQuestions, deps)).toBeUndefined();
  });

  it('discards a turn that is too long to listen to', () => {
    const rambling = `${AI_DISCLOSURE} ${'This is a very long explanation. '.repeat(20)}`;
    expect(validateSpokenText(rambling, deps)).toBeUndefined();
  });

  it('strips surrounding quotes a model sometimes adds', () => {
    const quoted = `"${AI_DISCLOSURE} Someone is at the door. Shall I contact Maya?"`;
    expect(validateSpokenText(quoted, deps)?.startsWith('"')).toBe(false);
  });
});
