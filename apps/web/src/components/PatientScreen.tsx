/**
 * The patient screen.
 *
 * Styled as the hero block from the reference design: a big lime panel with the status in
 * heavy display type, a hand-drawn arrow, and pill buttons. The visual language is borrowed
 * wholesale; the accessibility rules underneath it are not negotiable:
 *
 *  - One status line, large, readable across a room.
 *  - One question at a time, with the choices as buttons. Speech is an accelerator, never a
 *    requirement — recognition fails on accents, in noise, and on exactly these voices.
 *  - When consent is pending the panel flips to black and states plainly what is about to
 *    happen, with Yes and No. A judge has to be able to *see* consent, not take our word.
 *  - The transcript is an aria-live region, so a screen reader announces the agent's turn.
 */

import { useEffect, useRef } from 'react';
import type { AgentTurn, CarePlan, CareSession } from '@careflow/shared';
import type { VoiceState } from '../lib/useVoice.js';
import { stagger } from '../lib/useReveal.js';
import { Blob, Scribble } from './Decor.js';

interface Props {
  session: CareSession | undefined;
  plan: CarePlan | undefined;
  lastTurn: AgentTurn | undefined;
  voice: VoiceState;
  busy: boolean;
  error: string | undefined;
  onChoose: (actionId: string) => void;
  onConfirm: (affirmative: boolean) => void;
  onCancel: () => void;
  onRepeat: () => void;
  onAskForHelp: () => void;
}

export function PatientScreen({
  session,
  plan,
  lastTurn,
  voice,
  busy,
  error,
  onChoose,
  onConfirm,
  onCancel,
  onRepeat,
  onAskForHelp,
}: Props) {
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view. Without this the most important line is the one just off
  // the bottom of the box.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, voice.interim]);

  const state = session?.state;
  const awaitingConfirmation = state === 'awaiting_confirmation' && session?.pendingAction;
  const options = session?.options ?? lastTurn?.options ?? [];

  const heroTone = !session
    ? 'is-idle'
    : awaitingConfirmation
      ? 'is-confirming'
      : state === 'done' || state === 'cancelled'
        ? 'is-done'
        : '';

  return (
    <>
      <section className={`hero ${heroTone}`} aria-labelledby="status-line" data-reveal="pop">
        <div className="hero-label">
          {!session ? 'CareFlow' : session.match.status === 'scheduled' ? 'Scheduled visit' : 'At your door'}
        </div>

        <h1 id="status-line">{statusLine(session, voice)}</h1>
        <p className="hero-sub">{statusSub(session, voice, plan)}</p>

        {session?.mode === 'emergency_assist_prototype' && (
          <p className="hero-sub" style={{ marginTop: '0.6rem' }}>
            <span className="badge accent">Emergency assist · prototype</span>{' '}
            CareFlow does not detect emergencies and cannot contact emergency services.
          </p>
        )}

        <div className="hero-actions">
          <button
            className={`btn big ${voice.listening ? 'listening' : 'primary'}`}
            onClick={voice.listening ? voice.stopListening : voice.startListening}
            disabled={busy || !session || voice.speaking}
            aria-pressed={voice.listening}
          >
            {voice.listening ? 'Listening… tap to stop' : 'Hold to speak'}
          </button>
          <button
            className="btn big ghost"
            onClick={onRepeat}
            disabled={!session || voice.speaking}
          >
            Repeat that
          </button>
        </div>

        <Scribble />
      </section>

      {error && (
        <p className="notice" role="alert" data-reveal>
          {error}
        </p>
      )}
      {voice.error && (
        <p className="notice info" role="status" data-reveal>
          {voice.error}
        </p>
      )}

      {awaitingConfirmation && session?.pendingAction && (
        <section className="consent" aria-labelledby="consent-heading" data-reveal="pop">
          <div className="consent-label" id="consent-heading">
            Your approval is needed
          </div>
          <div className="consent-action">CareFlow will {session.pendingAction.summary}.</div>
          {session.pendingAction.message && (
            <div className="small muted">Message: “{session.pendingAction.message}”</div>
          )}
          <div className="hero-actions" style={{ marginTop: '0.4rem' }}>
            <button className="btn yes big" onClick={() => onConfirm(true)} disabled={busy}>
              Yes, do that
            </button>
            <button className="btn no big" onClick={() => onConfirm(false)} disabled={busy}>
              No, don’t
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Nothing has been sent yet. Nothing happens until you say yes.
          </p>
        </section>
      )}

      <section className="card" aria-labelledby="transcript-heading" data-reveal>
        <Blob corner="tr" size="30%" />
        <header>
          <div>
            <div className="eyebrow">Live</div>
            <h2 id="transcript-heading">Conversation</h2>
          </div>
          {lastTurn?.engine && (
            <span className="badge accent" title="Which engine produced the latest turn">
              {lastTurn.engine === 'bedrock' ? 'Amazon Bedrock' : 'Scripted fallback'}
            </span>
          )}
        </header>

        <div
          className="transcript"
          ref={transcriptRef}
          // polite, not assertive: the agent's turn should be announced without cutting a
          // screen reader off mid-sentence.
          aria-live="polite"
          aria-atomic="false"
        >
          {!session && (
            <p className="muted" style={{ margin: 0 }}>
              Nothing is happening right now. When someone comes to the door, CareFlow will
              explain what it sees and ask what you would like to do.
            </p>
          )}

          {session?.turns.map((turn) => (
            <div
              key={turn.turnId}
              className={`bubble ${turn.speaker === 'patient' ? 'patient' : 'agent'}`}
            >
              <span className="who">{turn.speaker === 'patient' ? 'You' : 'CareFlow'}</span>
              {turn.text}
            </div>
          ))}

          {voice.interim && (
            <div className="bubble patient interim">
              <span className="who">You</span>
              {voice.interim}…
            </div>
          )}
        </div>
      </section>

      <section className="card plain" aria-labelledby="controls-heading" data-reveal>
        <header>
          <div>
            <div className="eyebrow">Your choices</div>
            <h2 id="controls-heading">What would you like to do?</h2>
          </div>
          {voice.voiceSource && (
            <span className="badge" title="Where the spoken voice comes from">
              Voice: {voice.voiceSource === 'polly' ? 'Amazon Polly' : 'browser'}
            </span>
          )}
        </header>

        {!voice.recognitionAvailable && (
          <p className="small muted" style={{ marginTop: 0 }}>
            This browser cannot listen, so use the buttons. Everything CareFlow can do is
            available here.
          </p>
        )}

        {/* The buttons are the real interface, not a fallback for when speech fails. */}
        {options.length > 0 && !awaitingConfirmation && (
          <div className="hero-actions" style={{ marginTop: 0 }}>
            {options.map((option, i) => (
              <button
                key={option.actionId}
                className={`btn ${i === 0 ? 'lime' : ''}`}
                onClick={() => onChoose(option.actionId)}
                disabled={busy}
                data-reveal
                style={stagger(i)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '1.4rem 0' }} />

        <div className="hero-actions" style={{ marginTop: 0 }}>
          <button className="btn" onClick={onAskForHelp} disabled={busy}>
            I need help
          </button>
          <button
            className="btn ghost"
            onClick={onCancel}
            disabled={busy || !session || state === 'done' || state === 'cancelled'}
          >
            Cancel
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          “I need help” tells your care team you need them. It does not contact emergency
          services — for an emergency, call them directly.
        </p>
      </section>
    </>
  );
}

function statusLine(session: CareSession | undefined, voice: VoiceState): string {
  if (voice.listening) return 'Listening…';
  if (!session) return 'All quiet at home';

  if (session.state === 'awaiting_confirmation') return 'Waiting for your approval';
  if (session.state === 'done') return 'All done';
  if (session.state === 'cancelled') return 'Nothing was sent';
  if (session.state === 'timed_out') return 'That request timed out';

  if (session.mode === 'emergency_assist_prototype') return 'You asked for help';

  if (session.match.status === 'scheduled') {
    const who = session.match.contact?.displayName ?? 'Your scheduled visitor';
    return `${who} appears to be here`;
  }
  return `Someone is at your ${session.event.deviceName.toLowerCase()}`;
}

function statusSub(
  session: CareSession | undefined,
  voice: VoiceState,
  plan: CarePlan | undefined,
): string {
  if (voice.speaking) return 'CareFlow is speaking…';
  if (!session) {
    const next = plan?.visits.find((v) => new Date(v.startsAt).getTime() > Date.now());
    return next
      ? `Your next visit is at ${new Date(next.startsAt).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        })}. CareFlow will tell you when someone arrives.`
      : 'No more visits scheduled today. CareFlow will tell you when someone arrives.';
  }

  if (session.state === 'done' && session.results[0]) return session.results[0].detail;
  // The matcher's own reason, verbatim. If the system's explanation is not good enough to
  // show the user, it is not good enough.
  return session.match.reason;
}
