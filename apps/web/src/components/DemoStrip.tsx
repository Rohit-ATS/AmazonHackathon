/**
 * Demo controls.
 *
 * Visually separated like a stage control, because it is not part of the product — it is
 * the thing that stands in for a physical Ring device.
 *
 * Each button asks the backend to sign a Ring webhook v1.1 payload and POST it to the real
 * `/ring/webhook` endpoint over HTTP. It is slower than calling the handler directly, and
 * that is the point: the demo exercises signature verification, the webhook route,
 * idempotency, and Ring's five-second budget exactly as a real delivery would. The exact
 * signed bytes come back and are shown here, so a judge can see the integration is real
 * rather than taking our word for it.
 */

import { useState } from 'react';
import { api, type DemoEventResponse } from '../lib/api.js';

interface Props {
  busy: boolean;
  onFired: () => void;
}

type Scenario = 'scheduled' | 'unexpected' | 'delivery';

const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  {
    id: 'scheduled',
    label: 'Scheduled caregiver arrives',
    hint: 'Doorbell press inside the current nursing visit window',
  },
  {
    id: 'unexpected',
    label: 'Unexpected visitor',
    hint: 'Doorbell press 45 minutes later, with no visit scheduled',
  },
  {
    id: 'delivery',
    label: 'Package delivered',
    hint: 'Package motion — logged, and deliberately does not start a conversation',
  },
];

export function DemoStrip({ busy, onFired }: Props) {
  const [last, setLast] = useState<DemoEventResponse>();
  const [pending, setPending] = useState<Scenario>();
  const [error, setError] = useState<string>();
  const [showProof, setShowProof] = useState(false);

  async function fire(scenario: Scenario) {
    setPending(scenario);
    setError(undefined);
    try {
      const result = await api.fireRingEvent(scenario);
      setLast(result);
      onFired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="demo-strip" aria-labelledby="demo-heading" data-reveal="pop">
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: '0.6rem',
          marginBottom: '1.1rem',
        }}
      >
        <div>
          <div className="eyebrow" style={{ color: 'var(--lime)' }}>
            Stands in for a Ring device
          </div>
          <h2 id="demo-heading">Demo controls</h2>
        </div>
        <span className="badge ok">Ring simulator</span>
      </header>

      <div className="hero-actions" style={{ marginTop: 0 }}>
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            className="btn"
            onClick={() => void fire(scenario.id)}
            disabled={busy || pending !== undefined}
            title={scenario.hint}
            data-reveal
          >
            {pending === scenario.id ? 'Sending…' : scenario.label}
          </button>
        ))}
      </div>

      <p className="small muted">
        These send genuinely signed Ring webhook v1.1 payloads to the real webhook endpoint,
        which verifies the HMAC-SHA256 signature before parsing anything. Swapping in live
        Ring credentials changes configuration, not code.
      </p>

      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}

      {last && (
        <>
          <div className="rows">
            <div className="row" data-reveal>
              <span className="grow">
                <strong>{last.scenario}</strong>{' '}
                <span className="muted small">{last.eventId}</span>
              </span>
              <span className={`badge ${last.webhookStatus < 400 ? 'ok' : 'danger'}`}>
                HTTP {last.webhookStatus}
              </span>
              <span className="badge">{last.latencyMs}ms</span>
            </div>
          </div>

          <button
            className="btn"
            onClick={() => setShowProof((v) => !v)}
            aria-expanded={showProof}
            style={{ marginTop: '0.6rem' }}
          >
            {showProof ? 'Hide' : 'Show'} the signed payload
          </button>

          {showProof && (
            <div style={{ marginTop: '0.6rem' }}>
              <p className="small muted" style={{ marginBottom: '0.2rem' }}>
                X-Signature header, computed over the raw body bytes:
              </p>
              <p className="mono" style={{ margin: '0 0 0.6rem' }}>
                {last.signature}
              </p>
              <p className="small muted" style={{ marginBottom: '0.2rem' }}>
                The exact bytes that were signed and sent:
              </p>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: '0.75rem',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {prettyJson(last.rawBody)}
              </pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
