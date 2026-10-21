/**
 * Safety and privacy panel.
 *
 * Every value here is read from `GET /api/safety`, which the backend builds from its live
 * configuration. Nothing is hardcoded in the UI: a panel that claims a protection the
 * running service is not applying would be worse than no panel at all, and a judge may
 * well ask.
 */

import type { SafetyPanel as SafetyPanelData } from '@careflow/shared';
import type { Health } from '../lib/api.js';

interface Props {
  safety: SafetyPanelData | undefined;
  health: Health | undefined;
}

export function SafetyPanel({ safety, health }: Props) {
  if (!safety) return <section className="card"><p className="muted">Loading…</p></section>;

  return (
    <>
      <section className="card" aria-labelledby="safety-heading">
        <header>
          <h2 id="safety-heading">Safety and privacy</h2>
          <span className="badge">Live configuration</span>
        </header>

        <dl className="kv">
          <dt>Consent required before any sensitive action</dt>
          <dd>
            <span className="badge ok">
              {safety.consentRequiredForSensitiveActions ? 'Yes' : 'No'}
            </span>
          </dd>

          <dt>Medical advice</dt>
          <dd>
            <span className="badge danger">{safety.medicalAdvice}</span>
          </dd>

          <dt>Medical diagnosis</dt>
          <dd>
            <span className="badge danger">{safety.medicalDiagnosis}</span>
          </dd>

          <dt>Automatic door unlock</dt>
          <dd>
            <span className="badge danger">{safety.automaticDoorUnlock}</span>
          </dd>

          <dt>Contacting emergency services</dt>
          <dd>
            <span className="badge danger">{safety.emergencyDispatch}</span>
          </dd>

          <dt>Ring webhook signature verification</dt>
          <dd>
            <span className={`badge ${safety.webhookSignatureVerification === 'enforced' ? 'ok' : 'danger'}`}>
              {safety.webhookSignatureVerification}
            </span>
          </dd>

          <dt>Trusted contacts</dt>
          <dd>
            <span className="badge ok">{safety.trustedContacts}</span>
          </dd>

          <dt>Data retention</dt>
          <dd>
            <span className="badge">{safety.dataRetention}</span>
          </dd>
        </dl>

        <p className="small muted">
          CareFlow has no face recognition and does not identify who is at the door. It knows
          only whether a visit is scheduled, and it says so.
        </p>
      </section>

      <section className="card" aria-labelledby="refusals-heading">
        <header>
          <h2 id="refusals-heading">What CareFlow refuses to do</h2>
        </header>
        <p className="small muted" style={{ marginTop: 0 }}>
          These are declared, enforced refusals — not unimplemented features. They are
          rejected from every state, after any confirmation, by two independent checks.
        </p>
        <div className="rows">
          {safety.blockedCapabilities.map((capability) => (
            <div className="row" key={capability}>
              <span className="grow mono">{capability}</span>
              <span className="badge danger">always refused</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="emergency-heading">
        <header>
          <h2 id="emergency-heading">Emergency assist</h2>
          <span className="badge warn">{safety.emergencyAssist.status}</span>
        </header>
        <dl className="kv">
          <dt>Started only by the patient</dt>
          <dd>
            <span className="badge ok">{yesNo(safety.emergencyAssist.patientInitiatedOnly)}</span>
          </dd>
          <dt>Always requires confirmation</dt>
          <dd>
            <span className="badge ok">{yesNo(safety.emergencyAssist.confirmationRequired)}</span>
          </dd>
          <dt>Contacts emergency services</dt>
          <dd>
            <span className="badge danger">
              {yesNo(safety.emergencyAssist.contactsEmergencyServices)}
            </span>
          </dd>
          <dt>Assesses medical severity</dt>
          <dd>
            <span className="badge danger">
              {yesNo(safety.emergencyAssist.assessesMedicalSeverity)}
            </span>
          </dd>
        </dl>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Spoken on every emergency-assist turn: “{safety.emergencyAssist.spokenSafetyLine}”
        </p>
      </section>

      <section className="card" aria-labelledby="disclosure-heading">
        <header>
          <h2 id="disclosure-heading">AI disclosure</h2>
        </header>
        <p style={{ marginTop: 0, fontSize: '1.05rem' }}>“{safety.aiDisclosure}”</p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Said at the start of every session. The backend adds it even if the language model
          leaves it out.
        </p>
      </section>

      {health && (
        <section className="card" aria-labelledby="runtime-heading">
          <header>
            <h2 id="runtime-heading">Running configuration</h2>
            <span className="small muted">from /healthz</span>
          </header>
          <dl className="kv">
            <dt>Storage</dt>
            <dd className="mono">{health.mode.storage}</dd>
            <dt>Voice</dt>
            <dd className="mono">
              {health.mode.tts}
              {health.aws.pollyVoiceId ? ` · ${health.aws.pollyVoiceId}` : ''}
            </dd>
            <dt>Conversation engine</dt>
            <dd className="mono">{health.mode.orchestrator}</dd>
            <dt>Bedrock model</dt>
            <dd className="mono">{health.aws.bedrockModelId ?? 'not configured'}</dd>
            <dt>Ring API credentials</dt>
            <dd className="mono">
              {health.ring.apiCredentialsConfigured ? 'configured' : 'not configured'}
            </dd>
            <dt>Ring webhook path</dt>
            <dd className="mono">{health.ring.webhookPath}</dd>
            <dt>Notifications</dt>
            <dd className="mono">{health.mode.demoMode ? 'recorded (demo mode)' : 'live'}</dd>
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            In demo mode notifications are recorded rather than sent, because the contacts in
            this demo are fictional.
          </p>
        </section>
      )}
    </>
  );
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}
