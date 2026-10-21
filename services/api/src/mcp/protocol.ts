/**
 * JSON-RPC 2.0 and MCP protocol types.
 *
 * Hand-written rather than pulled from an SDK: the Alexa+ track asks for a *self-hosted*
 * MCP server on spec 2025-11-25 with Streamable HTTP, and implementing the transport
 * directly is both the proof and the only way to be sure every MUST in the spec is
 * actually met rather than assumed.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const LATEST_PROTOCOL_VERSION = '2025-11-25';

/**
 * Per the spec: if no MCP-Protocol-Version header is present and the version cannot be
 * determined another way, assume 2025-03-26.
 */
export const ASSUMED_PROTOCOL_VERSION = '2025-03-26';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

/** Standard JSON-RPC error codes, plus the MCP-relevant ones. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg && msg.id !== null && msg.id !== undefined;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

// ---------------------------------------------------------------------------
// MCP shapes
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** Must be a valid JSON Schema object, never null. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'audio'; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a tool result.
 *
 * The spec says a tool returning structured content SHOULD also serialize it into a text
 * block for backwards compatibility, so this does both from one call rather than leaving
 * it to each tool to remember.
 */
export function toolResult(
  text: string,
  structured?: Record<string, unknown>,
  isError = false,
): ToolResult {
  const content: ContentBlock[] = [{ type: 'text', text }];
  if (structured) content.push({ type: 'text', text: JSON.stringify(structured) });
  return {
    content,
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * A tool *execution* error, which is a successful JSON-RPC response carrying
 * `isError: true` — not a protocol error.
 *
 * The distinction matters: the spec says execution errors are fed back to the model so it
 * can self-correct, whereas protocol errors signal a malformed request it probably cannot
 * fix. Returning the wrong one means either a model that cannot recover from a typo, or
 * one that keeps retrying something structurally impossible.
 */
export function toolError(message: string, structured?: Record<string, unknown>): ToolResult {
  return toolResult(message, structured, true);
}
