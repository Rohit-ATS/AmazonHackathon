# Devpost submission

Copy-paste ready. Anything in **[brackets]** needs filling in before submitting.

---

## Project name

**CareFlow: Voice-First Care Access with Ring**

## Elevator pitch (one line)

CareFlow turns Ring events into a calm, consent-based voice conversation, so people receiving
care at home can handle the door safely without a phone, an app, or a sprint across the
living room.

## Tracks

- **Primary track:** Ring
- **Mini challenges:** AWS Builder · Open Source

---

## About the project

### Inspiration

For someone home after a hospital stay, the doorbell is not a notification problem. It is
three problems at once: getting to the door in time, knowing whether it is safe to answer, and
telling a waiting nurse you need two more minutes. A typical smart doorbell says "Motion
detected." That is a description of a pixel change, offered to someone who may be halfway
across the room with a walker.

The people this affects most are the ones least served by a phone-first interface — which is
exactly the gap Ring's accessibility and caretaking priority areas point at.

### What it does

CareFlow receives a Ring event and turns it into a conversation:

> "I'm an AI assistant, not a medical professional. I can help coordinate care and contact
> your care team. Your scheduled care provider, Jordan Mbeki, appears to be at the front door.
> Would you like to tell them you're ready, or ask for a few more minutes?"

The patient answers out loud, or with one large button. If they ask CareFlow to tell the nurse
they need two minutes and could use help organising their medications, CareFlow asks to
confirm, sends the message only after an explicit yes, and files a structured handoff note the
caregiver sees before they knock again.

When somebody turns up outside any scheduled visit, CareFlow says so, explains why it thinks
so, and offers to contact a trusted person — again, only on an explicit confirmation. Every
step lands in an auditable timeline.

Five capabilities: Ring event intake · scheduled-visit matching · a natural voice
conversation · consent-gated actions · a care handoff record.

### How we built it

```
Ring device or CareFlow Ring simulator
   └─ signed webhook (HMAC-SHA256, X-Signature)
      └─ Amazon API Gateway (HTTPS, Ring's 5s budget)
         └─ AWS Lambda
            ├─ verify signature over raw bytes, constant time
            ├─ dedupe on meta.request_id
            ├─ normalize to a CareEvent
            ├─ match against the care plan (deterministic code)
            ├─ CONSENT GATE ──► @careflow/consent-engine (independent second check)
            └─ execute + audit
               ├─ Amazon DynamoDB  sessions, idempotency, timeline, audit trail
               ├─ Amazon Bedrock   phrase the turn, extract intent
               └─ Amazon Polly     neural voice
                  └─ React app: patient · caregiver · timeline · safety
```

**The Ring integration is real, and the simulator is honest about being a simulator.** Real
Ring webhooks need a physical device, an active Protect plan, and a US address. We have none
of those, and the rules allow a simulator — so we built one designed to be indistinguishable
from production at the boundary. It emits byte-exact webhook v1.1 payloads, down to Ring's
`<device>_button_press_<epoch_ms>` id convention and epoch-millisecond timestamps, signed with
a genuine HMAC-SHA256 `X-Signature`. Our handler verifies them exactly as it would verify
Ring: constant-time comparison over the raw bytes before parsing, `meta.request_id`
idempotency, a 200 inside five seconds. The only difference between a simulated delivery and a
real one is which key signed it.

Alongside it, a real Ring Partner API client: OAuth 2.0 PKCE account linking, rotation-aware
token refresh, and `GET /v1/devices`, `GET /v1/devices/{id}`,
`GET /v1/history/devices/{id}/events` against `api.amazonvision.com`. Run
`npm run ring:link && npm run ring:devices`.

**The safety architecture is the interesting part.** The agent is a language model, so the
guarantee cannot live in the prompt. Bedrock does exactly two jobs — phrase the turn, and
extract an intent as a tool call constrained to an enumerated set of already-offered actions.
It never decides whether an action may run. Visit matching is plain deterministic code,
because a model that occasionally hallucinates a scheduled visit would be worse than no
feature at all.

Whether anything may actually happen is decided twice, by two independent implementations: the
domain gate in the backend, and `@careflow/consent-engine`, our standalone open-source package.
Both must agree. The redundancy is the design — a bug in either one is not enough to message
somebody's daughter.

### Challenges we ran into

**No way to receive a real Ring event.** Webhooks require hardware, a subscription, and a US
location. That reframed day one: instead of integrating, we were deciding how to build a
simulator we could defend on camera. The answer was to make the simulator produce real signed
payloads over real HTTP into the real verification path, so nothing is stubbed and nothing is
bypassed.

**Proving a safety property rather than asserting it.** It is easy to write "we always ask for
consent". We wanted it to be checkable, so the consent-gate test suite drives the system with
a deliberately hostile orchestrator — one that proposes actions with no confirmation,
substitutes a different message after approval, acts after a refusal, and asks to unlock the
door. Every attempt is refused, and each refusal is a named test.

**Where the healthcare line sits.** "Tell the nurse I need help organising my medications" is
coordination and must work. "Should I take a double dose?" is medical advice and must not be
answered. The line is enforced before the model is called, not in its prompt, and the refusal
always comes with a real alternative — a refusal that leaves someone with nothing is not good
enough.

**A microphone button that could brick itself.** Driving the real UI in a headless browser
caught `speechSynthesis` firing neither `onend` nor `onerror`, leaving `speaking` true forever
and the mic permanently disabled. The same failure is documented on desktop Chrome when voices
have not loaded. Fixed with a length-proportional timeout — and a reminder that the on-screen
buttons must always be a complete path.

### Accomplishments we're proud of

- Signature tampering and replay are rejected, with tests that prove it rather than claim it.
- A consent engine good enough to be useful to someone else's agent, with 31 tests covering
  seven named guarantees.
- A refusal set we are happy to demo: door unlock, medical advice, emergency dispatch, and
  identifying who is at the door are all declared, enforced, and visible in the app.
- It runs on a clean clone with no AWS account, no Ring credentials, and no device.
- 93 tests, and `npm run demo:story` walks all twelve demo steps with assertions.

### What we learned

Making an AI agent *safe to act* is a systems problem, not a prompting problem. Every useful
constraint we added ended up as a state machine, a type, or a test — never a sentence in a
prompt. The sharpest version: `choose()` requires an exact action id, so a model cannot "sort
of" trigger a notification.

We also learned that the accessibility constraints improved the product for everyone. One
question per turn, short sentences, and buttons that are always a complete path make a better
interface than the voice-first design we started with.

### What's next for CareFlow

Real device testing with a Ring Protect account. Multi-patient and multi-caregiver support for
a home-care agency. Real notification delivery, which we deliberately left unimplemented
rather than ship half-tested into a care product. And publishing the consent engine to npm —
the problem it solves is not specific to doorbells.

---

## Built with

`ring-partner-api` `aws-lambda` `amazon-bedrock` `amazon-dynamodb` `amazon-polly`
`amazon-api-gateway` `aws-secrets-manager` `aws-cdk` `typescript` `react` `vite` `node`
`web-speech-api` `vitest`

---

## Repository

**[https://github.com/Rohit-ATS/AmazonHackathon](https://github.com/Rohit-ATS/AmazonHackathon)**

Public, MIT licensed. Architecture diagram:
[`docs/architecture.svg`](../architecture.svg), rendered at the top of the README.

Clone and run:

```bash
npm install && npm run dev
```

**[If the repo is private at submission time, add these reviewers as collaborators —
invitations expire after 7 days, so do it at submission, not before: knmeiss, giolaq,
anishamalde, mosesroth, emersonsklar]**

## Demo video

**[YouTube or Vimeo URL — public, English, under 3 minutes]**

Script and timing: `docs/voice-scripts.md`.

---

## Was this built during the hackathon?

Yes. The repository was created during the submission window and every commit falls inside it.
No part of CareFlow existed beforehand. First commit: the Ring integration, backend, and AWS
infrastructure; subsequent commits add the consent engine, the Bedrock orchestrator, and the
web app.

---

## AWS Builder mini challenge

**Which AWS services, and how.** Full write-up in
[`docs/aws-services.md`](../aws-services.md), including the services we deliberately did not
use and why.

| Service | What it does in CareFlow |
|---|---|
| **AWS Lambda** | The whole API. Webhook intake, visit matching, consent gate, action execution. arm64, 10s timeout sized against Ring's 5s budget. The same `handleRequest` serves local dev and Lambda, so there is one code path. |
| **Amazon DynamoDB** | Single-table design: sessions, `request_id` idempotency markers with TTL, timeline, audit trail. Time-prefixed sort keys so history reads back in order with one Query. Conditional writes make a Ring retry a no-op. |
| **Amazon Bedrock** | Two jobs only: phrase the Observe/Explain/Ask turn, and extract intent as a tool call with an enumerated action id. It never decides whether an action may run. IAM is scoped to the configured model, not `*`. |
| **Amazon Polly** | Neural voice for the patient, paced at 92% with SSML breaks — an accessibility decision. Degrades to browser speech rather than failing a turn. |
| **Amazon API Gateway** | HTTPS endpoint for Ring webhooks. HTTP API, explicit CORS origin in the deployed stack. |
| **AWS Secrets Manager** | The Ring partner HMAC key. Never an environment variable; the service refuses to start if it cannot read the secret. |
| **Amazon CloudWatch Logs** | Single-line JSON logs queryable in Logs Insights, 14-day retention set in CDK. |
| **AWS CDK** | The stack as typechecked TypeScript. IAM defined next to what it grants. |

The pipeline is multi-service by necessity, not decoration: a signed webhook enters through
API Gateway, Lambda verifies and matches it, DynamoDB provides the idempotency guarantee that
makes Ring's retries safe, Bedrock supplies language, Polly supplies voice, and Secrets
Manager holds the key that makes the whole chain trustworthy.

---

## Open Source mini challenge

**Contribution URL:** **[https://github.com/Rohit-ATS/careflow-consent-engine — push
`packages/consent-engine` to this repo and paste the final URL]**

**Main repo:** https://github.com/Rohit-ATS/AmazonHackathon

**GitHub username:** **[Rohit-ATS]**

**What it is.** `careflow-consent-engine` — a dependency-free TypeScript consent state machine
for AI agents that can take real-world actions. MIT licensed.

**How it works.** The agent proposes; the machine decides.
`observe → offer → choose → confirm → complete`, with `cancelled` and `timed_out`. Sensitive
actions require an explicit confirmation turn; non-sensitive ones skip it. The chosen action
is deep-frozen at choose time, and `assertExecutable()` — called immediately before the side
effect — throws unless that exact descriptor, payload included, is what was approved.

Seven guarantees, each with a test that would fail if the property were only a convention:

1. `confirm()` throws from any state but `awaiting_confirmation`.
2. The executed action is structurally identical to the approved one — same id but a different
   message still fails.
3. A repeated `confirm()` is recorded and ignored, so a double-tap or retried request cannot
   send twice.
4. Blocked capabilities are refused when offered, when chosen, at the moment of consent, and
   again at execution — including for a machine rehydrated from a snapshot written before the
   blocklist changed.
5. `choose()` requires an exact action id. No fuzzy matching, so a model cannot "sort of"
   trigger a notification.
6. Pending confirmations expire, checked lazily so a machine restored from storage comes back
   `timed_out` rather than still-pending.
7. `history()` is an append-only audit trail; mutating the returned array does nothing.

31 tests, a README with a runnable example, and `examples/ring-doorbell.ts` driven by genuine
Ring webhook payloads from `fixtures/ring-events/`.

**Why it matters.** An LLM agent with tools will eventually call one it should have asked
about first. "Always confirm before sending" is an instruction to a system whose job is
generating plausible text, and a plausible confirmation is not a confirmation. This moves the
guarantee out of the prompt and into a state machine, in about 400 lines with no dependencies.
It is used in CareFlow as a second, independent enforcement alongside the backend's own
checks, and it knows nothing about Ring, care, or voice — so it drops into any agent that can
act on someone's behalf.

---

## Product feedback

Full friction logs with severities and reproduction steps: [`docs/friction/`](../friction/).
Summary:

**Ring Partner API — would build with again.** The auth model is right: PKCE, rotating refresh
tokens, and a read-only `ava.v1:read` scope by default. That scope became a product feature —
we can truthfully tell a patient the assistant has no door control. Rate limits are documented
with real numbers and the right headers. The five-second webhook budget being stated
explicitly directly shaped our architecture (the model call got a 2.5s deadline because of
it), and naming `meta.request_id` as the dedupe key meant we got retry semantics right first
time.

**What needs work, in priority order.**

1. **There is no way to receive a test webhook without hardware.** A physical device, an
   active Protect plan, and a US address are all required. For any developer evaluating Ring,
   the first honest thing they build is a fake. A "Send test event" button in the Developer
   Portal would be the single highest-leverage change for adoption, and it is days of work,
   not months. A virtual staging device would be even better.
2. **Publish a signature verification vector** — a key, a body, and the expected header value.
   The algorithm is described accurately, but the critical detail ("hash the body exactly as
   received, before parsing") is easy to read past, and a developer who parses first gets
   failures with no clue why. Three lines of docs would let every partner prove their
   implementation in a minute.
3. **The documentation is one ~370,000-character page.** "There is no official SDK" and the
   webhook payload schema are both in there and both take a long time to find. Splitting
   webhooks onto their own page, and putting an example payload beside each event type, would
   recover an hour per team.
4. **Onboarding should state the hardware requirement up front**, before a developer invests a
   day planning around webhooks.

**Amazon Bedrock.** Onboarding is good and the Converse API is the right abstraction — one
request shape, first-class tool use, which let us constrain intent extraction to an enumerated
set of actions instead of parsing prose. The rough edge is identity: model ids and
cross-region inference profile ids differ only by a prefix, and the un-prefixed id fails with
an access error that does not suggest the fix. `list-foundation-models` returning an
`accessStatus` field would also help. Would use again.

**Amazon Polly.** A single call, mp3 straight back, and SSML gives exactly the pacing control
this product needs. The one lookup we would like to skip is voice × region × engine
availability, which is per-voice and per-region and errors in a way that points at the wrong
thing. Would use again.

**AWS Lambda, DynamoDB, API Gateway, Secrets Manager, CDK.** Unremarkable in the best way. Two
notes. First, `NodejsFunction` bundles code but not runtime assets, so a JSON fixture read with
`fs` vanishes silently; a first-class `assets:` option would meet a common need, and the
`commandHooks` escape hatch requires writing shell for two platforms. Second, API Gateway
base64-encodes binary bodies, which will corrupt a webhook signature for anyone who reads
`event.body` as a string — worth a callout in the webhook-handling docs, since it produces
failures that look like a bug in your own HMAC code. CDK's value showed up concretely:
typechecking the infrastructure caught two mistakes before deploy.

**Honesty note.** Our Bedrock, Polly, and CDK integrations are written and typechecked but
were not yet exercised against the live services at the time of writing; those friction
entries are marked as design-time rather than runtime, and the files say so.

---

## Optional: feature requests

| Request | Why | Urgency |
|---|---|---|
| A "Send test event" button, or a virtual staging device, in the Ring Developer Portal | Today the core event path cannot be exercised without buying hardware and a subscription, in one country. It is the biggest barrier to anyone evaluating Ring. | **Critical** |
| A published webhook signature verification vector | Signature verification is the one thing a partner must get exactly right, and it is currently proven only by reading prose carefully. | **Important** |
| Split the Ring API docs; example payload per event type | One ~370k-character page hides the two things every integrator needs first. | **Important** |
| `accessStatus` on `bedrock:ListFoundationModels` | A listed model is not necessarily a callable one, and you find out by failing. | **Important** |
| `assets:` option on CDK `NodejsFunction` | Runtime assets vanishing from a bundle is a silent failure with a confusing symptom. | Nice-to-have |
| Writable webhook URL via the Ring API | A URL that can only change through a portal UI makes tunnel-based local development painful. | Nice-to-have |
