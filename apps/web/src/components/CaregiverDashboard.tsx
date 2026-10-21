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

import type { CarePlan, CareSession } from '@careflow/shared';

interface Props {
  plan: CarePlan | undefined;
  sessions: CareSession[];
  activeSessionId: string | undefined;
  onSelectSession: (sessionId: string) => void;
}

export function CaregiverDashboard({ plan, sessions, activeSessionId, onSelectSession }: Props) {
  const active = sessions.find((s) => s.sessionId === activeSessionId) ?? sessions[0];
  const withHandoff = sessions.filter((s) => s.handoff);

  return (
    <>
      <section className="panel-dark" aria-labelledby="patient-heading" data-reveal="pop">
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: '0.6rem',
          }}
        >
          <div className="eyebrow" style={{ color: 'var(--lime)' }}>
            Under your care
          </div>
          <span className="badge">Demo data · fictional</span>
        </header>
        {plan ? (
          <>
            <h2
              id="patient-heading"
              style={{ fontSize: 'clamp(1.8rem, 1.2rem + 2.4vw, 3rem)', marginTop: '0.4rem' }}
            >
              {plan.patient.displayName}
            </h2>
            {plan.patient.careContext && (
              <p className="muted" style={{ margin: '0.6rem 0 0', maxWidth: '52ch' }}>
                {plan.patient.careContext.situation}
                {plan.patient.careContext.homeSince && (
                  <> · home since {formatDate(plan.patient.careContext.homeSince)}</>
                )}
              </p>
            )}
            <div
              style={{
                display: 'grid',
                // Narrower track than .grid-2 so the two figures sit side by side inside
                // the panel rather than stacking.
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9rem), auto))',
                gap: '1.6rem 2.6rem',
                marginTop: '1.8rem',
                justifyContent: 'start',
              }}
            >
              <div className="stat">
                <span className="value" style={{ color: 'var(--lime)' }}>
                  {plan.visits.length}
                </span>
                <span className="label" style={{ color: 'rgb(255 255 255 / 62%)' }}>
                  visits scheduled today
                </span>
              </div>
              <div className="stat">
                <span className="value" style={{ color: 'var(--lime)' }}>
                  {sessions.filter((s) => s.handoff).length}
                </span>
                <span className="label" style={{ color: 'rgb(255 255 255 / 62%)' }}>
                  handoff notes waiting
                </span>
              </div>
            </div>
          </>
        ) : (
          <p className="muted">Loading…</p>
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
          {plan?.visits.map((visit, i) => {
            const contact = plan.contacts.find((c) => c.contactId === visit.contactId);
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
          {plan?.visits.length === 0 && <p className="muted">No visits scheduled today.</p>}
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
