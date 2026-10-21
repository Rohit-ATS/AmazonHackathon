/**
 * Event timeline and audit trail.
 *
 * This is the screen that proves the system is auditable. Every AI decision shows *why*,
 * in the matcher's own words, and every consent and refusal is on the record. A safety
 * property nobody can inspect is indistinguishable from one that does not exist.
 */

import { useEffect, useState } from 'react';
import type { AuditRecord, CareSession, TimelineEntry } from '@careflow/shared';
import { api } from '../lib/api.js';

interface Props {
  timeline: TimelineEntry[];
  session: CareSession | undefined;
}

const KIND_LABEL: Record<string, string> = {
  ring_event: 'Ring',
  ai_decision: 'CareFlow decided',
  patient_choice: 'Patient',
  consent: 'Consent',
  action: 'Action',
  refusal: 'Refused',
};

/** How many of the most recent entries a windowed timeline shows. */
const RECENT = 10;

export function Timeline({ timeline, session }: Props) {
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  // The timeline grows all day. Open but windowed is the useful default: the newest
  // entries are what anyone is actually looking for, and the rest stay one click away
  // instead of pushing the audit trail hundreds of rows down the page.
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const sessionId = session?.sessionId;

  useEffect(() => {
    if (!sessionId) {
      setAudit([]);
      return;
    }
    let cancelled = false;
    void api
      .audit(sessionId)
      .then((rows) => {
        if (!cancelled) setAudit(rows);
      })
      .catch(() => {
        if (!cancelled) setAudit([]);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch as the session progresses, so the audit view keeps up with the conversation.
  }, [sessionId, session?.turns.length, session?.state]);

  const ordered = [...timeline].sort((a, b) => a.at.localeCompare(b.at));
  const hidden = Math.max(0, ordered.length - RECENT);
  const visible = showAll ? ordered : ordered.slice(-RECENT);

  return (
    <>
      <section className="card" aria-labelledby="timeline-heading" data-reveal>
        <header>
          <div>
            <div className="eyebrow">Everything, in order</div>
            <h2 id="timeline-heading">Event timeline</h2>
          </div>
          <div className="header-actions">
            <span className="badge">{ordered.length} entries today</span>
            {open && hidden > 0 && (
              <button className="btn sm ghost" onClick={() => setShowAll(!showAll)}>
                {showAll ? `Show last ${RECENT}` : `Show all ${ordered.length}`}
              </button>
            )}
            <button
              className="btn sm ghost"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              aria-controls="timeline-list"
            >
              {open ? 'Hide' : 'Show'}
            </button>
          </div>
        </header>

        {ordered.length === 0 && (
          <p className="muted">Nothing has happened yet today.</p>
        )}

        {/* Closed, the section still reports what it holds — a collapsed panel that says
            nothing makes the reader open it just to find out whether it mattered. */}
        {!open && ordered.length > 0 && (
          <p className="timeline-summary">
            <span>
              {ordered.length} entries, most recently{' '}
              <strong>{formatTime(ordered[ordered.length - 1]!.at)}</strong>.
            </span>
            <button className="btn sm ghost" onClick={() => setOpen(true)}>
              Show the timeline
            </button>
          </p>
        )}

        {open && hidden > 0 && !showAll && (
          <p className="timeline-summary" style={{ marginBottom: '1rem' }}>
            <span>Showing the {RECENT} most recent of {ordered.length}.</span>
            <button className="btn sm ghost" onClick={() => setShowAll(true)}>
              Show {hidden} earlier
            </button>
          </p>
        )}

        <ul
          className={`timeline${showAll ? ' is-compact' : ''}`}
          id="timeline-list"
          hidden={!open}
        >
          {visible.map((entry) => (
            <li key={entry.entryId} data-reveal>
              <time dateTime={entry.at}>{formatTime(entry.at)}</time>
              <span className="rail" aria-hidden="true">
                {/* `k-` namespaced: entry.kind is server data, and dropping it bare into the
                    class namespace let `.consent` — the patient screen's panel class — style
                    this dot and cover the entry text. */}
                <span className={`dot k-${entry.kind}`} />
              </span>
              <div>
                <div className="text">
                  <span className="badge" style={{ marginRight: '0.5rem' }}>
                    {KIND_LABEL[entry.kind] ?? entry.kind}
                  </span>
                  {entry.text}
                </div>
                {entry.detail && <div className="detail">{entry.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel-dark" aria-labelledby="audit-heading" data-reveal="pop">
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '0.6rem',
            marginBottom: '1.2rem',
          }}
        >
          <div>
            <div className="eyebrow" style={{ color: 'var(--lime)' }}>
              Provable, not promised
            </div>
            <h2 id="audit-heading">Consent audit trail</h2>
          </div>
          {session && <span className="badge mono">{session.sessionId.slice(0, 8)}</span>}
        </header>

        {!session && <p className="muted">Select an event to see its audit trail.</p>}
        {session && audit.length === 0 && <p className="muted">No audit records yet.</p>}

        <div className="rows">
          {audit.map((record) => (
            <div className="row" key={record.auditId} data-reveal>
              <time className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTime(record.at)}
              </time>
              <span className="grow mono">{record.event}</span>
              {(record.from || record.to) && (
                <span className="small muted">
                  {record.from ?? '—'} → {record.to ?? '—'}
                </span>
              )}
              <span className={`badge ${badgeFor(record.event)}`}>{record.actor}</span>
            </div>
          ))}
        </div>

        {session?.consent !== undefined && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            A second, independent record is kept by the open-source consent engine, which
            enforces the same rules on its own. Both have to agree before anything is sent.
          </p>
        )}
      </section>
    </>
  );
}

function badgeFor(event: string): string {
  if (event.startsWith('action_refused')) return 'danger';
  if (event === 'consent_granted' || event.startsWith('action_executed')) return 'ok';
  if (event === 'consent_declined') return 'warn';
  return '';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
