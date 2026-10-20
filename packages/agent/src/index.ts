/**
 * The orchestrator seam. `services/api` calls only `createOrchestrator`.
 *
 * Structure:
 *   - scripted.ts  deterministic, always available, also the fallback   (ships today)
 *   - bedrock.ts   Amazon Bedrock classification + intent extraction    (Damir)
 *
 * The Bedrock path is wrapped so that a cold start, a throttle, or a malformed model
 * response falls back to scripted instead of failing the turn. In a care context a late or
 * missing answer is itself a failure, so the deadline is enforced here rather than hoped for.
 */

import type { AgentTurn, Orchestrator, OrchestratorDeps } from '@careflow/shared';
import { createScriptedOrchestrator } from './scripted.js';

export { createScriptedOrchestrator } from './scripted.js';
export { checkBoundary } from './safety.js';

/** Hard ceiling for a model turn. Past this the patient is just waiting in silence. */
export const MODEL_DEADLINE_MS = 2500;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const scripted = createScriptedOrchestrator(deps);
  if (!deps.bedrockModelId) {
    deps.log('orchestrator: scripted only (BEDROCK_MODEL_ID not set)');
    return scripted;
  }

  deps.log('orchestrator: bedrock with scripted fallback', { model: deps.bedrockModelId });
  return withFallback(() => loadBedrock(deps), scripted, deps);
}

/**
 * Resolve the Bedrock orchestrator on first use.
 *
 * Imported dynamically and tolerantly so that the service runs before `bedrock.ts` exists,
 * and so a missing `@aws-sdk/client-bedrock-runtime` on a teammate's machine degrades to
 * scripted rather than crashing the API. The promise is cached, including its rejection, so
 * a missing module costs one failed import rather than one per turn.
 */
let bedrockPromise: Promise<Orchestrator | undefined> | undefined;

function loadBedrock(deps: OrchestratorDeps): Promise<Orchestrator | undefined> {
  bedrockPromise ??= (async () => {
    try {
      const mod = (await import('./bedrock.js')) as {
        createBedrockOrchestrator?: (d: OrchestratorDeps) => Orchestrator;
      };
      const made = mod.createBedrockOrchestrator?.(deps);
      if (!made) deps.log('orchestrator: bedrock module present but exports no factory');
      return made;
    } catch (err) {
      deps.log('orchestrator: bedrock module unavailable, using scripted', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  })();
  return bedrockPromise;
}

/**
 * Race each call against the deadline and fall back on error.
 *
 * Note that fallback preserves conversation state: the scripted orchestrator reads the same
 * `CareSession`, so a mid-conversation switch continues rather than restarting — the
 * patient never has to repeat themselves because a model call timed out.
 */
function withFallback(
  getPrimary: () => Promise<Orchestrator | undefined>,
  fallback: Orchestrator,
  deps: OrchestratorDeps,
): Orchestrator {
  const run = async <K extends keyof Orchestrator>(
    method: K,
    args: Parameters<Orchestrator[K]>,
  ): Promise<AgentTurn> => {
    try {
      const primary = await getPrimary();
      if (!primary) {
        return (fallback[method] as (...a: unknown[]) => Promise<AgentTurn>)(...args);
      }
      const attempt = (primary[method] as (...a: unknown[]) => Promise<AgentTurn>)(...args);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('model_deadline_exceeded')), MODEL_DEADLINE_MS);
      });
      try {
        return await Promise.race([attempt, timeout]);
      } finally {
        // Otherwise the pending timer keeps the event loop alive after the turn is done,
        // which in Lambda means paying for up to 2.5s of nothing.
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      deps.log('orchestrator: falling back to scripted', {
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      return (fallback[method] as (...a: unknown[]) => Promise<AgentTurn>)(...args);
    }
  };

  return {
    open: (s) => run('open', [s] as never),
    respond: (s, t) => run('respond', [s, t] as never),
    confirm: (s, a) => run('confirm', [s, a] as never),
    cancel: (s) => run('cancel', [s] as never),
  };
}
