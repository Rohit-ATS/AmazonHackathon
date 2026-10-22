import { describe, expect, it } from 'vitest';
import type { Config } from '../src/lib/config.js';
import { assertSafeLocalServerConfig, corsHeaders } from '../src/lib/local-server-security.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 8787,
    selfUrl: 'http://127.0.0.1:8787',
    webAppUrl: 'http://localhost:5173',
    storage: 'local',
    tableName: 'careflow',
    localStatePath: ':memory:',
    tts: 'browser',
    pollyVoiceId: 'Joanna',
    awsRegion: 'us-east-1',
    ringHmacKey: 'test',
    ringRedirectUri: 'http://127.0.0.1:8787/ring/oauth/callback',
    requireSignatureVerification: true,
    demoMode: true,
    ...overrides,
  };
}

describe('local server security boundary', () => {
  it('allows credential-free mode only on loopback', () => {
    expect(() => assertSafeLocalServerConfig(config())).not.toThrow();
    expect(() => assertSafeLocalServerConfig(config({ host: '::1' }))).not.toThrow();
    expect(() => assertSafeLocalServerConfig(config({ host: '0.0.0.0' }))).toThrow(
      /without both CAREFLOW_API_TOKEN and CAREFLOW_MCP_TOKEN/,
    );
    expect(() => assertSafeLocalServerConfig(config({ host: 'localhost' }))).toThrow();
    expect(() => assertSafeLocalServerConfig(config({ host: '127.0.0.256' }))).toThrow();
  });

  it('allows an authenticated non-loopback listener with distinct credentials', () => {
    expect(() => assertSafeLocalServerConfig(config({
      host: '0.0.0.0', apiAuthToken: 'api-token', mcpAuthToken: 'mcp-token',
    }))).not.toThrow();
    expect(() => assertSafeLocalServerConfig(config({
      host: '0.0.0.0', apiAuthToken: 'same', mcpAuthToken: 'same',
    }))).toThrow(/must be different/);
  });

  it('never emits wildcard CORS and only reflects approved origins', () => {
    expect(corsHeaders('http://localhost:5173', 'http://localhost:5173/app')).toMatchObject({
      'access-control-allow-origin': 'http://localhost:5173',
      vary: 'Origin',
    });
    expect(corsHeaders('https://evil.example', 'http://localhost:5173')).toEqual({});
    expect(JSON.stringify(corsHeaders('http://localhost:5173', 'http://localhost:5173'))).not.toContain('*');
  });
});
