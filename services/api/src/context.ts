/**
 * Wiring. One place that builds the object graph, shared by the dev server and Lambda so
 * the two cannot drift apart.
 */

import { createOrchestrator } from '@careflow/agent';
import type { AppContext } from './app.js';
import { loadCarePlan } from './lib/careplan.js';
import { Bus } from './lib/bus.js';
import { loadConfig, resolveSecrets, type Config } from './lib/config.js';
import { SessionService } from './lib/sessions.js';
import { Store } from './lib/store.js';
import { createMcpServer } from './mcp/index.js';
import type { McpServer } from './mcp/server.js';

export interface Runtime extends AppContext {
  bus: Bus;
  mcp: McpServer;
}

/**
 * Structured, single-line JSON logs.
 *
 * CloudWatch Logs Insights can query these directly, which during a hackathon is the
 * difference between finding a failing Bedrock call in seconds and scrolling log streams.
 */
function makeLogger(config: Config) {
  return (msg: string, meta?: Record<string, unknown>) => {
    const line = {
      at: new Date().toISOString(),
      msg,
      ...(meta ?? {}),
      storage: config.storage,
    };
    console.log(JSON.stringify(line));
  };
}

let cached: Promise<Runtime> | undefined;

/** Cached per process, so Lambda warm starts reuse the care plan and the SDK clients. */
export function getRuntime(): Promise<Runtime> {
  cached ??= build();
  return cached;
}

async function build(): Promise<Runtime> {
  const config = await resolveSecrets(loadConfig());
  const log = makeLogger(config);
  const carePlan = await loadCarePlan();
  const store = new Store(config);
  const bus = new Bus();

  const orchestratorDeps = {
    carePlan,
    log,
    ...(config.bedrockModelId ? { bedrockModelId: config.bedrockModelId } : {}),
    awsRegion: config.awsRegion,
  };

  const sessions = new SessionService({
    store,
    bus,
    // Re-materialized per event; loadCarePlan caches internally so this is cheap.
    getCarePlan: () => loadCarePlan(),
    orchestrator: createOrchestrator(orchestratorDeps),
    demoMode: config.demoMode,
    log,
  });

  log('careflow api runtime ready', {
    storage: config.storage,
    tts: config.tts,
    bedrock: config.bedrockModelId ?? 'none',
    patient: carePlan.patient.displayName,
    visits: carePlan.visits.length,
  });

  const mcp = createMcpServer(
    {
      store,
      getCarePlan: () => loadCarePlan(),
      demoMode: config.demoMode,
      log,
    },
    '0.1.0',
    // An MCP host sends no Origin at all, which is allowed. A *browser* origin we do not
    // recognise is a DNS-rebinding attempt and gets 403, which is what the spec is asking
    // for. Extra origins can be added with CAREFLOW_MCP_ORIGINS.
    [
      config.webAppUrl,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      ...(process.env.CAREFLOW_MCP_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    ],
    {
      authToken: config.mcpAuthToken,
      maxSessions: 100,
    },
  );

  return { config, store, sessions, carePlan, log, bus, mcp };
}
