# CareFlow interface contract (v1)

This is the only document all three workstreams must agree on. If you need it changed,
say so in chat before changing it — everything else is owned by exactly one person.

## Ownership map (no two people edit the same file)

| Area | Owner | Paths |
|---|---|---|
| Ring integration, backend, AWS, infra | Rohit | `packages/ring/**`, `services/api/**`, `infra/**`, `scripts/**`, `fixtures/**` |
| Voice agent, consent engine, safety | Damir | `packages/consent-engine/**`, `packages/agent/**` |
| Web app, UX, docs, submission | Lee | `apps/web/**`, `README.md`, `docs/submission/**`, `docs/friction/**` |
| Shared types | Rohit (PR to change) | `packages/shared/**` |

## Data flow

```
Ring device / CareFlow Ring simulator
  -> POST /ring/webhook            (HMAC-SHA256 X-Signature verified, 200 in <5s)
  -> normalize to CareEvent        (packages/ring)
  -> match against care plan       (services/api, DynamoDB)
  -> create CareSession            (state = "observed")
  -> orchestrator.open()           (packages/agent, Bedrock)      <- Damir
  -> SSE push to browser           (GET /events/stream)           -> Lee
  -> patient speaks -> POST /api/sessions/:id/turn
  -> consent engine gates sensitive actions                       <- Damir
  -> POST /api/sessions/:id/confirm -> action executes -> audit row
```

## HTTP API (owned by Rohit, used by Lee and Damir)

Base URL in local dev: `http://localhost:8787`

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/ring/webhook` | Ring v1.1 payload + `X-Signature` | `202 {ok,eventId}` |
| GET | `/events/stream` | — | SSE, `event: session` / `event: timeline` |
| GET | `/api/care-plan` | — | `CarePlan` |
| GET | `/api/sessions/:id` | — | `CareSession` |
| POST | `/api/sessions/:id/turn` | `{transcript}` or `{actionId}` | `{session, turn}` |
| POST | `/api/sessions/:id/confirm` | `{affirmative:boolean}` | `{session, turn}` |
| POST | `/api/sessions/:id/cancel` | — | `{session, turn}` |
| GET | `/api/timeline` | `?limit=50` | `TimelineEntry[]` |
| GET | `/api/audit` | `?sessionId=` | `AuditRecord[]` |
| GET | `/api/safety` | — | `SafetyPanel` |
| POST | `/api/tts` | `{text, voice?}` | `audio/mpeg`, or `204` -> use browser speech |
| POST | `/api/demo/ring-event` | `{scenario:"scheduled"\|"unexpected"\|"delivery"}` | `202 {eventId, signature, rawBody}` |
| POST | `/api/demo/emergency-assist` | — | `202 {sessionId, session}` |
| GET | `/api/sessions` | `?limit=25` | `CareSession[]`, newest first |
| GET | `/healthz` | — | `{ok, mode, aws:{...}}` |

Every response is JSON unless stated. Errors: `{error:{code,message}}` with a real status code.

`actionId` on `/turn` lets the UI send a button press instead of speech. Known ids:
`ready_now`, `need_minutes`, `say_unavailable`, `notify_trusted`, `do_nothing`,
`confirm_yes`, `confirm_no`. The two `confirm_*` ids are routed to `/confirm` internally, so
a button press and a spoken "yes" behave identically.

`/api/demo/ring-event` returns the exact signed bytes and the `X-Signature` it sent, so the
UI can show a judge that the delivery was really signed and really verified.

## The orchestrator seam (Damir implements it and Rohit can call it for implementation and testing purposes)

`packages/agent/src/index.ts` must export exactly:

```ts
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator;

export interface Orchestrator {
  open(session: CareSession): Promise<AgentTurn>;                       // Observe -> Explain -> Ask
  respond(session: CareSession, transcript: string): Promise<AgentTurn>; // Ask -> Confirm
  confirm(session: CareSession, affirmative: boolean): Promise<AgentTurn>; // Confirm -> Act
  cancel(session: CareSession): Promise<AgentTurn>;
}
```

`AgentTurn`, `CareSession`, `ConsentState` and `SensitiveAction` come from `@careflow/shared`.
A scripted, deterministic orchestrator already ships at `packages/agent/src/scripted.ts`,
with the safety boundaries in `packages/agent/src/safety.ts`, so the demo runs end to end
today. Both are Damir's to own and extend from here. Implement Bedrock in
`packages/agent/src/bedrock.ts` exporting `createBedrockOrchestrator`; `index.ts` already
resolves it dynamically, races it against a 2.5s deadline, and falls back to scripted on
error. Do not change the `Orchestrator` signature.

Rules the seam enforces (backend will reject violations, and there is a test for each):
1. A turn may set `executeAction` **only** when the previous state was `awaiting_confirmation`
   and `affirmative === true`.
2. `executeAction` must deep-equal the `pendingAction` that was confirmed.
3. The first turn of every session must have `disclosure: true` and the say text must contain
   the AI disclosure sentence.
4. Anything in `BLOCKED_CAPABILITIES` (door unlock, disarm alarm, medical advice, medical
   diagnosis, emergency dispatch) can never be an action, from any state, after any
   confirmation.
5. `escalate_care_team` is only available in an `emergency_assist_prototype` session that
   the patient started. CareFlow never decides on its own that someone needs help.
6. A contact with `notifiableOutsideVisits: false` is never notified. The patient controls
   that list and the agent does not get to route around it.

These are enforced in `services/api/src/lib/sessions.ts` and covered by
`services/api/test/consent-gate.test.ts`, which drives the gate with a deliberately hostile
orchestrator. The consent engine enforces them again independently — the redundancy is the
design, so that a bug in either one is not enough to send a message nobody approved.

## SSE payloads (Lee)

```
event: session
data: {"session": CareSession, "turn": AgentTurn | null}

event: timeline
data: {"entry": TimelineEntry}
```

Reconnect with `?since=<iso>` to replay the last 100 events. Frontend must never call AWS
directly.

SSE exists only on the local dev server — Lambda has nowhere to hold a streaming
connection. Treat it as an enhancement: if the stream is unavailable, poll
`/api/sessions/:id` and `/api/timeline`. The demo has to work against either target.

### Session shape notes

`CareSession.mode` is `"visitor"` for the Ring-driven flow and
`"emergency_assist_prototype"` for the patient-initiated help flow. The UI must label the
second one a prototype. `CareEvent.source` is `"ring"`, `"simulator"`, or `"patient"` —
surface it, so the demo is honest about where an event came from.

## Demo data

`fixtures/care-plan.json` — one patient (Eleanor Reyes), one caregiver (Jordan Mbeki, nurse,
visit 14:00–14:30 daily), one trusted contact (Maya Reyes, daughter). All fictional. No real
patient data, ever — that is a submission requirement, not a style preference.
