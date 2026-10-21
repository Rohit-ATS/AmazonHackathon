/**
 * App shell: four screens, the demo strip, and the accessibility controls.
 *
 * All conversation state lives on the server. The UI never decides what is allowed — it
 * renders what the backend says and sends what the patient chose. That is deliberate: a
 * consent check in the browser is a suggestion, since anyone can call the API directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CarePlan, CareSession, SafetyPanel as SafetyPanelData } from '@careflow/shared';
import { api, ApiError, setApiToken, type Health, type McpPendingApproval } from './lib/api.js';
import { useLive } from './lib/useLive.js';
import {
  isOfflineMode,
  OFFLINE_CARE_PLAN,
  OFFLINE_HEALTH,
  OFFLINE_SAFETY,
  OFFLINE_SESSIONS,
  OFFLINE_TIMELINE,
} from './lib/offlineStub.js';
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
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [mcpPending, setMcpPending] = useState<McpPendingApproval[]>([]);
  const [offline, setOffline] = useState(false);

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
    if (isOfflineMode()) {
      setPlan(OFFLINE_CARE_PLAN);
      setSafety(OFFLINE_SAFETY);
      setHealth(OFFLINE_HEALTH);
      setSessions(OFFLINE_SESSIONS);
      setOffline(true);
      return;
    }
    void Promise.allSettled([api.carePlan(), api.safety(), api.health()]).then(
      ([planResult, safetyResult, healthResult]) => {
        if (planResult.status === 'fulfilled') setPlan(planResult.value);
        if (safetyResult.status === 'fulfilled') setSafety(safetyResult.value);
        if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
        if (planResult.status === 'rejected') {
          if (planResult.reason instanceof ApiError && planResult.reason.status === 401) {
            setAuthRequired(true);
          } else {
            setError('Cannot reach the CareFlow API. Is `npm run dev:api` running?');
          }
        }
      },
    );
  }, []);

  useEffect(() => {
    if (authRequired || offline) return;
    const load = () => void api.pendingMcpActions().then(setMcpPending).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [authRequired, offline]);

  const reloadSessions = useCallback(() => {
    if (offline) return;
    void api.sessions(10).then(setSessions).catch(() => {});
  }, [offline]);

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
      if (!session) {
        // Silently doing nothing is the worst failure here: the patient presses Yes, the
        // screen does not move, and they cannot tell whether it was sent.
        setError('That conversation is no longer active. Nothing was sent.');
        return;
      }
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

  /** Send free text as a patient turn — the same path a spoken sentence takes. */
  const onSay = useCallback(
    (text: string) => void send(() => api.speak(session!.sessionId, text)),
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

  const onMcpApproval = useCallback(async (item: McpPendingApproval, affirmative: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.approveMcpAction(item.confirmationId, affirmative);
      setMcpPending((current) => current.filter((pending) => pending.confirmationId !== item.confirmationId));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (authRequired) {
    return (
      <main className="auth-shell">
        <form
          className="auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tokenDraft.trim()) return;
            setApiToken(tokenDraft);
            window.location.reload();
          }}
        >
          <span className="brand-dot" aria-hidden="true">CF</span>
          <h1>Open CareFlow</h1>
          <p>Enter the household access token provided by your care coordinator.</p>
          <label htmlFor="access-token">Access token</label>
          <input id="access-token" type="password" autoComplete="current-password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} />
          <button className="btn lime big" type="submit" disabled={!tokenDraft.trim()}>Continue</button>
        </form>
      </main>
    );
  }

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
            className={`badge ${connection === 'live' ? 'ok' : connection === 'polling' ? 'warn' : offline ? '' : ''}`}
            title={
              offline
                ? 'Preview mode — no backend connected'
                : connection === 'live'
                  ? 'Live event stream connected'
                  : connection === 'polling'
                    ? 'No event stream; polling the API instead'
                    : 'Connecting'
            }
          >
            {offline ? 'preview' : connection}
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
        {offline && (
          <section className="notice info" role="status" style={{ textAlign: 'center' }}>
            <strong>Preview mode</strong> — this is the CareFlow interface with sample data.
            Connect a backend API to enable live conversations, Ring integration, and voice.
          </section>
        )}
        {mcpPending.map((item) => (
          <section className="consent mcp-consent" aria-label="Companion approval" key={item.confirmationId}>
            <div className="consent-label">Your companion is asking for approval</div>
            <div className="consent-action">CareFlow will {item.summary}.</div>
            {item.message && <div className="small muted">Message: “{item.message}”</div>}
            <div className="chat-actions">
              <button className="btn yes big" disabled={busy} onClick={() => void onMcpApproval(item, true)}>Yes, do that</button>
              <button className="btn no big" disabled={busy} onClick={() => void onMcpApproval(item, false)}>No, don’t</button>
            </div>
            <p className="small muted">This request expires at {new Date(item.expiresAt).toLocaleTimeString()}.</p>
          </section>
        ))}
        {tab === 'patient' && (
          <PatientScreen
            session={session}
            plan={plan}
            lastTurn={lastTurn}
            voice={voice}
            busy={busy}
            error={error}
            onChoose={onChoose}
            onSay={onSay}
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

        {tab === 'timeline' && <Timeline timeline={offline ? OFFLINE_TIMELINE : timeline} session={session} />}

        {tab === 'safety' && <SafetyPanel safety={safety} health={health} />}

        {!offline && (
          <DemoStrip
            busy={busy}
            onFired={() => {
              void refresh().catch(() => {});
              reloadSessions();
              setTab('patient');
            }}
          />
        )}
      </main>
    </div>
  );
}
