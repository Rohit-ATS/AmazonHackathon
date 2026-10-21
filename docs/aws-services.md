# AWS services in CareFlow

Our AWS Builder mini-challenge entry. Each service below does a job CareFlow genuinely
needs; none was added to lengthen the list. Where we chose *not* to use something, or chose
a cheaper design, that is stated rather than hidden.

The whole pipeline also runs with no AWS account at all (local JSON store, browser speech,
scripted agent), because a teammate should not need IAM access to build a UI. `GET /healthz`
reports which mode is live.

## The pipeline

```
Ring device  or  CareFlow Ring simulator
        │  signed webhook (HMAC-SHA256, X-Signature)
        ▼
Amazon API Gateway (HTTP API)        HTTPS endpoint, CORS, 5s Ring budget
        │
        ▼
AWS Lambda (Node 22, arm64)          verify → normalize → match → consent gate → act
        │
        ├──► Amazon DynamoDB          sessions, idempotency, timeline, audit trail
        ├──► Amazon Bedrock           explain the event, extract intent from speech
        ├──► Amazon Polly             neural speech for the patient-facing voice
        ├──► AWS Secrets Manager      Ring partner HMAC signing key
        └──► Amazon CloudWatch Logs   structured JSON logs, 14-day retention
```

Defined as code in [`infra/lib/careflow-stack.ts`](../infra/lib/careflow-stack.ts) (AWS CDK).
Deploy with `npm run deploy`.

## AWS Lambda

**What it does.** The whole API: the Ring webhook endpoint, visit matching, the consent
gate, action execution, and the audit trail. `services/api/src/lambda.ts` is a thin adapter
over the same `handleRequest` the local dev server uses, so "works locally" and "works
deployed" mean the same thing rather than being two code paths that drift.

**Decisions worth noting.**
- **arm64 (Graviton).** Cheaper per millisecond, and nothing here is architecture-specific.
- **10-second timeout, 1024 MB.** Ring requires a 200 within five seconds, and a cold start
  on 128 MB can eat most of that. The memory is for startup speed, not for throughput.
- **Raw request bytes preserved.** API Gateway base64-encodes binary bodies; we decode to a
  Buffer and verify the signature over those exact bytes. Decoding to a string first would
  corrupt any non-ASCII byte and break verification on payloads that are otherwise valid.
- **Event intake returns fast.** The orchestrator's first turn has a hard 2.5s deadline
  (`MODEL_DEADLINE_MS`), after which the scripted agent answers instead. Ring retries on
  non-2xx, so a slow model call would otherwise turn one doorbell press into several.

## Amazon DynamoDB

**What it does.** Single table, single-table design:

| pk | sk | item |
|---|---|---|
| `SESSION#<id>` | `META` | the conversation, its consent state, and its results |
| `EVENT#<requestId>` | `META` | Ring delivery dedupe marker, with a TTL |
| `TIMELINE#<yyyy-mm-dd>` | `<iso>#<entryId>` | what happened, in order |
| `AUDIT#<sessionId>` | `<iso>#<auditId>` | every consent decision and state change |

**Decisions worth noting.**
- **Time-prefixed sort keys.** The timeline and audit trail read back in order with one
  Query and no client-side sorting, so the demo's timeline cannot show events out of order.
- **Conditional writes for idempotency.** `attribute_not_exists(pk)` on the `EVENT#` row is
  what makes a Ring retry a no-op. Ring dedupes on `meta.request_id`, so we key on that and
  nothing else.
- **TTL on dedupe markers.** Seven days: long enough for any plausible retry, short enough
  that the table does not grow forever.
- **On-demand billing**, because hackathon traffic is a handful of requests and then none.
- **Known limitation:** the timeline read is a `Scan` with a `begins_with` filter. Correct
  for a demo spanning days, wrong at real volume — the right fix is a GSI keyed on date.
  Called out here rather than quietly shipped as if it scaled.

## Amazon Bedrock

**What it does.** Two narrow jobs, and deliberately only two:

1. **Explain the event.** Turn a normalized Ring event plus a visit match into the
   Observe/Explain/Ask utterance the patient hears.
2. **Extract intent.** Turn free speech ("tell Jordan I'll be ready in two minutes and I
   need help with my meds") into a structured `{action, params, note}`.

**What it explicitly does not do.** Bedrock never decides whether an action may run, and
never executes one. Visit matching is deterministic code (`services/api/src/lib/match.ts`)
because a model that occasionally hallucinates a scheduled visit would be worse than no
feature at all. The consent gate (`services/api/src/lib/sessions.ts`) refuses anything that
breaks the contract, and has tests that drive it with a deliberately hostile orchestrator.

**Decisions worth noting.**
- **Scoped IAM.** `bedrock:InvokeModel` on the configured model ARN only, not `*`. A
  wildcard would also let a prompt-injected agent reach every model in the account.
- **Fallback, not failure.** On error or past 2.5s the scripted orchestrator answers with
  the same conversation structure. For a care assistant, dead air is itself a failure.
- **Model id is configuration.** Set `BEDROCK_MODEL_ID`; confirm what the account can call
  with `aws bedrock list-foundation-models`. Cross-region inference profiles are prefixed
  (e.g. `us.`) and the un-prefixed id fails with an access error on most accounts.

## Amazon Polly

**What it does.** Speaks the agent's turns. `POST /api/tts` returns mp3, or `204` to tell
the browser to use its own speech synthesis.

**Decisions worth noting.**
- **Neural engine.** The difference between a warm voice and a robotic one is the difference
  between an assistant somebody will let into their home and one they switch off.
- **SSML pacing.** 92% rate with a 400ms break between sentences. This is an accessibility
  decision: the intended users may be older, may be hard of hearing, and may be walking to
  the door while listening.
- **Always degradable.** Missing credentials, no SDK, or a region without the neural engine
  all mean "use the browser voice", never "fail the turn".

## AWS Secrets Manager

**What it does.** Stores the Ring partner HMAC signing key, read once at Lambda startup.

**Why not an environment variable.** Lambda environment variables are readable by anyone
with `lambda:GetFunctionConfiguration`, and a signing key in plaintext configuration is the
kind of thing that ends up visible in a screenshot during a demo. If the secret cannot be
read, the service refuses to start rather than falling back to the dev key — accepting
webhooks nobody signed would be worse than being down.

## Amazon CloudWatch Logs

**What it does.** Every log line is single-line JSON, so Logs Insights can query it
directly. 14-day retention, set in CDK, because the default of "forever" is a slow bill.

Useful during the build:

```
fields @timestamp, msg, code, sessionId
| filter msg like /refused/
| sort @timestamp desc
```

## Amazon API Gateway (HTTP API)

**What it does.** The HTTPS endpoint Ring delivers webhooks to. HTTP API rather than REST
API: cheaper, lower latency, and we need none of REST API's extra features.

**Decisions worth noting.**
- **CORS is explicit.** The deployed stack takes an exact browser origin
  (`CAREFLOW_WEB_ORIGIN`); when omitted, CDK permits only the local Vite origin
  (`http://localhost:5173`) rather than deploying wildcard CORS.
- **The webhook path is effectively permanent.** Ring's webhook URL is set during partner
  onboarding and cannot be changed through the API, so `/ring/webhook` is fixed once
  registered.

## Not used, and why

- **Amazon Transcribe.** Speech-to-text happens in the browser via the Web Speech API. It is
  free, it is already there, and streaming audio to the cloud to transcribe it would mean
  sending a care recipient's voice off their device for no functional gain.
- **Amazon SNS / Pinpoint.** Demo mode records notifications instead of sending them,
  because the contacts in the fixture are fictional. Shipping a half-tested real-SMS path
  into a care product would be worse than not shipping one; the seam is in
  `services/api/src/lib/actions.ts`.
- **Amazon Rekognition.** CareFlow deliberately does not identify people at the door. It
  knows whether a visit is scheduled, and says so. Adding face recognition to a product for
  people receiving care at home would change what it is.
