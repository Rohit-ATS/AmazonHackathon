/**
 * App shell: four screens, the demo strip, and the accessibility controls.
 *
 * All conversation state lives on the server. The UI never decides what is allowed — it
 * renders what the backend says and sends what the patient chose. That is deliberate: a
 * consent check in the browser is a suggestion, since anyone can call the API directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CarePlan, CareSession, SafetyPanel as SafetyPanelData } from '@careflow/shared';
import { api, ApiError, type Health } from './lib/api.js';
import { useLive } from './lib/useLive.js';
import { useVoice } from './lib/useVoice.js';
import { PatientScreen } from './components/PatientScreen.js';
import { CaregiverDashboard } from './components/CaregiverDashboard.js';
import { Timeline } from './components/Timeline.js';
import { SafetyPanel } from './components/SafetyPanel.js';
import { DemoStrip } from './components/DemoStrip.js';
import { useReveal, useStuckHeader } from './lib/useReveal.js';

type Tab = 'patient' | 'caregiver' | 'timeline' | 'safety';

const TABS: { id: Tab; label: string }[] = [
  { id: 'patient', label: 'Patient' },
  { id: 'caregiver', label: 'Caregiver' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'safety', label: 'Safety' },
];

/**
 * An accessibility preference that is either explicitly chosen or not yet chosen.
 *
 * `undefined` means "the user has never said", which is distinct from "the user chose
 * off" — the care plan's own default only applies to the former. Storage is written only
 * when the user actually toggles, so nothing can silently turn "never said" into "off".
 * (An earlier version wrote on mount and StrictMode's double-invoked effects defeated the
 * skip-first-write guard, which is how a patient whose plan asks for large text got
 * normal text.)
 */
function usePreference(key: string) {
  const [chosen, setChosen] = useState<boolean | undefined>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? undefined : stored === 'true';
    } catch {
      // Private browsing, or storage blocked. Not a reason to fail.
      return undefined;
    }
  });

  const choose = useCallback(
    (value: boolean) => {
      setChosen(value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        /* storage blocked; the choice still applies for this visit */
      }
    },
    [key],
  );

  return [chosen, choose] as const;
}

export function App() {
  const [tab, setTab] = useState<Tab>('patient');
  const [plan, setPlan] = useState<CarePlan>();
  const [safety, setSafety] = useState<SafetyPanelData>();
  const [health, setHealth] = useState<Health>();
  const [sessions, setSessions] = useState<CareSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const [largeTextChoice, chooseLargeText] = usePreference('careflow.largeText');
  const [mutedChoice, chooseMuted] = usePreference('careflow.muted');

  // The patient's own plan decides large text until they say otherwise. A setting that
  // only helps once they have found it does not help the people who need it.
  const largeText = largeTextChoice ?? plan?.patient.preferences.largeTextDefault ?? false;
  /**
   * Voice is OFF until someone turns it on. A page that starts talking the moment it
   * loads is hostile — during development, during a demo rehearsal, and to anyone who
   * opens it next to a sleeping person. Press "Voice on" to hear it.
   */
  const muted = mutedChoice ?? true;

  // Scroll reveals and the sticky-header state. Both no-op under prefers-reduced-motion.
  useReveal();
  useStuckHeader();

  const live = useLive();
  const { session, timeline, lastTurn, connection, applySession, selectSession, refresh } = live;

  // --- accessibility: one multiplier scales the whole interface ----------
  useEffect(() => {
    const scale = largeText ? 1.35 : 1;
    document.documentElement.style.setProperty('--scale', String(scale));
  }, [largeText]);

  // --- reference data ----------------------------------------------------
  useEffect(() => {
    void Promise.allSettled([api.carePlan(), api.safety(), api.health()]).then(
      ([planResult, safetyResult, healthResult]) => {
        if (planResult.status === 'fulfilled') setPlan(planResult.value);
        if (safetyResult.status === 'fulfilled') setSafety(safetyResult.value);
        if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
        if (planResult.status === 'rejected') {
          setError('Cannot reach the CareFlow API. Is `npm run dev:api` running?');
        }
      },
    );
  }, []);

  const reloadSessions = useCallback(() => {
    void api.sessions(10).then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions, session?.updatedAt, timeline.length]);

  // --- speak each new agent turn ----------------------------------------
  const spokenTurnIds = useRef(new Set<string>());

  const voice = useVoice({
    locale: plan?.patient.preferences.locale ?? 'en-US',
    muted,
    onTranscript: (transcript) => void send(() => api.speak(session!.sessionId, transcript)),
  });

  const latestAgentTurn = useMemo(
    () => [...(session?.turns ?? [])].reverse().find((t) => t.speaker === 'agent'),
    [session],
  );

  useEffect(() => {
    if (!latestAgentTurn || muted) return;
    // Speak each turn once. Without the guard, every re-render or poll would repeat the
    // sentence, which is intolerable for someone relying on the audio.
    if (spokenTurnIds.current.has(latestAgentTurn.turnId)) return;
    spokenTurnIds.current.add(latestAgentTurn.turnId);
    void voice.speak(latestAgentTurn.text);
  }, [latestAgentTurn, muted, voice]);

  // --- actions ----------------------------------------------------------

  const send = useCallback(
    async (call: () => Promise<{ session: CareSession; turn: unknown }>) => {
      if (!session) return;
      setBusy(true);
      setError(undefined);
      try {
        const result = await call();
        applySession(result.session, result.turn as never);
      } catch (err) {
        // The backend's refusal messages are meaningful to a user, so show them rather
        // than a generic failure.
        setError(
          err instanceof ApiError
            ? err.message
            : 'Something went wrong. Nothing was sent. Please try again.',
        );
        await refresh().catch(() => {});
      } finally {
        setBusy(false);
      }
    },
    [session, applySession, refresh],
  );

  const onChoose = useCallback(
    (actionId: string) => void send(() => api.choose(session!.sessionId, actionId)),
    [send, session],
  );

  const onConfirm = useCallback(
    (affirmative: boolean) => void send(() => api.confirm(session!.sessionId, affirmative)),
    [send, session],
  );

  const onCancel = useCallback(
    () => void send(() => api.cancel(session!.sessionId)),
    [send, session],
  );

  const onRepeat = useCallback(() => {
    if (latestAgentTurn) void voice.speak(latestAgentTurn.text);
  }, [latestAgentTurn, voice]);

  const onAskForHelp = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.startEmergencyAssist();
      applySession(result.session);
      setTab('patient');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [applySession]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="app-header">
        <div className="brand">
          <span className="brand-dot" aria-hidden="true">
            CF
          </span>
          CareFlow
          <small>Voice-first care access with Ring</small>
        </div>

        <div className="header-controls">
          <span
            className={`badge ${connection === 'live' ? 'ok' : connection === 'polling' ? 'warn' : ''}`}
            title={
              connection === 'live'
                ? 'Live event stream connected'
                : connection === 'polling'
                  ? 'No event stream; polling the API instead'
                  : 'Connecting'
            }
          >
            {connection}
          </span>

          <button
            className="btn sm ghost"
            onClick={() => chooseLargeText(!largeText)}
            aria-pressed={largeText}
          >
            {largeText ? 'Normal text' : 'Larger text'}
          </button>

          {/* Labelled by the action it performs, not the state it is in. "Voice off" as a
              button is ambiguous — it reads as both a status and a command. */}
          <button
            className={`btn sm ${muted ? 'ghost' : 'primary'}`}
            onClick={() => chooseMuted(!muted)}
            aria-pressed={!muted}
          >
            {muted ? 'Turn voice on' : 'Turn voice off'}
          </button>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="CareFlow screens">
        {TABS.map((item) => (
          <button
            key={item.id}
            className="tab"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="main"
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main id="main" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1}>
        {tab === 'patient' && (
          <PatientScreen
            session={session}
            plan={plan}
            lastTurn={lastTurn}
            voice={voice}
            busy={busy}
            error={error}
            onChoose={onChoose}
            onConfirm={onConfirm}
            onCancel={onCancel}
            onRepeat={onRepeat}
            onAskForHelp={() => void onAskForHelp()}
          />
        )}

        {tab === 'caregiver' && (
          <CaregiverDashboard
            plan={plan}
            sessions={sessions}
            activeSessionId={session?.sessionId}
            onSelectSession={selectSession}
          />
        )}

        {tab === 'timeline' && <Timeline timeline={timeline} session={session} />}

        {tab === 'safety' && <SafetyPanel safety={safety} health={health} />}

        <DemoStrip
          busy={busy}
          onFired={() => {
            void refresh().catch(() => {});
            reloadSessions();
            setTab('patient');
          }}
        />
      </main>
    </div>
  );
}
