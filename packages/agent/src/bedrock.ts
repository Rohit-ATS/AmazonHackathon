/**
 * Amazon Bedrock orchestrator.
 *
 * **Owner: Damir.** This file is intentionally unimplemented — `index.ts` already resolves
 * it dynamically and falls back to the scripted orchestrator, so the service runs today and
 * will pick this up the moment the factory below is exported.
 *
 * Export this when ready, and `createOrchestrator` wires it automatically:
 *
 *   export function createBedrockOrchestrator(deps: OrchestratorDeps): Orchestrator { ... }
 *
 * Notes from the backend side, so the seam behaves:
 *
 * - Two model calls, no more. `classifyAndExplain` produces the Observe/Explain/Ask
 *   utterance; `extractIntent` turns free speech into `{action, params, note}`. The model
 *   never decides whether an action may run — `services/api/src/lib/sessions.ts` does, and
 *   it will refuse anything that breaks the consent contract.
 * - Use the Bedrock Converse API (`ConverseCommand` from `@aws-sdk/client-bedrock-runtime`)
 *   rather than raw InvokeModel: one request shape across models, and tool/JSON handling is
 *   less fiddly.
 * - Ask for the intent as a tool call or a JSON schema response. Parsing prose into an
 *   action is where this goes wrong, and a model that returns `{"action":"notify_trusted"}`
 *   is much safer than one that returns "I'll let Maya know".
 * - Keep every turn under MODEL_DEADLINE_MS (2.5s). Beyond that the wrapper discards the
 *   result and the patient hears the scripted line instead.
 * - Run safety checks (`checkBoundary` in safety.ts) on the transcript *before* calling the
 *   model, not in the prompt. A prompt instruction is not a control.
 * - `AgentTurn.engine` must be `'bedrock'` so the UI and the timeline show which brain
 *   produced the turn — that is also our visible proof of the Bedrock integration.
 * - Set `BEDROCK_MODEL_ID` in `.env`. Confirm the id and that your account has access with:
 *       aws bedrock list-foundation-models --query "modelSummaries[].modelId" --output table
 *   Cross-region inference profiles are prefixed (e.g. `us.`), and the un-prefixed id will
 *   fail with an access error on most accounts — a 20-minute mistake worth skipping.
 */

export const BEDROCK_ORCHESTRATOR_STATUS = 'not_implemented' as const;
