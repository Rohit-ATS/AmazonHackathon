/**
 * The patient screen: one conversation, top to bottom.
 *
 * Status at the top, the conversation filling the middle, and a composer pinned at the
 * bottom from which the patient can speak or type. Everything the agent offers appears
 * inside the thread, at the point in the conversation where it was offered, rather than in
 * a separate panel the patient has to look away to find.
 *
 * The rules underneath are not negotiable:
 *
 *  - One status line, large, readable across a room. It stays pinned above the thread,
 *    because "what is happening right now" must not scroll away mid-conversation.
 *  - One question at a time, and the agent's choices are buttons in the thread. Speech is
 *    an accelerator, never a requirement — recognition fails on accents, in noise, and on
 *    exactly these voices. Typing is the third way in, for anyone who can do neither.
 *  - When consent is pending the thread shows a dark block stating plainly what is about to
 *    happen, with Yes and No. A judge has to be able to *see* consent, not take our word.
 *  - The thread is an aria-live log, so a screen reader announces the agent's turn.
 *
 * Free text goes to the same endpoint a spoken sentence does, so an instruction CareFlow
 * must refuse — "just unlock the door" — is refused in the thread, in its own words.
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentTurn, CarePlan, CareSession } from '@careflow/shared';
import type { VoiceState } from '../lib/useVoice.js';
import { useMicLevel } from '../lib/useMicLevel.js';
import { SiriOrb } from './SiriOrb.js';

interface Props {
  session: CareSession | undefined;
  plan: CarePlan | undefined;
  lastTurn: AgentTurn | undefined;
  voice: VoiceState;
  busy: boolean;
  error: string | undefined;
  onChoose: (actionId: string) => void;
  onSay: (text: string) => void;
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
  onSay,
  onConfirm,
  onCancel,
  onRepeat,
  onAskForHelp,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  // Explains, in the thread, why a message could not go anywhere yet.
  const [notice, setNotice] = useState<string>();
  const level = useMicLevel(voice.listening);

  // Keep the newest turn in view. Without this the most important line is the one just off
  // the bottom of the thread.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, voice.interim, session?.state]);

  const state = session?.state;
  const awaitingConfirmation = state === 'awaiting_confirmation' && session?.pendingAction;
  const options = session?.options ?? lastTurn?.options ?? [];
  const closed = state === 'done' || state === 'cancelled' || state === 'timed_out';
  // The bar is always usable. What changes is whether there is a conversation to deliver
  // into — CareFlow's sessions are opened by a door event or by the help button, and there
  // is no endpoint to start one from a typed line.
  const canDeliver = Boolean(session) && !busy && !closed;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;

    if (!canDeliver) {
      // Saying nothing would be worse than saying this. The line is a notice rather than an
      // agent bubble: the agent did not speak, and a message styled as its own words when
      // the backend never produced them would be a small lie in a product whose whole claim
      // is that the transcript is real.
      setNotice(
        closed
          ? 'That conversation has finished. CareFlow will start a new one the next time ' +
              'someone is at your door, or you can press “I need help”.'
          : 'CareFlow starts a conversation when someone is at your door. Press “I need ' +
              'help” below to start one now, and anything you type will go to it.',
      );
      return;
    }

    setNotice(undefined);
    setDraft('');
    onSay(text);
  }

  return (
    <section className="chat" aria-label="CareFlow conversation">
      {/*
        * The visible status header was removed so the screen is the conversation and
        * nothing else. A screen reader still needs to know what is happening, and that
        * cannot come from the thread alone — the status is a property of the session, not
        * of any one message — so the same sentence is announced from here instead.
        */}
      <p className="sr-only" role="status">
        {statusLine(session, voice)}. {statusSub(session, voice, plan)}
      </p>

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

      <div
        className="chat-log"
        ref={logRef}
        role="log"
        // polite, not assertive: the agent's turn should be announced without cutting a
        // screen reader off mid-sentence.
        aria-live="polite"
        aria-atomic="false"
      >
        {!session && (
          <div className="chat-empty">
            <p style={{ marginTop: 0 }}>
              Nothing is happening right now. When someone comes to the door, CareFlow will
              explain what it sees and ask what you would like to do — here, in this
              conversation.
            </p>
            <p className="small muted" style={{ marginBottom: 0 }}>
              You can also start one yourself with <strong>I need help</strong> below, which
              tells your care team you need them.
            </p>
          </div>
        )}

        {notice && (
          <p className="chat-notice" role="status">
            {notice}
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

        {awaitingConfirmation && session?.pendingAction && (
          <div className="consent" aria-labelledby="consent-heading">
            <div className="consent-label" id="consent-heading">
              Your approval is needed
            </div>
            <div className="consent-action">CareFlow will {session.pendingAction.summary}.</div>
            {session.pendingAction.message && (
              <div className="small muted">Message: “{session.pendingAction.message}”</div>
            )}
            <div className="chat-actions">
              <button
                type="button"
                className="btn yes big"
                onClick={() => onConfirm(true)}
                disabled={busy}
              >
                Yes, do that
              </button>
              <button
                type="button"
                className="btn no big"
                onClick={() => onConfirm(false)}
                disabled={busy}
              >
                No, don’t
              </button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Nothing has been sent yet. Nothing happens until you say yes.
            </p>
          </div>
        )}

        {/* The offered choices live in the thread, under the turn that offered them. The
            buttons are the real interface, not a fallback for when speech fails. The
            approval block does not: it sits below the thread, in a constant place, so it
            cannot scroll out of view while someone is reading it. */}
        {options.length > 0 && !awaitingConfirmation && !closed && (
          <div className="chat-actions">
            {options.map((option, i) => (
              <button
                key={option.actionId}
                className={`btn ${i === 0 ? 'lime' : ''}`}
                onClick={() => onChoose(option.actionId)}
                disabled={busy}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

      </div>

      {/*
        * While the microphone is open the orb takes the screen. It is the clearest possible
        * answer to "is it hearing me?" for someone who cannot read a small label, and it
        * doubles as the recording indicator — it is on screen exactly as long as the
        * microphone is, and the words heard so far sit underneath it.
        */}
      {voice.listening && (
        <div className="listening" role="dialog" aria-label="Listening">
          <SiriOrb size="176px" level={level} />
          <p className="listening-text">
            {voice.interim ? `“${voice.interim}…”` : 'Listening… just say what you need.'}
          </p>
          <button type="button" className="btn big" onClick={voice.stopListening}>
            Stop listening
          </button>
        </div>
      )}

      <div className="composer">
        <form className="composer-row" onSubmit={submit}>
          <label className="sr-only" htmlFor="say">
            Type what you would like CareFlow to do
          </label>
          <input
            id="say"
            className="composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Tell CareFlow what to do…"
            autoComplete="off"
          />

          <button
            type="button"
            className={`mic${voice.listening ? ' is-live' : ''}`}
            onClick={voice.listening ? voice.stopListening : voice.startListening}
            disabled={busy || voice.speaking || !voice.recognitionAvailable}
            aria-pressed={voice.listening}
            aria-label={voice.listening ? 'Stop listening' : 'Speak instead of typing'}
            title={
              voice.recognitionAvailable
                ? 'Speak instead of typing'
                : 'This browser cannot listen — type, or use the buttons'
            }
          >
            <MicIcon />
          </button>

          <button type="submit" className="btn" disabled={busy || draft.trim() === ''}>
            Send
          </button>
        </form>

        <div className="composer-tools">
          <button className="btn sm ghost" onClick={onRepeat} disabled={!session || voice.speaking}>
            Repeat that
          </button>
          <button className="btn sm ghost" onClick={onAskForHelp} disabled={busy}>
            I need help
          </button>
          <button className="btn sm ghost" onClick={onCancel} disabled={busy || !session || closed}>
            Cancel
          </button>
          {session?.mode === 'emergency_assist_prototype' && (
            <span
              className="badge warn"
              title="CareFlow does not detect emergencies and cannot contact emergency services."
            >
              Emergency assist · prototype
            </span>
          )}
          {voice.voiceSource && (
            <span className="badge" title="Where the spoken voice comes from">
              Voice: {voice.voiceSource === 'polly' ? 'Amazon Polly' : 'browser'}
            </span>
          )}
          {lastTurn?.engine && (
            <span className="badge accent" title="Which engine produced the latest turn">
              {lastTurn.engine === 'bedrock' ? 'Amazon Bedrock' : 'Scripted fallback'}
            </span>
          )}
        </div>

        <p className="small muted" style={{ margin: '0.1rem 0 0' }}>
          “I need help” tells your care team you need them. It does not contact emergency
          services — for an emergency, call them directly.
        </p>
      </div>
    </section>
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

/**
 * Mic glyph, inline. A whole icon package for one shape would be the largest dependency in
 * the app; this is the same rounded capsule and stand as the reference.
 */
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
