/**
 * MCP server over Streamable HTTP, spec revision 2025-11-25.
 *
 * One endpoint (`/mcp`) handling POST, GET and DELETE, per the transport spec. The MUSTs
 * that are easy to miss and are implemented here deliberately:
 *
 *  - `Origin` present and not allowed  -> 403, to blunt DNS rebinding.
 *  - POST of a notification or response -> 202 Accepted with no body.
 *  - POST of a request -> either `application/json` or an SSE stream; we answer JSON,
 *    which the client MUST support.
 *  - A session id is issued on `initialize` via the `MCP-Session-Id` response header, and
 *    required on every later request (400 without it, 404 once terminated).
 *  - An unsupported `MCP-Protocol-Version` -> 400. A missing one is assumed to be
 *    2025-03-26 rather than rejected.
 *  - GET returns an SSE stream so the server can push notifications; DELETE ends a session.
 *
 * Why hand-rolled: the track asks for a self-hosted MCP server, and the transport rules are
 * the part a client will actually exercise. Writing them out is the proof.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ASSUMED_PROTOCOL_VERSION,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  failure,
  isNotification,
  isRequest,
  success,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from './protocol.js';
import type { ToolRegistry } from './tools.js';

export const MCP_ENDPOINT = '/mcp';

export interface McpSession {
  id: string;
  protocolVersion: string;
  clientName: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface McpRequestInput {
  method: string;
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Set when the caller should hold the connection open as an SSE stream. */
  stream?: boolean;
}

export interface McpServerOptions {
  tools: ToolRegistry;
  serverName: string;
  serverVersion: string;
  /** Allowed Origin values. An absent Origin is fine; a present, unlisted one is not. */
  allowedOrigins?: string[];
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Instructions surfaced to the host model at initialize. */
  instructions: string;
  authToken?: string;
  maxSessions?: number;
}

/** Sessions live in memory: they are conversational state, not data worth persisting. */
const SESSION_IDLE_MS = 60 * 60_000;

export class McpServer {
  private sessions = new Map<string, McpSession>();
  /** Terminated ids are remembered briefly so a stale client gets 404, not a fresh 400. */
  private terminated = new Set<string>();

  constructor(private readonly opts: McpServerOptions) {}

  get sessionCount(): number {
    this.sweep();
    return this.sessions.size;
  }

  async handle(req: McpRequestInput): Promise<McpResponse> {
    this.sweep();

    if (!this.authorized(req.headers.authorization, this.opts.authToken)) {
      return this.json(401, failure(null, ErrorCode.InvalidRequest, 'Authentication required.'), {
        'www-authenticate': 'Bearer realm="careflow-mcp"',
      });
    }

    const origin = req.headers['origin'];
    if (!this.originAllowed(origin)) {
      this.opts.log('mcp: rejected disallowed origin', { origin });
      // Spec: respond 403, body MAY be a JSON-RPC error response with no id.
      return this.json(403, failure(null, ErrorCode.InvalidRequest, 'Origin not allowed.'));
    }

    if (req.method === 'GET') return this.handleGet(req);
    if (req.method === 'DELETE') return this.handleDelete(req);
    if (req.method !== 'POST') {
      return { status: 405, headers: { allow: 'GET, POST, DELETE' }, body: '' };
    }
    return this.handlePost(req);
  }

  // -------------------------------------------------------------------------
  // POST
  // -------------------------------------------------------------------------

  private async handlePost(req: McpRequestInput): Promise<McpResponse> {
    const accept = req.headers['accept'] ?? '';
    if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
      return this.json(
        406,
        failure(
          null,
          ErrorCode.InvalidRequest,
          'Accept must list application/json and text/event-stream.',
        ),
      );
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(req.rawBody.toString('utf8')) as JsonRpcMessage;
    } catch {
      return this.json(400, failure(null, ErrorCode.ParseError, 'Body is not valid JSON.'));
    }

    if (Array.isArray(message)) {
      // Batching was removed from the protocol; one message per POST.
      return this.json(
        400,
        failure(null, ErrorCode.InvalidRequest, 'Send a single JSON-RPC message per request.'),
      );
    }

    const versionCheck = this.checkProtocolVersion(req);
    if (versionCheck) return versionCheck;

    // `initialize` is the one request allowed without a session.
    const isInitialize = isRequest(message) && message.method === 'initialize';
    if (isInitialize && this.sessions.size >= (this.opts.maxSessions ?? 100)) {
      return this.json(429, failure(isRequest(message) ? message.id : null, ErrorCode.InternalError, 'Too many active sessions.'));
    }
    if (!isInitialize) {
      const sessionCheck = this.requireSession(req);
      if ('error' in sessionCheck) return sessionCheck.error;
      sessionCheck.session.lastSeenAt = Date.now();
    }

    // A notification or a response from the client gets 202 and no body.
    if (isNotification(message) || (!isRequest(message) && !('method' in message))) {
      this.opts.log('mcp: notification', {
        method: 'method' in message ? message.method : '(response)',
      });
      return { status: 202, headers: {}, body: '' };
    }

    if (!isRequest(message)) {
      return this.json(400, failure(null, ErrorCode.InvalidRequest, 'Unrecognised message.'));
    }

    const { response, sessionId } = await this.dispatch(message, req);
    const headers: Record<string, string> = {};
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return this.json(200, response, headers);
  }

  private async dispatch(
    request: JsonRpcRequest,
    req: McpRequestInput,
  ): Promise<{ response: unknown; sessionId?: string }> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.initialize(request);

        case 'ping':
          // Spec: an empty result is the whole contract.
          return { response: success(request.id, {}) };

        case 'tools/list':
          return {
            response: success(request.id, { tools: this.opts.tools.list() }),
          };

        case 'tools/call': {
          const params = (request.params ?? {}) as { name?: string; arguments?: unknown };
          if (!params.name) {
            return {
              response: failure(request.id, ErrorCode.InvalidParams, 'Missing tool name.'),
            };
          }
          if (!this.opts.tools.has(params.name)) {
            // An unknown tool is a protocol error, not a tool execution error: the model
            // cannot fix it by adjusting arguments.
            return {
              response: failure(
                request.id,
                ErrorCode.MethodNotFound,
                `Unknown tool: ${params.name}`,
              ),
            };
          }

          const sessionId = req.headers['mcp-session-id'] ?? 'anonymous';
          const result = await this.opts.tools.call(
            params.name,
            (params.arguments ?? {}) as Record<string, unknown>,
            { sessionId },
          );
          return { response: success(request.id, result) };
        }

        // Declared capabilities are tools only, so these exist to answer politely rather
        // than make a client guess from a method-not-found.
        case 'resources/list':
          return { response: success(request.id, { resources: [] }) };
        case 'prompts/list':
          return { response: success(request.id, { prompts: [] }) };

        default:
          return {
            response: failure(
              request.id,
              ErrorCode.MethodNotFound,
              `Method not found: ${request.method}`,
            ),
          };
      }
    } catch (err) {
      this.opts.log('mcp: internal error', {
        method: request.method,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        response: failure(request.id, ErrorCode.InternalError, 'Internal server error.'),
      };
    }
  }

  private initialize(request: JsonRpcRequest): { response: unknown; sessionId: string } {
    const params = (request.params ?? {}) as {
      protocolVersion?: string;
      clientInfo?: { name?: string };
    };

    // Version negotiation: honour the client's version when we speak it, otherwise answer
    // with our latest and let the client decide whether to continue.
    const requested = params.protocolVersion;
    const agreed =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    const session: McpSession = {
      id: randomUUID(),
      protocolVersion: agreed,
      clientName: params.clientInfo?.name ?? 'unknown',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.sessions.set(session.id, session);

    this.opts.log('mcp: session initialized', {
      sessionId: session.id,
      client: session.clientName,
      protocolVersion: agreed,
    });

    return {
      sessionId: session.id,
      response: success(request.id, {
        protocolVersion: agreed,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: this.opts.serverName,
          version: this.opts.serverVersion,
        },
        instructions: this.opts.instructions,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // GET / DELETE
  // -------------------------------------------------------------------------

  /**
   * GET opens an SSE stream for server-initiated messages.
   *
   * We have nothing to push yet, so the stream is opened and held: the spec allows that,
   * and returning 405 instead would tell a client we never will. The caller writes the
   * stream; this only decides the headers.
   */
  private handleGet(req: McpRequestInput): McpResponse {
    const accept = req.headers['accept'] ?? '';
    if (!accept.includes('text/event-stream')) {
      return this.json(
        406,
        failure(null, ErrorCode.InvalidRequest, 'Accept must include text/event-stream.'),
      );
    }

    const sessionCheck = this.requireSession(req);
    if ('error' in sessionCheck) return sessionCheck.error;

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      body: '',
      stream: true,
    };
  }

  private handleDelete(req: McpRequestInput): McpResponse {
    const id = req.headers['mcp-session-id'];
    if (!id) {
      return this.json(400, failure(null, ErrorCode.InvalidRequest, 'Missing MCP-Session-Id.'));
    }
    if (this.sessions.delete(id)) {
      this.terminated.add(id);
      this.opts.log('mcp: session terminated by client', { sessionId: id });
      return { status: 204, headers: {}, body: '' };
    }
    return this.json(404, failure(null, ErrorCode.InvalidRequest, 'No such session.'));
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  private requireSession(
    req: McpRequestInput,
  ): { session: McpSession } | { error: McpResponse } {
    const id = req.headers['mcp-session-id'];
    if (!id) {
      return {
        error: this.json(
          400,
          failure(null, ErrorCode.InvalidRequest, 'Missing MCP-Session-Id header.'),
        ),
      };
    }

    const session = this.sessions.get(id);
    if (!session) {
      // 404 is the spec's signal for "that session is gone, start a new one", and the
      // client is required to re-initialize on it.
      return {
        error: this.json(
          404,
          failure(null, ErrorCode.InvalidRequest, 'Session not found. Re-initialize.'),
        ),
      };
    }
    return { session };
  }

  private checkProtocolVersion(req: McpRequestInput): McpResponse | undefined {
    const header = req.headers['mcp-protocol-version'];
    // Absent is explicitly allowed: assume 2025-03-26 rather than rejecting.
    if (!header) return undefined;
    if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(header)) return undefined;

    return this.json(
      400,
      failure(
        null,
        ErrorCode.InvalidRequest,
        `Unsupported MCP-Protocol-Version: ${header}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
      ),
    );
  }

  private originAllowed(origin: string | undefined): boolean {
    // No Origin at all is a non-browser client, which is the normal case for an MCP host
    // and is explicitly fine. A *present* Origin means a browser, and an unrecognised one
    // is what a DNS-rebinding attack looks like — so an unconfigured allowlist must fail
    // closed rather than waving everything through.
    if (!origin) return true;
    const allowed = this.opts.allowedOrigins ?? [];
    if (allowed.includes('*')) return true;
    return allowed.includes(origin);
  }

  private authorized(supplied: string | undefined, expected: string | undefined): boolean {
    if (!expected) return true;
    const raw = supplied?.startsWith('Bearer ') ? supplied.slice(7) : supplied;
    if (!raw) return false;
    const actual = Buffer.from(raw);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }

  /** Separate authenticated patient/UI channel; never reachable through tools/call. */
  confirmFromHuman(confirmationId: string, affirmative: boolean) {
    return this.opts.tools.confirmFromHuman(confirmationId, affirmative);
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastSeenAt < cutoff) {
        this.sessions.delete(id);
        this.terminated.add(id);
      }
    }
    if (this.terminated.size > 500) this.terminated.clear();
  }

  private json(status: number, body: unknown, extra: Record<string, string> = {}): McpResponse {
    return {
      status,
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    };
  }
}

export { ASSUMED_PROTOCOL_VERSION };
