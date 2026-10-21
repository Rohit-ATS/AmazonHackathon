/**
 * Typed API client.
 *
 * Every path is relative: Vite proxies to the API in dev, and a static deployment sits
 * behind the same host. That means there is no base URL to configure, and no chance of the
 * demo pointing at the wrong backend.
 *
 * The types come from `@careflow/shared`, so a backend change that breaks the frontend
 * breaks the typecheck rather than the demo.
 */

import type {
  AgentTurn,
  AuditRecord,
  CarePlan,
  CareSession,
  SafetyPanel,
  TimelineEntry,
} from '@careflow/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem('careflow.apiToken');
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!res.ok) {
    // Surface the backend's own code and message. The consent gate's refusals are
    // meaningful to a user ("that isn't something I'm able to do"), so swallowing them
    // behind a generic error would throw away the most useful part.
    let code = 'http_error';
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      // Not JSON; keep the raw text.
    }
    throw new ApiError(res.status, code, message);
  }

  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface TurnResponse {
  session: CareSession;
  turn: AgentTurn;
}

export interface DemoEventResponse {
  ok: boolean;
  scenario: string;
  eventId: string;
  webhookStatus: number;
  signature: string;
  /** The exact bytes that were signed and sent. Shown in the UI as integration proof. */
  rawBody: string;
  latencyMs: number;
}

export interface Health {
  ok: boolean;
  mode: { storage: string; tts: string; orchestrator: string; demoMode: boolean };
  ring: { signatureVerification: string; apiCredentialsConfigured: boolean; webhookPath: string };
  aws: {
    region: string;
    table: string | null;
    bedrockModelId: string | null;
    pollyVoiceId: string | null;
  };
}

export const api = {
  carePlan: () => request<CarePlan>('GET', '/api/care-plan'),
  safety: () => request<SafetyPanel>('GET', '/api/safety'),
  health: () => request<Health>('GET', '/healthz'),
  sessions: (limit = 10) => request<CareSession[]>('GET', `/api/sessions?limit=${limit}`),
  session: (id: string) => request<CareSession>('GET', `/api/sessions/${encodeURIComponent(id)}`),
  timeline: (limit = 50) => request<TimelineEntry[]>('GET', `/api/timeline?limit=${limit}`),
  audit: (sessionId: string) =>
    request<AuditRecord[]>('GET', `/api/audit?sessionId=${encodeURIComponent(sessionId)}`),

  speak: (sessionId: string, transcript: string) =>
    request<TurnResponse>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      transcript,
    }),
  choose: (sessionId: string, actionId: string) =>
    request<TurnResponse>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/turn`, {
      actionId,
    }),
  confirm: (sessionId: string, affirmative: boolean) =>
    request<TurnResponse>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      affirmative,
    }),
  cancel: (sessionId: string) =>
    request<TurnResponse>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/cancel`),
  approveMcpAction: (confirmationId: string, affirmative: boolean) =>
    request<Record<string, unknown>>('POST', '/api/mcp/confirm', { confirmationId, affirmative }),

  fireRingEvent: (scenario: 'scheduled' | 'unexpected' | 'delivery') =>
    request<DemoEventResponse>('POST', '/api/demo/ring-event', { scenario }),
  startEmergencyAssist: () =>
    request<{ sessionId: string; session: CareSession }>('POST', '/api/demo/emergency-assist', {}),

  /**
   * Fetch Polly audio for a line.
   *
   * Returns undefined when the backend answers 204, which is its way of saying "no Polly
   * here, use the browser voice". The caller must handle that — the demo has to work with
   * no AWS credentials at all.
   */
  async tts(text: string): Promise<Blob | undefined> {
    const token = sessionStorage.getItem('careflow.apiToken');
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    });
    if (res.status === 204 || !res.ok) return undefined;
    return res.blob();
  },
};
