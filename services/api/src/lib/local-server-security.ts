import type { Config } from './config.js';
import { isIP } from 'node:net';

const CORS_BASE = {
  'access-control-allow-headers': 'authorization,content-type,x-signature,x-careflow-simulated',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

export function corsHeaders(origin: string | undefined, webAppUrl: string): Record<string, string> {
  if (!origin) return {};
  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(webAppUrl).origin;
  } catch {
    return {};
  }
  const allowed = new Set([configuredOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  return allowed.has(origin)
    ? { ...CORS_BASE, 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

/** Keep credential-free development private to the local machine. */
export function assertSafeLocalServerConfig(config: Config): void {
  const host = config.host.trim().toLowerCase();
  const family = isIP(host);
  const loopback = (family === 4 && host.split('.')[0] === '127') || (family === 6 && host === '::1');
  if (loopback) return;
  if (!config.apiAuthToken || !config.mcpAuthToken) {
    throw new Error(
      `Refusing to bind CareFlow to non-loopback host "${config.host}" without both ` +
        'CAREFLOW_API_TOKEN and CAREFLOW_MCP_TOKEN.',
    );
  }
  if (config.apiAuthToken === config.mcpAuthToken) {
    throw new Error('API and MCP credentials must be different.');
  }
}
