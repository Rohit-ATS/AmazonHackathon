/**
 * Routing, as a pure function of request -> response.
 *
 * Deliberately framework-free so the same handlers serve the local dev server and Lambda
 * behind API Gateway without an adapter layer, and so "works locally" and "works deployed"
 * mean the same thing. SSE is the one exception and is handled by the server, since Lambda
 * has nowhere to hold a streaming connection.
 */

import type {
  CarePlan,
  SafetyPanel,
} from '@careflow/shared';
import { timingSafeEqual } from 'node:crypto';
import {
  AI_DISCLOSURE,
  BLOCKED_CAPABILITIES,
  EMERGENCY_PROTOTYPE_POLICY,
} from '@careflow/shared';
import {
  buildScenario,
  deliverSignedPayload,
  parsePayload,
  verifySignature,
  type SimulatedScenario,
} from '@careflow/ring';
import type { Config } from './lib/config.js';
import { SessionError, SessionService } from './lib/sessions.js';
import type { Store } from './lib/store.js';
import { synthesize } from './lib/tts.js';
import {
  completeAccountLink,
  linkPage,
  linkResultPage,
  ringCredentials,
  startAccountLink,
} from './lib/ringapp.js';

export interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  /** Raw bytes, untouched. Required for Ring signature verification. */
  rawBody: Buffer;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export interface AppContext {
  /** The MCP server. Present on the real runtime; optional so tests can omit it. */
  mcp?: import('./mcp/server.js').McpServer;
  config: Config;
  store: Store;
  sessions: SessionService;
  carePlan: CarePlan;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(status: number, body: unknown): AppResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function error(status: number, code: string, message: string): AppResponse {
  return json(status, { error: { code, message } });
}

export async function handleRequest(ctx: AppContext, req: AppRequest): Promise<AppResponse> {
  const { method, path } = req;

  try {
    // --- Alexa+ / MCP -----------------------------------------------------
    // One endpoint handling POST, GET and DELETE, per the Streamable HTTP transport.
    if (path === '/mcp' && ctx.mcp) {
      const result = await ctx.mcp.handle({
        method,
        headers: req.headers,
        rawBody: req.rawBody,
      });
      // A GET that opens an SSE stream is handled by the server layer, which owns the
      // connection; here it would be a no-content response.
      return { status: result.status, headers: result.headers, body: result.body };
    }

    // --- Ring Appstore app surface ---------------------------------------
    // The four URLs registered in the Ring Developer Console. See lib/ringapp.ts.
    if (method === 'POST' && path === '/ring/webhook') return await ringWebhook(ctx, req);
    if (method === 'GET' && path === '/ring/oauth/callback') return await ringCallback(ctx, req);
    if (method === 'GET' && path === '/ring/link') return await ringLink(ctx);
    if (method === 'POST' && path === '/ring/token-exchange') return await ringTokenExchange(ctx, req);
    if (method === 'GET' && path === '/ring/redirect') {
      return { status: 302, headers: { location: ctx.config.webAppUrl }, body: '' };
    }
    if (method === 'GET' && path === '/healthz') return json(200, health(ctx));

    if (!authorized(req.headers.authorization, ctx.config.apiAuthToken)) {
      return error(401, 'unauthorized', 'A valid CareFlow bearer token is required.');
    }

    if (method === 'GET' && path === '/ring/status') {
      const tokens = await ctx.store.getRingTokens();
      return json(200, {
        credentialsConfigured: Boolean(ringCredentials(ctx.config)),
        accountLinked: Boolean(tokens),
        accessTokenExpiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : null,
        urls: {
          accountLink: new URL('/ring/link', ctx.config.selfUrl).toString(),
          tokenExchange: new URL('/ring/token-exchange', ctx.config.selfUrl).toString(),
          webhook: new URL('/ring/webhook', ctx.config.selfUrl).toString(),
          defaultRedirect: new URL('/ring/redirect', ctx.config.selfUrl).toString(),
        },
      });
    }

    // --- care plan + safety ----------------------------------------------
    if (method === 'GET' && path === '/api/care-plan') return json(200, ctx.carePlan);
    if (method === 'GET' && path === '/api/safety') return json(200, safetyPanel(ctx));
    if (method === 'POST' && path === '/api/mcp/confirm' && ctx.mcp) {
      const body = parseJsonBody<{ confirmationId?: string; affirmative?: boolean }>(req);
      if (!body.confirmationId || typeof body.affirmative !== 'boolean') {
        return error(400, 'invalid_confirmation', 'Provide confirmationId and affirmative.');
      }
      return json(200, await ctx.mcp.confirmFromHuman(body.confirmationId, body.affirmative));
    }

    // --- sessions ---------------------------------------------------------
    if (method === 'GET' && path === '/api/sessions') {
      return json(200, await ctx.sessions.list(Number(req.query.limit ?? 25)));
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/(turn|confirm|cancel))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const sub = sessionMatch[3];

      if (method === 'GET' && !sub) {
        const session = await ctx.sessions.get(sessionId);
        return session ? json(200, session) : error(404, 'session_not_found', 'No such session.');
      }
      if (method === 'POST' && sub === 'turn') {
        const body = parseJsonBody<{ transcript?: string; actionId?: string }>(req);
        const transcript = body.transcript ?? transcriptForAction(body.actionId);
        if (!transcript) {
          return error(400, 'missing_transcript', 'Provide either transcript or a known actionId.');
        }
        // A button that maps to yes/no is a confirmation, not a new intent — routing it
        // through respond() would re-run intent extraction on the word "yes".
        if (body.actionId === 'confirm_yes' || body.actionId === 'confirm_no') {
          return json(200, await ctx.sessions.confirm(sessionId, body.actionId === 'confirm_yes'));
        }
        return json(200, await ctx.sessions.respond(sessionId, transcript));
      }
      if (method === 'POST' && sub === 'confirm') {
        const body = parseJsonBody<{ affirmative?: boolean }>(req);
        if (typeof body.affirmative !== 'boolean') {
          return error(400, 'missing_affirmative', 'Body must include affirmative: true | false.');
        }
        return json(200, await ctx.sessions.confirm(sessionId, body.affirmative));
      }
      if (method === 'POST' && sub === 'cancel') {
        return json(200, await ctx.sessions.cancel(sessionId));
      }
    }

    // --- timeline + audit -------------------------------------------------
    if (method === 'GET' && path === '/api/timeline') {
      return json(200, await ctx.store.listTimeline(Number(req.query.limit ?? 50)));
    }
    if (method === 'GET' && path === '/api/audit') {
      const sessionId = req.query.sessionId;
      if (!sessionId) return error(400, 'missing_session_id', 'Pass ?sessionId=');
      return json(200, await ctx.store.listAudit(sessionId));
    }

    // --- voice ------------------------------------------------------------
    if (method === 'POST' && path === '/api/tts') return await tts(ctx, req);

    // --- demo controls ----------------------------------------------------
    if (method === 'POST' && path === '/api/demo/ring-event') return await demoRingEvent(ctx, req);
    if (method === 'POST' && path === '/api/demo/emergency-assist') {
      const session = await ctx.sessions.startEmergencyAssist();
      return json(202, { sessionId: session.sessionId, session });
    }

    return error(404, 'not_found', `No route for ${method} ${path}.`);
  } catch (err) {
    if (err instanceof SessionError) return error(err.status, err.code, err.message);
    ctx.log('unhandled error', { error: err instanceof Error ? err.stack : String(err) });
    return error(500, 'internal_error', 'Something went wrong. Check the logs.');
  }
}

function authorized(header: string | undefined, expected: string | undefined): boolean {
  // Local development intentionally remains credential-free. Lambda refuses to start
  // without credentials, so an omitted token can never fail open in deployment.
  if (!expected) return true;
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

// ---------------------------------------------------------------------------
// Ring webhook
// ---------------------------------------------------------------------------

async function ringWebhook(ctx: AppContext, req: AppRequest): Promise<AppResponse> {
  const started = Date.now();

  // Verify before parsing. The signature covers the raw bytes, so any parse-and-
  // re-serialize in between would break it, and verifying after parsing would mean
  // running our JSON parser on unauthenticated input.
  const verification = verifySignature(
    req.rawBody,
    req.headers['x-signature'],
    ctx.config.ringHmacKey,
  );
  if (!verification.ok) {
    ctx.log('rejected Ring delivery', { reason: verification.reason });
    // 401 rather than 400: Ring retries on 5xx, and a bad signature will never improve
    // on retry, so there is no point asking Ring to try again.
    return error(401, verification.reason, 'Webhook signature verification failed.');
  }

  const parsed = parsePayload(req.rawBody);
  if (!parsed.ok) {
    ctx.log('malformed Ring payload', { reason: parsed.reason });
    return error(400, parsed.reason, 'Webhook payload failed validation.');
  }

  const source = req.headers['x-careflow-simulated'] === 'true' ? 'simulator' : 'ring';
  const result = await ctx.sessions.intakeRingEvent(parsed.payload, source);

  const elapsed = Date.now() - started;
  if (elapsed > 4000) {
    // Ring's budget is five seconds; crossing four means we are one slow model call away
    // from Ring treating a delivered event as failed and retrying it.
    ctx.log('webhook handling approached the Ring 5s budget', { elapsed });
  }

  if (result.outcome === 'duplicate') {
    // 200, not an error: Ring has delivered this correctly and we have already handled it.
    return json(200, { ok: true, deduplicated: true, requestId: result.requestId });
  }
  if (result.outcome === 'logged_only') {
    return json(202, { ok: true, eventId: result.event.eventId, startedConversation: false });
  }
  return json(202, {
    ok: true,
    eventId: result.session.event.eventId,
    sessionId: result.session.sessionId,
    startedConversation: true,
    elapsedMs: elapsed,
  });
}

// ---------------------------------------------------------------------------
// Ring account linking
// ---------------------------------------------------------------------------

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

/** Account Link URL. Ring opens this in the user's browser to start linking. */
async function ringLink(ctx: AppContext): Promise<AppResponse> {
  const started = await startAccountLink(ctx.config, ctx.store);
  if ('error' in started) {
    ctx.log('account link requested without Ring credentials');
    return { status: 200, headers: HTML_HEADERS, body: linkPage({ error: started.error, appName: 'CareFlow' }) };
  }
  return {
    status: 200,
    headers: HTML_HEADERS,
    body: linkPage({ authorizeUrl: started.authorizeUrl, appName: 'CareFlow' }),
  };
}

/** The redirect target. Completes the exchange and shows the user the outcome. */
async function ringCallback(ctx: AppContext, req: AppRequest): Promise<AppResponse> {
  const result = await completeAccountLink(ctx.config, ctx.store, {
    ...(req.query.code !== undefined ? { code: req.query.code } : {}),
    ...(req.query.state !== undefined ? { state: req.query.state } : {}),
    ...(req.query.error !== undefined ? { error: req.query.error } : {}),
  });

  ctx.log(result.ok ? 'Ring account linked' : 'Ring account link failed', {
    ...(result.ok ? {} : { reason: result.reason }),
  });

  return {
    status: result.ok ? 200 : 400,
    headers: HTML_HEADERS,
    body: linkResultPage(result, ctx.config.webAppUrl),
  };
}

/**
 * Token Exchange URL. Ring POSTs the authorization code here server-to-server.
 *
 * Accepts JSON or form encoding, because the documentation does not pin the content type
 * and guessing wrong would fail the exchange with a confusing error.
 */
async function ringTokenExchange(ctx: AppContext, req: AppRequest): Promise<AppResponse> {
  const contentType = req.headers['content-type'] ?? '';
  let code: string | undefined;
  let state: string | undefined;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(req.rawBody.toString('utf8'));
    code = form.get('code') ?? undefined;
    state = form.get('state') ?? undefined;
  } else {
    const body = parseJsonBody<{ code?: string; state?: string }>(req);
    code = body.code;
    state = body.state;
  }

  const result = await completeAccountLink(ctx.config, ctx.store, {
    ...(code !== undefined ? { code } : {}),
    ...(state !== undefined ? { state } : {}),
  });

  if (!result.ok) {
    ctx.log('token exchange failed', { reason: result.reason });
    return error(400, 'token_exchange_failed', result.reason);
  }
  return json(200, { ok: true, linkedAt: result.linkedAt });
}

// ---------------------------------------------------------------------------
// Demo controls
// ---------------------------------------------------------------------------

/**
 * Demo scenario timing, relative to now.
 *
 * With demo anchoring on, the nursing visit window is now-10 to now+20, so a press at
 * "now" genuinely falls inside a scheduled visit and the timeline reads coherently at any
 * hour. The unexpected visitor sits three hours out — after the nursing window, before the
 * evening visit — which is both unambiguously unscheduled and the "later that evening"
 * beat the demo narration calls for.
 */
const SCENARIOS: Record<string, { scenario: SimulatedScenario; offsetMinutes: number }> = {
  scheduled: { scenario: 'scheduled', offsetMinutes: 0 },
  unexpected: { scenario: 'unexpected', offsetMinutes: 45 },
  // Earlier the same afternoon. Package motion is logged and deliberately does not start a
  // conversation — an assistant that announces every parcel gets switched off.
  delivery: { scenario: 'delivery', offsetMinutes: -35 },
};

function shiftedNow(offsetMinutes: number): Date {
  return new Date(Date.now() + offsetMinutes * 60_000);
}

/**
 * Fire a simulated Ring event.
 *
 * This signs a real payload and POSTs it to our own public webhook URL over HTTP, rather
 * than calling the handler in-process. It is slower, and that is the point: the demo
 * exercises signature verification, the webhook route, idempotency, and the 5-second budget
 * exactly as a Ring delivery would.
 */
async function demoRingEvent(ctx: AppContext, req: AppRequest): Promise<AppResponse> {
  const body = parseJsonBody<{ scenario?: string; deviceId?: string }>(req);
  const key = body.scenario ?? 'scheduled';
  const spec = SCENARIOS[key];
  if (!spec) {
    return error(400, 'unknown_scenario', `Scenario must be one of: ${Object.keys(SCENARIOS).join(', ')}.`);
  }

  const payload = buildScenario(
    spec.scenario,
    body.deviceId ?? ctx.carePlan.devices[0]?.deviceId ?? 'front-door-001',
    shiftedNow(spec.offsetMinutes),
  );

  const endpoint = new URL('/ring/webhook', ctx.config.selfUrl).toString();
  const delivery = await deliverSignedPayload(endpoint, payload, ctx.config.ringHmacKey);

  return json(delivery.status >= 400 ? 502 : 202, {
    ok: delivery.status < 400,
    scenario: key,
    eventId: payload.data.id,
    webhookStatus: delivery.status,
    signature: delivery.signature,
    // Returned so the UI can show the judge the exact signed bytes that went over the wire.
    rawBody: delivery.rawBody,
    latencyMs: delivery.latencyMs,
    response: safeJson(delivery.body),
  });
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

async function tts(ctx: AppContext, req: AppRequest): Promise<AppResponse> {
  const body = parseJsonBody<{ text?: string; voice?: string }>(req);
  if (!body.text) return error(400, 'missing_text', 'Body must include text.');
  if (body.text.length > 1500) return error(413, 'text_too_long', 'Keep utterances short.');

  if (ctx.config.tts === 'browser') {
    // 204 is the frontend's signal to use browser speech synthesis.
    return { status: 204, headers: {}, body: '' };
  }

  const result = await synthesize(body.text, {
    voiceId: body.voice ?? ctx.config.pollyVoiceId,
    region: ctx.config.awsRegion,
  });
  if (!result) {
    ctx.log('Polly unavailable; telling the client to use browser speech');
    return { status: 204, headers: {}, body: '' };
  }

  return {
    status: 200,
    headers: {
      'content-type': result.contentType,
      'cache-control': 'no-store',
      'x-careflow-voice': result.voiceId,
    },
    body: result.audio,
  };
}

// ---------------------------------------------------------------------------
// Safety + health
// ---------------------------------------------------------------------------

function safetyPanel(ctx: AppContext): SafetyPanel {
  // Read from live configuration rather than hardcoded, so the panel cannot claim a
  // protection the running service is not actually applying.
  return {
    consentRequiredForSensitiveActions: true,
    medicalAdvice: 'disabled',
    medicalDiagnosis: 'disabled',
    automaticDoorUnlock: 'disabled',
    emergencyDispatch: 'disabled',
    dataRetention: ctx.config.demoMode ? 'demo-mode' : 'configured',
    trustedContacts: 'patient-controlled',
    blockedCapabilities: BLOCKED_CAPABILITIES,
    aiDisclosure: AI_DISCLOSURE,
    webhookSignatureVerification: ctx.config.ringHmacKey ? 'enforced' : 'disabled',
    emergencyAssist: {
      status: EMERGENCY_PROTOTYPE_POLICY.status,
      patientInitiatedOnly: EMERGENCY_PROTOTYPE_POLICY.patientInitiatedOnly,
      confirmationRequired: EMERGENCY_PROTOTYPE_POLICY.confirmationRequired,
      contactsEmergencyServices: EMERGENCY_PROTOTYPE_POLICY.contactsEmergencyServices,
      assessesMedicalSeverity: EMERGENCY_PROTOTYPE_POLICY.assessesMedicalSeverity,
      spokenSafetyLine: EMERGENCY_PROTOTYPE_POLICY.spokenSafetyLine,
    },
  };
}

function health(ctx: AppContext) {
  return {
    ok: true,
    mode: {
      storage: ctx.config.storage,
      tts: ctx.config.tts,
      orchestrator: ctx.config.bedrockModelId ? 'bedrock+scripted-fallback' : 'scripted',
      demoMode: ctx.config.demoMode,
    },
    ring: {
      signatureVerification: 'enforced',
      apiCredentialsConfigured: Boolean(ctx.config.ringClientId && ctx.config.ringClientSecret),
      webhookPath: '/ring/webhook',
      accountLinkPath: '/ring/link',
      tokenExchangePath: '/ring/token-exchange',
      defaultRedirectPath: '/ring/redirect',
    },
    aws: {
      region: ctx.config.awsRegion,
      table: ctx.config.storage === 'dynamodb' ? ctx.config.tableName : null,
      bedrockModelId: ctx.config.bedrockModelId ?? null,
      pollyVoiceId: ctx.config.tts === 'polly' ? ctx.config.pollyVoiceId : null,
    },
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonBody<T>(req: AppRequest): T {
  if (req.rawBody.length === 0) return {} as T;
  try {
    return JSON.parse(req.rawBody.toString('utf8')) as T;
  } catch {
    throw new SessionError('body_not_json', 'Request body must be valid JSON.', 400);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Maps the UI's button ids to the words a patient would have said. */
function transcriptForAction(actionId: string | undefined): string | undefined {
  switch (actionId) {
    case 'ready_now':
      return "Tell them I'm ready now";
    case 'need_minutes':
      return "Tell them I'll be ready in two minutes";
    case 'say_unavailable':
      return "Tell them I'm unavailable right now";
    case 'notify_trusted':
      return 'Contact my daughter';
    case 'do_nothing':
      return 'Do nothing';
    case 'confirm_yes':
      return 'Yes';
    case 'confirm_no':
      return 'No';
    default:
      return undefined;
  }
}
