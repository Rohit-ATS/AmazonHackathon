/**
 * Live state: the active session plus the timeline.
 *
 * Subscribes to the server's SSE stream, and falls back to polling when the stream is not
 * available — which is the case against the deployed Lambda, since there is nowhere to hold
 * a streaming connection. The UI treats SSE as an enhancement so the same build works
 * against either target, and the demo cannot be broken by picking the wrong URL.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTurn, CareSession, TimelineEntry } from '@careflow/shared';
import { api } from './api.js';

export type ConnectionState = 'connecting' | 'live' | 'polling';

export interface LiveState {
  session: CareSession | undefined;
  timeline: TimelineEntry[];
  /** The most recent agent turn, used to decide what to speak aloud. */
  lastTurn: AgentTurn | undefined;
  connection: ConnectionState;
  /** Replace the local session after a call that already returned the new state. */
  applySession: (session: CareSession, turn?: AgentTurn) => void;
  selectSession: (sessionId: string) => void;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 2000;

export function useLive(): LiveState {
  const [session, setSession] = useState<CareSession>();
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [lastTurn, setLastTurn] = useState<AgentTurn>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  // Held in a ref as well as state: the SSE handler needs the current id without being
  // re-created on every session change, which would reopen the stream mid-conversation.
  const pinnedId = useRef<string | undefined>(undefined);

  const applySession = useCallback((next: CareSession, turn?: AgentTurn) => {
    pinnedId.current = next.sessionId;
    setSession(next);
    if (turn) setLastTurn(turn);
  }, []);

  const refresh = useCallback(async () => {
    const [sessions, entries] = await Promise.all([api.sessions(10), api.timeline(60)]);
    setTimeline(entries);

    const current = pinnedId.current
      ? sessions.find((s) => s.sessionId === pinnedId.current) ??
        (await api.session(pinnedId.current).catch(() => undefined))
      : sessions[0];

    if (current) {
      pinnedId.current = current.sessionId;
      setSession(current);
    }
  }, []);

  const selectSession = useCallback(
    (sessionId: string) => {
      pinnedId.current = sessionId;
      void api.session(sessionId).then(setSession).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // --- SSE, with polling as the fallback ---------------------------------
  useEffect(() => {
    let source: EventSource | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const startPolling = () => {
      if (poll || cancelled) return;
      setConnection('polling');
      poll = setInterval(() => void refresh().catch(() => {}), POLL_INTERVAL_MS);
    };

    try {
      // Native EventSource cannot attach the configured bearer credential. In authenticated
      // local mode use the existing fetch-based polling path instead of a permanent 401 loop.
      if (sessionStorage.getItem('careflow.apiToken')) {
        startPolling();
        return () => { cancelled = true; if (poll) clearInterval(poll); };
      }
      source = new EventSource('/events/stream');

      source.addEventListener('open', () => {
        if (!cancelled) setConnection('live');
      });

      source.addEventListener('session', (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as {
          session: CareSession;
          turn: AgentTurn | null;
        };
        // A newly opened session takes focus; otherwise only updates for the session on
        // screen are applied, so a background event cannot yank the patient's view away
        // mid-sentence.
        const isNew = data.session.turns.length <= 1;
        if (isNew || data.session.sessionId === pinnedId.current) {
          pinnedId.current = data.session.sessionId;
          setSession(data.session);
          if (data.turn) setLastTurn(data.turn);
        }
      });

      source.addEventListener('timeline', (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as { entry: TimelineEntry };
        setTimeline((prev) =>
          prev.some((e) => e.entryId === data.entry.entryId) ? prev : [...prev, data.entry],
        );
      });

      source.addEventListener('error', () => {
        // EventSource retries on its own, but against a backend with no stream at all it
        // would retry forever and never update. Polling from the first error is the
        // behaviour that actually keeps the screen correct.
        startPolling();
      });
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [refresh]);

  return { session, timeline, lastTurn, connection, applySession, selectSession, refresh };
}
