# CareFlow

**A companion that is there at 3am, and knows when to get a human.**

CareFlow is an always-on voice companion for people living at home who are isolated,
recovering, or receiving care. It talks like someone who knows you, remembers what you said
yesterday, helps you reach your daughter or your pharmacy — and never does any of it without
asking first.

It is **not a therapist**, and says so. When someone is struggling it stays with them,
surfaces real human help, and hands over.

Built for the [Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/).
**Alexa+** (self-hosted MCP server) · **Ring** (doorbell events) · **AWS Builder** ·
**Open Source**.

---

## The problem

The hard hours are the ones with nobody in them. Someone home after a hospital stay has a
nurse for forty minutes a day and sixteen waking hours without one — and the things that go
wrong in between are ordinary: the medication runs out on a Sunday, the evenings get long,
nobody knows you need an extra two minutes to reach the door.

An assistant that is genuinely useful there has to do two things most of them do not: be
good company, and know the exact moment to stop being the one handling it.

A typical smart doorbell says **"Motion detected."**

CareFlow says:

> "I'm an AI assistant, not a medical professional. I can help coordinate care and contact
> your care team. Your scheduled care provider, Jordan Mbeki, appears to be at the front
> door. Would you like to tell them you're ready, or ask for a few more minutes?"

The innovation is not detecting activity. It is turning one event into a context-aware,
accessible, consent-based care workflow — where nothing happens until the person says so.

## What it does

1. **Ring event intake** — a signed Ring webhook arrives and is verified before it is parsed.
2. **Scheduled-visit matching** — deterministic code decides whether this matches a visit,
   and produces a plain-English reason the UI shows verbatim.
3. **A natural conversation** — one question at a time, read aloud, with the choices on
   screen as large buttons.
4. **Consent-gated actions** — nobody is contacted until the patient explicitly confirms the
   exact action.
5. **A care handoff record** — what happened, what was asked for, what was approved, and what
   was done.

## Two ways in, one brain

| | What starts it | Where |
|---|---|---|
| **Alexa+ companion** | The person, whenever they want | MCP server, Streamable HTTP, spec 2025-11-25 — [docs/alexa-mcp.md](docs/alexa-mcp.md) |
| **Ring** | A doorbell or motion event | Ring Appstore app, four hosted URLs — [docs/ring-app.md](docs/ring-app.md) |

Same consent engine, same care plan, same refusals.

```bash
npm run mcp:demo    # drives the MCP server as a real client, start to finish
npm run demo:story  # walks the Ring story, with assertions
```

## Quick start

No AWS account, no Ring device, no credentials. A clean clone runs the full demo.

```bash
git clone https://github.com/Rohit-ATS/AmazonHackathon.git
cd AmazonHackathon
npm install
npm run dev          # API on :8787, web on :5173
```

Open **http://localhost:5173**, then press **Scheduled caregiver arrives** in the demo strip.

Prefer the terminal?

```bash
npm run dev:api        # terminal 1
npm run demo:story     # terminal 2 — walks the whole demo and asserts each step
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run demo:scheduled` | Signed Ring doorbell press inside the current visit window |
| `npm run demo:unexpected` | Signed press 45 minutes later, with no visit scheduled |
| `npm run demo:story` | The full 12-step demo, with assertions. Run it before recording |
| `npm run seed` | Validate and print the demo care plan |
| `npm test` | 93 tests |
| `npm run typecheck` | Typecheck every workspace |
| `npm run ring:link` | Link a real Ring account (OAuth 2.0 + PKCE) |
| `npm run ring:devices` | Call the real Ring Partner API with that account |
| `npm run deploy` | Deploy the AWS stack (CDK) |

## Continuous verification and GitHub Pages

GitHub Actions runs typechecking, all tests, the production web build, and CDK synthesis on
every push and pull request. After those checks pass on `main`, it deploys the web app to
GitHub Pages. See [the Pages setup](docs/connecting.md#github-pages-frontend) for the one-time
GitHub setting and `CAREFLOW_API_URL` repository variable.

Configuration is optional and documented in [`.env.example`](.env.example). `GET /healthz`
reports which mode is running, so you never have to guess.

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="CareFlow architecture: a Ring device or the CareFlow Ring simulator sends a signed webhook through API Gateway to the CareFlow Lambda, which verifies the HMAC over the raw bytes, dedupes on request_id, normalizes the event, matches the care plan in plain code, passes every sensitive action through a consent gate that the independent consent-engine package re-checks, then executes and audits. DynamoDB, Bedrock, Polly and Secrets Manager sit beneath it; the React web app reads over SSE or REST. Door unlock, alarm disarm, medical advice, medical diagnosis and emergency dispatch can never run." width="900">
</p>

Read it in one line: **a signed event comes in, the patient decides, and only then does anything
happen** — with the decision checked twice, by the API's consent gate and again by
[`@careflow/consent-engine`](packages/consent-engine), which shares no code with it.

The parts worth knowing:

- **The signature is verified over the raw bytes**, before any parsing. Parsing first is the
  single most common way to get this wrong, and it fails in a way that looks like a bug in
  your own HMAC code.
- **`meta.request_id` is the idempotency key.** Ring retries; a conditional write in DynamoDB
  makes the retry a no-op rather than a second notification to a patient's daughter.
- **Matching a visit is plain code, not a model.** Whether a caregiver is expected at 14:05 is
  a question with a right answer, and a language model is the wrong tool for it.
- **Bedrock phrases and extracts; it never decides.** Intent comes back as a tool call with an
  enumerated action id, so the model cannot invent an action that does not exist.
- **The browser renders, it does not rule.** A consent check in the frontend is a suggestion,
  since anyone can call the API directly — so every rule lives on the server.

Full AWS write-up, including what we deliberately did **not** use and why:
**[docs/aws-services.md](docs/aws-services.md)**.

## How the Ring integration works

Real Ring webhooks require a physical device, an active Ring Protect plan, and a US location.
We have none of those, and the rules allow a simulator — so the integration is built so the
simulator is **indistinguishable from production at the boundary**:

- **A real Ring Partner API client** ([`packages/ring/src/client.ts`](packages/ring/src/client.ts)):
  OAuth 2.0 PKCE account linking against `account.ring.com`, token exchange and
  rotation-aware refresh at `oauth.ring.com`, and `GET /v1/devices`, `GET /v1/devices/{id}`,
  `GET /v1/history/devices/{id}/events` against `api.amazonvision.com`. Run it with
  `npm run ring:link && npm run ring:devices`.
- **A simulator** ([`packages/ring/src/simulator.ts`](packages/ring/src/simulator.ts)) that
  emits byte-exact webhook v1.1 payloads — `meta.version`, `meta.request_id`, Ring's
  `<device>_button_press_<epoch_ms>` id convention, `attributes.source`,
  `attributes.sub_type`, `relationships.devices.links.self` — signed with a genuine
  HMAC-SHA256 `X-Signature`.
- **Production verification** ([`packages/ring/src/webhook.ts`](packages/ring/src/webhook.ts)):
  constant-time comparison over the raw bytes *before* parsing, `meta.request_id`
  idempotency, HTTP 200 inside Ring's five-second budget.

The only difference between a simulated and a real delivery is which key signed it. Swapping
in live credentials changes configuration, not code. The demo strip shows the exact signed
bytes and the signature on screen.

Proven by tests, not claims:

```
✓ a wrongly signed delivery is rejected (401)
✓ an unsigned delivery is rejected (401)
✓ a correctly signed delivery is accepted (202)
✓ a replayed delivery is deduplicated on meta.request_id
```

## Why you can trust what it does

The agent is a language model, so the guarantee cannot live in the prompt. It lives in code,
twice:

- **The domain gate** ([`services/api/src/lib/sessions.ts`](services/api/src/lib/sessions.ts))
  refuses to execute a sensitive action unless the previous state was
  `awaiting_confirmation`, the patient said yes, and the action to execute is structurally
  identical to the one they approved.
- **The consent engine** ([`packages/consent-engine`](packages/consent-engine)) enforces the
  same rules independently, as a standalone open-source package with its own tests.

Both must agree before anything is sent. The redundancy is the design: a bug in either one is
not enough to message somebody's daughter.

`services/api/test/consent-gate.test.ts` drives the gate with a *deliberately hostile*
orchestrator — one that proposes actions with no confirmation, substitutes a different message
after approval, acts after a refusal, and asks to unlock the door. Every one is refused.

## The healthcare boundary

CareFlow **coordinates care**. It does not practise medicine, and the limits are enforced in
code and visible in the app's Safety screen.

| It does | It will not |
|---|---|
| Explain what happened at the door | Diagnose anything, or discuss symptoms |
| Relay what the patient asks it to relay | Advise on medication or dosage |
| Record non-clinical handoff notes | Claim to detect a medical emergency |
| Contact patient-approved people, on approval | Contact emergency services |
| Say when a visit is scheduled | Identify who is at the door |
| | Unlock a door or disarm an alarm |

Every session opens with: *"I'm an AI assistant, not a medical professional. I can help
coordinate care and contact your care team."* The backend adds it even if the model forgets.

**Emergency assist** ships as a clearly labelled prototype, shown separately in the demo. It
is patient-initiated only — no inference from audio, motion, or inactivity — always requires
confirmation, never assesses severity, and always says: *"If this is a medical emergency,
please call emergency services directly."*

## Repository layout

```
packages/shared           types every workstream shares
packages/ring             Ring Partner API client, webhook verification, simulator
packages/consent-engine   the consent state machine (also our Open Source entry)
packages/agent            the voice agent: Bedrock, scripted fallback, safety boundaries
services/api              Lambda handlers, visit matching, consent gate, audit trail
apps/web                  React app: patient, caregiver, timeline, safety
infra                     AWS CDK stack
scripts                   demo and Ring tooling
fixtures                  fictional care plan and real Ring payloads
docs                      contract, AWS write-up, submission, friction logs
```

| Doc | What's in it |
|---|---|
| [docs/connecting.md](docs/connecting.md) | Every API and credential, and what each one upgrades |
| [docs/alexa-mcp.md](docs/alexa-mcp.md) | The MCP server: transport, tools, consent gate |
| [docs/ring-app.md](docs/ring-app.md) | CareFlow as a Ring Appstore app |
| [docs/CONTRACT.md](docs/CONTRACT.md) | The API and the seams between workstreams |
| [docs/aws-services.md](docs/aws-services.md) | Every AWS service, and the ones we skipped |
| [docs/voice-scripts.md](docs/voice-scripts.md) | Exact demo dialogue |
| [docs/submission/devpost.md](docs/submission/devpost.md) | Submission text and product feedback |
| [docs/friction/](docs/friction/) | Friction logs for every tool we used |

## Accessibility

Not a checklist item — it is the product thesis. The people CareFlow is for may be older,
hard of hearing, unsteady, or tired.

- One question per turn. Short sentences. Never a paragraph.
- Buttons are the real interface; speech is an accelerator. Recognition fails on accents, in
  noise, and on exactly these voices, so a design that depends on it excludes its own users.
- Large-text mode scales the whole layout through one multiplier, and defaults on when the
  care plan says the patient prefers it.
- 48px minimum targets, visible focus rings, keyboard-only operation, `prefers-reduced-motion`.
- Polly's neural voice is paced at 92% with pauses between sentences.
- The confirmation window is ten minutes, not the engine's 60-second default, because a
  window that expires while someone is still deciding punishes the people the product exists
  for.

## Privacy

No real patient data, ever — `npm run seed` fails the build if a contact address does not look
fictional. No face recognition. No audio leaves the browser: speech-to-text uses the Web
Speech API rather than streaming a care recipient's voice to the cloud. In demo mode
notifications are recorded rather than sent. The patient controls who may be contacted, and
CareFlow refuses to notify anyone they have not approved.

## Tests

```bash
npm test
```

93 tests: Ring signature verification and payload shape, visit matching, the consent gate
under a hostile orchestrator, the consent engine's seven guarantees, and the safety
boundaries.

## License

MIT — see [LICENSE](LICENSE).
