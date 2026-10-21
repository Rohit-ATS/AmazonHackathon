/**
 * Safety and privacy panel.
 *
 * Every value here is read from `GET /api/safety`, which the backend builds from its live
 * configuration. Nothing is hardcoded in the UI: a panel that claims a protection the
 * running service is not applying would be worse than no panel at all, and a judge may
 * well ask.
 *
 * Each setting is shown as a real control with all of its options visible and the current
 * one marked, rather than a badge — so it is obvious what the alternatives are and which
 * one is in force.
 *
 * Every option is also selectable rather than greyed out, and choosing an unavailable one
 * explains why it is unavailable. That is deliberate on both counts:
 *
 *  - These are not preferences. "Automatic door unlock: disabled" is not something someone
 *    switched off; it is a capability the API's consent gate and the open-source consent
 *    engine both refuse from every state, after any confirmation. A control that appeared
 *    to turn it on would be claiming something the server would refuse to do — and the
 *    safety story is the part of this product that has to be true.
 *  - A disabled control cannot take focus, so a keyboard or screen-reader user would never
 *    learn the option exists. `aria-disabled` keeps it reachable and announced, and the
 *    explanation is the response to activating it.
 *
 * Making any of these genuinely writable needs a write endpoint on the API — `/api/safety`
 * is read-only today — which is the backend's to add, not this app's.
 */

import { useState } from 'react';
import type { SafetyPanel as SafetyPanelData } from '@careflow/shared';
import type { Health } from '../lib/api.js';

interface Props {
  safety: SafetyPanelData | undefined;
  health: Health | undefined;
}

interface Choice {
  value: string;
  label: string;
}

const ON_OFF: Choice[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const ENABLED: Choice[] = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

export function SafetyPanel({ safety, health }: Props) {
  // Which setting has its explanation open. One at a time: a panel where every row is
  // expanded is just the wall of text this replaced.
  const [explained, setExplained] = useState<string>();

  if (!safety)
    return (
      <section className="card">
        <p className="muted">Loading…</p>
      </section>
    );

  const setting = (
    id: string,
    label: string,
    choices: Choice[],
    value: string,
    why: string,
  ) => (
    <Setting
      key={id}
      id={id}
      label={label}
      choices={choices}
      value={value}
      why={why}
      open={explained === id}
      onOpen={() => setExplained(explained === id ? undefined : id)}
    />
  );

  return (
    <>
      <section className="card" aria-labelledby="safety-heading" data-reveal="pop">
        <header>
          <div>
            <div className="eyebrow">Read from the running service</div>
            <h2 id="safety-heading">Safety and privacy</h2>
          </div>
          <span className="badge ok">Live configuration</span>
        </header>

        <div className="settings">
          {setting(
            'consent',
            'Consent required before any sensitive action',
            ON_OFF,
            safety.consentRequiredForSensitiveActions ? 'on' : 'off',
            'Consent is the product, not a preference. The API’s consent gate and the ' +
              'open-source consent engine each reject any sensitive action that was not ' +
              'explicitly approved, and they check independently — so there is no state in ' +
              'which this can be off.',
          )}

          {setting(
            'advice',
            'Medical advice',
            ENABLED,
            safety.medicalAdvice,
            'CareFlow is not a medical device and offers no clinical opinion. Asked a ' +
              'medical question, it says so and offers to pass the question to the care ' +
              'team instead.',
          )}

          {setting(
            'diagnosis',
            'Medical diagnosis',
            ENABLED,
            safety.medicalDiagnosis,
            'Same boundary as medical advice. Interpreting symptoms is a clinician’s job, ' +
              'and a confident wrong answer here is the most harmful thing this product ' +
              'could do.',
          )}

          {setting(
            'unlock',
            'Automatic door unlock',
            ENABLED,
            safety.automaticDoorUnlock,
            'There is nothing to switch on: CareFlow holds no door credentials at all. The ' +
              'Ring scope it requests is read-only, so the inability to open your door is a ' +
              'property of the integration rather than a setting on top of it.',
          )}

          {setting(
            'dispatch',
            'Contacting emergency services',
            ENABLED,
            safety.emergencyDispatch,
            'CareFlow never calls emergency services on someone’s behalf, and never decides ' +
              'on its own that someone needs help. It can tell the care team, after the ' +
              'patient has asked it to and confirmed.',
          )}

          {setting(
            'signature',
            'Ring webhook signature verification',
            [
              { value: 'enforced', label: 'Enforced' },
              { value: 'disabled', label: 'Off' },
            ],
            safety.webhookSignatureVerification,
            'Every delivery is checked against an HMAC-SHA256 signature over the raw body ' +
              'bytes before anything is parsed; wrongly signed and unsigned deliveries are ' +
              'rejected with 401. Turning this off would let anyone start a conversation ' +
              'inside someone’s home.',
          )}

          {setting(
            'contacts',
            'Trusted contacts',
            [
              { value: 'patient-controlled', label: 'Patient-controlled' },
              { value: 'agent-controlled', label: 'Agent-controlled' },
            ],
            safety.trustedContacts,
            'The patient owns this list. A contact marked not-notifiable outside visit ' +
              'hours is never contacted, and the agent cannot route around that — it is ' +
              'enforced in the API, not left to the model’s judgement.',
          )}

          {setting(
            'retention',
            'Data retention',
            [
              { value: 'demo-mode', label: 'Demo mode' },
              { value: 'configured', label: 'Configured' },
            ],
            safety.dataRetention,
            'Reported by the running service rather than chosen in the app. In demo mode ' +
              'nothing is written to a durable store beyond the local state file, and the ' +
              'contacts in this demo are fictional.',
          )}
        </div>

        <p className="small muted">
          CareFlow has no face recognition and does not identify who is at the door. It knows
          only whether a visit is scheduled, and it says so.
        </p>
      </section>

      <section className="panel-dark" aria-labelledby="refusals-heading" data-reveal>
        <header style={{ marginBottom: '0.8rem' }}>
          <div className="eyebrow" style={{ color: 'var(--lime)' }}>
            Declared limits
          </div>
          <h2 id="refusals-heading">What CareFlow refuses to do</h2>
        </header>
        <p className="small muted" style={{ marginTop: 0 }}>
          These are declared, enforced refusals — not unimplemented features. They are
          rejected from every state, after any confirmation, by two independent checks.
        </p>
        <div className="rows">
          {safety.blockedCapabilities.map((capability) => (
            <div className="row" key={capability} data-reveal>
              <span className="grow mono">{capability}</span>
              <span className="badge danger">always refused</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card plain" aria-labelledby="emergency-heading" data-reveal>
        <header>
          <div>
            <div className="eyebrow">Shown separately in the demo</div>
            <h2 id="emergency-heading">Emergency assist</h2>
          </div>
          <span className="badge warn">{safety.emergencyAssist.status}</span>
        </header>

        <div className="settings">
          {setting(
            'ea-patient',
            'Started only by the patient',
            ON_OFF,
            safety.emergencyAssist.patientInitiatedOnly ? 'on' : 'off',
            'CareFlow never starts this flow itself. Deciding that someone is in trouble is ' +
              'exactly the judgement this product refuses to make.',
          )}
          {setting(
            'ea-confirm',
            'Always requires confirmation',
            ON_OFF,
            safety.emergencyAssist.confirmationRequired ? 'on' : 'off',
            'Nothing is sent until the patient says yes, in the same consent gate every ' +
              'other action passes through.',
          )}
          {setting(
            'ea-dispatch',
            'Contacts emergency services',
            ON_OFF,
            safety.emergencyAssist.contactsEmergencyServices ? 'on' : 'off',
            'It does not, and the spoken line says so every time. Someone who needs an ' +
              'ambulance must not be left believing an app has called one.',
          )}
          {setting(
            'ea-severity',
            'Assesses medical severity',
            ON_OFF,
            safety.emergencyAssist.assessesMedicalSeverity ? 'on' : 'off',
            'No triage, no severity score, no judgement about how urgent this is. It relays ' +
              'that the patient asked for help, and says that is all it did.',
          )}
        </div>

        <p className="small muted" style={{ marginBottom: 0 }}>
          Spoken on every emergency-assist turn: “{safety.emergencyAssist.spokenSafetyLine}”
        </p>
      </section>

      <section className="hero" aria-labelledby="disclosure-heading" data-reveal="pop">
        <div className="hero-label">Said at the start of every session</div>
        <h2 id="disclosure-heading" style={{ fontSize: 'clamp(1.4rem, 1rem + 1.8vw, 2.2rem)' }}>
          “{safety.aiDisclosure}”
        </h2>
        <p className="hero-sub" style={{ marginBottom: 0 }}>
          The backend adds it even if the language model leaves it out.
        </p>
      </section>

      {health && (
        <section className="card plain" aria-labelledby="runtime-heading" data-reveal>
          <header>
            <div>
              <div className="eyebrow">from /healthz</div>
              <h2 id="runtime-heading">Running configuration</h2>
            </div>
          </header>
          {/* Observations about the process, not settings — so these stay plain readouts. */}
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

interface SettingProps {
  id: string;
  label: string;
  choices: Choice[];
  value: string;
  why: string;
  open: boolean;
  onOpen: () => void;
}

/**
 * One setting: its label, every option it has, and which one is in force.
 *
 * The options use `aria-disabled` rather than `disabled` so they stay focusable and are
 * announced as unavailable — a `disabled` button is invisible to keyboard and screen-reader
 * users, who would never discover the option exists. Activating an unavailable option opens
 * the explanation rather than silently doing nothing.
 */
function Setting({ id, label, choices, value, why, open, onOpen }: SettingProps) {
  return (
    <div className="setting">
      <div className="setting-head">
        <span className="setting-label" id={`${id}-label`}>
          {label}
        </span>

        <span className="segmented" role="group" aria-labelledby={`${id}-label`}>
          {choices.map((choice) => {
            const current = choice.value === value;
            return (
              <button
                key={choice.value}
                type="button"
                className={`seg${current ? ' is-on' : ''}`}
                aria-pressed={current}
                aria-disabled={!current}
                onClick={onOpen}
                title={current ? 'In force now' : 'Not available — enforced by the service'}
              >
                {choice.label}
              </button>
            );
          })}
        </span>
      </div>

      <button className="lock-toggle" onClick={onOpen} aria-expanded={open} aria-controls={`${id}-why`}>
        <span className="lock" aria-hidden="true">
          🔒
        </span>
        {open ? 'Hide why' : 'Enforced by the service — why?'}
      </button>

      {open && (
        <p className="setting-why" id={`${id}-why`}>
          {why}
        </p>
      )}
    </div>
  );
}
