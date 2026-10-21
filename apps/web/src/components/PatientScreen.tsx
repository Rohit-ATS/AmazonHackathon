/**
 * The patient screen.
 *
 * Design rules, all of them for the same reason — the person using this may be older, hard
 * of hearing, unsteady on their feet, and standing up while it talks:
 *
 *  - One status line, large, readable from across a room.
 *  - One question at a time, with the choices as buttons. Speech is an accelerator, never
 *    a requirement: recognition fails on accents, in noise, and on exactly these voices.
 *  - When consent is pending, the screen states plainly what is about to happen and shows
 *    Yes and No. A judge has to be able to *see* consent, not take our word for it.
 *  - The transcript is an aria-live region, so a screen reader announces the agent's turn
 *    without the user hunting for it.
 */

import { useEffect, useRef } from 'react';
import type { AgentTurn, CarePlan, CareSession } from '@careflow/shared';
import type { VoiceState } from '../lib/useVoice.js';

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

  // Keep the newest turn in view. Without this the most important line is the one off
  // the bottom of the box.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, voice.interim]);

  const state = session?.state;
  const awaitingConfirmation = state === 'awaiting_confirmation' && session?.pendingAction;
  // Prefer the session's stored options so a page reload keeps the buttons; the live turn
  // is only a faster path to the same list.
  const options = session?.options ?? lastTurn?.options ?? [];

  return (
    <>
      <section
        className={`status ${
          !session
            ? 'is-idle'
            : awaitingConfirmation
              ? 'is-confirming'
              : state === 'done' || state === 'cancelled'
                ? 'is-done'
                : ''
        }`}
        aria-labelledby="status-line"
      >
        <div className="status-line" id="status-line">
          {statusLine(session, voice)}
        </div>
        <div className="status-sub">{statusSub(session, voice, plan)}</div>

        {session?.mode === 'emergency_assist_prototype' && (
          <div>
            <span className="badge warn">Emergency assist · prototype</span>{' '}
            <span className="small muted">
              CareFlow does not detect emergencies and cannot contact emergency services.
            </span>
          </div>
        )}
      </section>

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {voice.error && (
        <p className="notice info" role="status">
          {voice.error}
        </p>
      )}

      {awaitingConfirmation && session?.pendingAction && (
        <section className="consent" aria-labelledby="consent-heading">
          <div className="consent-label" id="consent-heading">
            Your approval is needed
          </div>
          <div className="consent-action">
            CareFlow will {session.pendingAction.summary}.
          </div>
          {session.pendingAction.message && (
            <div className="small muted">Message: “{session.pendingAction.message}”</div>
          )}
          <div className="actions">
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

      <section className="card" aria-labelledby="transcript-heading">
        <header>
          <h2 id="transcript-heading">Conversation</h2>
          {lastTurn?.engine && (
            <span className="badge accent" title="Which engine produced the latest turn">
              {lastTurn.engine === 'bedrock' ? 'Amazon Bedrock' : 'Scripted fallback'}
            </span>
          )}
        </header>

        <div
          className="transcript"
          ref={transcriptRef}
          // polite rather than assertive: the agent's turn should be announced, but not
          // interrupt a screen reader mid-sentence.
          aria-live="polite"
          aria-atomic="false"
        >
          {!session && (
            <p className="muted">
              Nothing is happening right now. When someone comes to the door, CareFlow will
              explain what it sees and ask what you would like to do.
            </p>
          )}

          {session?.turns.map((turn) => (
            <div key={turn.turnId} className={`bubble ${turn.speaker === 'patient' ? 'patient' : 'agent'}`}>
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

      <section className="card" aria-labelledby="controls-heading">
        <header>
          <h2 id="controls-heading">What would you like to do?</h2>
          {voice.voiceSource && (
            <span className="badge" title="Where the spoken voice comes from">
              Voice: {voice.voiceSource === 'polly' ? 'Amazon Polly' : 'browser'}
            </span>
          )}
        </header>

        <div className="actions" style={{ marginBottom: 'var(--gap)' }}>
          <button
            className={`btn primary big ${voice.listening ? 'listening' : ''}`}
            onClick={voice.listening ? voice.stopListening : voice.startListening}
            disabled={busy || !session || voice.speaking}
            aria-pressed={voice.listening}
          >
            {voice.listening ? 'Listening… tap to stop' : 'Hold to speak'}
          </button>

          <button className="btn big" onClick={onRepeat} disabled={!session || voice.speaking}>
            Repeat that
          </button>
        </div>

        {!voice.recognitionAvailable && (
          <p className="small muted">
            This browser cannot listen, so use the buttons. Everything CareFlow can do is
            available here.
          </p>
        )}

        {/* The buttons are the real interface, not a fallback for when speech fails. */}
        {options.length > 0 && !awaitingConfirmation && (
          <div className="actions">
            {options.map((option) => (
              <button
                key={option.actionId}
                className="btn"
                onClick={() => onChoose(option.actionId)}
                disabled={busy}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 'var(--gap) 0' }} />

        <div className="actions">
          <button className="btn" onClick={onAskForHelp} disabled={busy}>
            I need help
          </button>
          <button
            className="btn"
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
  if (!session) return 'All quiet';

  if (session.state === 'awaiting_confirmation') return 'Waiting for your approval';
  if (session.state === 'done') return 'Done';
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
      ? `Next visit: ${new Date(next.startsAt).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        })}`
      : 'No more visits scheduled today.';
  }

  if (session.state === 'done' && session.results[0]) return session.results[0].detail;
  // The matcher's own reason, verbatim. If the system's explanation is not good enough to
  // show the user, it is not good enough.
  return session.match.reason;
}
