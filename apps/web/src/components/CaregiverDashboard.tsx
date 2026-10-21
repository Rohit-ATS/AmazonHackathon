/**
 * The caregiver dashboard.
 *
 * This is the screen that makes CareFlow read as a care product rather than a doorbell toy:
 * the person arriving at the door gets the patient's own words, the time they need, and the
 * non-clinical task they asked for — before they knock again.
 *
 * Deliberately non-clinical. No vitals, no medication lists, no assessments. A handoff note
 * saying "help organising medications" is coordination; anything resembling a dose would be
 * a different and much more dangerous product.
 */

import { useState } from 'react';
import type { CarePlan, CareSession } from '@careflow/shared';

interface Props {
  plan: CarePlan | undefined;
  sessions: CareSession[];
  activeSessionId: string | undefined;
  onSelectSession: (sessionId: string) => void;
}

export function CaregiverDashboard({ plan, sessions, activeSessionId, onSelectSession }: Props) {
  // Whose day you are looking at. Undefined is the whole team, which is the honest default
  // — nobody should have to pick a person before they can see what is happening.
  const [whoId, setWhoId] = useState<string>();

  const team = plan?.contacts ?? [];
  const who = team.find((c) => c.contactId === whoId);

  // Filtering is real: visits carry a contactId and sessions carry the contact they
  // matched, so choosing a person narrows the schedule and the handoffs to theirs.
  const visits = (plan?.visits ?? []).filter((v) => !whoId || v.contactId === whoId);
  const forWho = whoId
    ? sessions.filter((s) => s.match.contact?.contactId === whoId)
    : sessions;

  const active = forWho.find((s) => s.sessionId === activeSessionId) ?? forWho[0];
  const withHandoff = forWho.filter((s) => s.handoff);

  return (
    <>
      <section className="care-head" aria-labelledby="patient-heading" data-reveal="pop">
        <div className="care-id">
          <span className="care-avatar" aria-hidden="true">
            {initials(plan?.patient.displayName)}
          </span>
          <div className="care-id-text">
            <div className="eyebrow">Under your care</div>
            <h2 id="patient-heading">{plan?.patient.displayName ?? 'Loading…'}</h2>
            {plan?.patient.careContext && (
              <p className="care-context">
                {plan.patient.careContext.situation}
                {plan.patient.careContext.homeSince && (
                  <> · home since {formatDate(plan.patient.careContext.homeSince)}</>
                )}
              </p>
            )}
          </div>

          <div className="care-figures">
            <span className="care-figure">
              <strong>{visits.length}</strong> {visits.length === 1 ? 'visit' : 'visits'} today
            </span>
            <span className="care-figure">
              <strong>{withHandoff.length}</strong>{' '}
              {withHandoff.length === 1 ? 'handoff note' : 'handoff notes'}
            </span>
            <span className="badge">Demo data · fictional</span>
          </div>
        </div>

        {/*
          * The care team, as a filter. Choosing someone narrows the schedule, the active
          * event and the handoffs to them — it is a real filter over real data, not a
          * decorative picker, so a name with nothing today says so plainly.
          */}
        {team.length > 0 && (
          <div className="care-switch" role="group" aria-label="Whose day to show">
            <button
              type="button"
              className={`seg${whoId === undefined ? ' is-on' : ''}`}
              aria-pressed={whoId === undefined}
              onClick={() => setWhoId(undefined)}
            >
              Whole team
            </button>
            {team.map((contact) => (
              <button
                key={contact.contactId}
                type="button"
                className={`seg${whoId === contact.contactId ? ' is-on' : ''}`}
                aria-pressed={whoId === contact.contactId}
                onClick={() => setWhoId(contact.contactId)}
                title={contact.relationship ?? contact.role}
              >
                {contact.displayName}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="visits-heading" data-reveal>
        <header>
          <div>
            <div className="eyebrow">Schedule</div>
            <h2 id="visits-heading">Today’s visits</h2>
          </div>
        </header>
        <div className="rows">
          {visits.map((visit) => {
            const contact = team.find((c) => c.contactId === visit.contactId);
            const arrived = sessions.some(
              (s) => s.match.visit?.visitId === visit.visitId && s.state === 'done',
            );
            return (
              <div className="row" key={visit.visitId} data-reveal>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatTime(visit.startsAt)}–{formatTime(visit.endsAt)}
                </strong>
                <span className="grow">
                  {contact?.displayName ?? visit.contactId}
                  <span className="muted small"> · {visit.purpose}</span>
                </span>
                <span className={`badge ${arrived ? 'ok' : visit.status === 'completed' ? '' : 'accent'}`}>
                  {arrived ? 'arrived' : visit.status}
                </span>
              </div>
            );
          })}
          {visits.length === 0 && (
            <p className="muted">
              {who ? `No visits for ${who.displayName} today.` : 'No visits scheduled today.'}
            </p>
          )}
        </div>
      </section>

      <section className="card plain" aria-labelledby="active-heading" data-reveal="left">
        <header>
          <div>
            <div className="eyebrow">Right now</div>
            <h2 id="active-heading">Active event</h2>
          </div>
          {active && <span className="badge accent">{active.state.replace(/_/g, ' ')}</span>}
        </header>

        {!active && <p className="muted">No events yet today.</p>}

        {active && (
          <>
            <dl className="kv">
              <dt>What happened</dt>
              <dd>
                {describeEvent(active)} at the {active.event.deviceName.toLowerCase()}
              </dd>
              <dt>When</dt>
              <dd>{formatTime(active.event.occurredAt)}</dd>
              <dt>CareFlow’s read</dt>
              <dd>{active.match.status === 'scheduled' ? 'Scheduled visit' : 'Unexpected'}</dd>
              <dt>Source</dt>
              <dd>
                {active.event.source === 'ring'
                  ? 'Ring device'
                  : active.event.source === 'simulator'
                    ? 'Ring simulator'
                    : 'Patient'}
              </dd>
            </dl>
            <p className="small muted" style={{ marginBottom: 0 }}>
              {active.match.reason}
            </p>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="handoff-heading" data-reveal>
        <header>
          <div>
            <div className="eyebrow">Before you knock</div>
            <h2 id="handoff-heading">Handoff notes</h2>
          </div>
          <span className="badge">Non-clinical</span>
        </header>

        {withHandoff.length === 0 && (
          <p className="muted">
            Nothing to hand over yet. When the patient asks CareFlow to pass something on, it
            appears here.
          </p>
        )}

        <div className="rows">
          {withHandoff.map((session) => (
            <button
              key={session.sessionId}
              className="row"
              onClick={() => onSelectSession(session.sessionId)}
              data-reveal
              aria-current={session.sessionId === active?.sessionId}
            >
              <div className="grow">
                <div style={{ fontWeight: 600 }}>
                  {session.handoff?.readyInMinutes !== undefined
                    ? `Ready in ${session.handoff.readyInMinutes} minutes`
                    : 'Patient request'}
                </div>
                <div className="small">“{session.handoff?.request}”</div>
                {session.handoff?.note && (
                  <div className="small muted">Note for the visit: {session.handoff.note}</div>
                )}
                {session.results[0] && (
                  <div className="small muted">{session.results[0].detail}</div>
                )}
              </div>
              <span className="badge ok">consented</span>
              <time className="small muted">{formatTime(session.updatedAt)}</time>
            </button>
          ))}
        </div>
      </section>

      <section className="card plain" aria-labelledby="contacts-heading" data-reveal>
        <header>
          <div>
            <div className="eyebrow">Who CareFlow may contact</div>
            <h2 id="contacts-heading">Care team and contacts</h2>
          </div>
          <span className="badge">Patient-controlled</span>
        </header>
        <div className="rows">
          {plan?.contacts.map((contact) => (
            <div className="row" key={contact.contactId} data-reveal>
              <span className="grow">
                <strong>{contact.displayName}</strong>
                <span className="muted small"> · {contact.relationship ?? contact.role}</span>
              </span>
              <span className={`badge ${contact.notifiableOutsideVisits ? 'ok' : 'warn'}`}>
                {contact.notifiableOutsideVisits ? 'may be contacted' : 'not approved'}
              </span>
            </div>
          ))}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          The patient decides who CareFlow may contact. CareFlow refuses to notify anyone
          marked “not approved”, whatever it is asked to do.
        </p>
      </section>
    </>
  );
}

function describeEvent(session: CareSession): string {
  if (session.event.kind === 'doorbell') return 'Doorbell pressed';
  if (session.event.kind === 'patient_request') return 'Patient asked for help';
  if (session.event.kind === 'motion') {
    return session.event.subType === 'package'
      ? 'Package detected'
      : session.event.subType === 'human'
        ? 'Person detected'
        : 'Motion detected';
  }
  return session.event.ringType.replace(/_/g, ' ');
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/** Initials for the patient mark: two letters, or one for a single-word name. */
function initials(name: string | undefined): string {
  if (!name) return '–';
  const parts = name.trim().split(/\s+/);
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}
