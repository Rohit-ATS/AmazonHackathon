# Connecting CareFlow to real services

**Nothing here is required to run the project.** A clean clone with no credentials runs the
whole thing: local JSON store, scripted agent, browser speech, the Ring simulator, and the
MCP server. `GET /healthz` tells you which mode each piece is in, so you never have to guess.

This document is about what each credential *upgrades*, in the order worth doing it.

---

## Tier 0 — what already works, with nothing connected

```bash
npm install && npm run dev
npm run mcp:demo      # full companion conversation over MCP
npm run demo:story    # full Ring story, with assertions
```

| Piece | Without credentials | What you lose |
|---|---|---|
| MCP server | Fully real | Nothing. The transport and consent gate are complete |
| Ring webhooks | Signed simulator, verified for real | Events come from us, not Ring's servers |
| Conversation | Scripted orchestrator | Wording is fixed rather than generated |
| Voice | Browser speech synthesis | A robotic voice instead of a warm one |
| Storage | Local JSON file | Nothing until you deploy |
| Notifications | Recorded, shown in the UI | Nothing is actually transmitted |

---

## Tier 1 — talk to it for real, today (15 minutes, free)

The fastest way to have an actual conversation with the companion is to point a real MCP
client at it. Any MCP host works; the server is spec-compliant.

```bash
npm run dev:api                              # serves /mcp on :8787
npx @modelcontextprotocol/inspector          # the standard MCP debugging client
```

Connect it to `http://localhost:8787/mcp`, transport **Streamable HTTP**. You will see all
17 tools, can call them by hand, and can watch the confirmation gate refuse to act until
`confirm_action` arrives.

For a client that uses a real model, add CareFlow to its MCP config:

```json
{ "mcpServers": { "careflow": { "type": "http", "url": "http://localhost:8787/mcp" } } }
```

**No account, no key, no cost.** This is the thing to do first.

---

## Tier 2 — AWS (the biggest upgrade per unit of effort)

One account unlocks Bedrock, Polly, DynamoDB, Lambda, API Gateway and Secrets Manager.

### Setup

```bash
aws configure                 # access key, secret, default region
npx cdk bootstrap             # once per account/region
npm run deploy                # outputs ApiUrl, RingWebhookUrl, TableName
```

### Amazon Bedrock — the conversation stops being scripted

The one with a real gotcha. Model access is granted **per account, per region**, and a model
being listed does not mean it is callable.

```bash
aws bedrock list-foundation-models --query "modelSummaries[].modelId" --output table
```

Request access in the Bedrock console, then:

```bash
BEDROCK_MODEL_ID=us.anthropic.<model-id>
```

**Watch the prefix.** Cross-region inference profiles are prefixed (`us.`, `eu.`), and the
un-prefixed id fails with an access error that does not tell you that is the problem. Our
CDK grants IAM on both ARN shapes, so IAM will not be what breaks.

Without it: the scripted orchestrator answers, and the demo still works.

### Amazon Polly — the voice stops sounding robotic

No extra setup beyond credentials and a region.

```bash
CAREFLOW_TTS=polly
POLLY_VOICE_ID=Joanna
```

Not every voice supports the neural engine in every region. On any failure the API returns
`204` and the browser speaks instead, so this cannot break a demo.

### DynamoDB, Lambda, API Gateway, Secrets Manager

All provisioned by `npm run deploy`. The one you must set by hand is the Ring signing key,
which deliberately does not live in an environment variable:

```bash
aws secretsmanager create-secret --name careflow/ring-hmac-key --secret-string "<key>"
```

The deployed service **refuses to start** if it cannot read that secret. Accepting webhooks
nobody signed would be worse than being down.

### Cost

Pennies for a hackathon. Bedrock is per-token, Polly per-character, DynamoDB on-demand,
Lambda free-tier. The thing to actually watch is leaving the stack up afterwards —
`npm run destroy` when you are done.

---

## Tier 3 — a public HTTPS URL

**Both** Ring webhooks and a hosted Alexa+ MCP server need one. Two options:

| Option | Command | Good for |
|---|---|---|
| Deploy | `npm run deploy` | The real thing. API Gateway gives you HTTPS |
| Tunnel | `cloudflared tunnel --url http://localhost:8787` | Iterating locally against real Ring events |

With a tunnel, set `CAREFLOW_SELF_URL` to the public URL so the demo controls post to the
right place.

---

## Tier 4 — Ring (where the real blocker is)

From the Amazon Developer Portal → Ring → create an app. You get three values, shown once:

```bash
RING_CLIENT_ID=...
RING_CLIENT_SECRET=...
RING_HMAC_KEY=...
```

Register the four URLs (`GET /ring/status` prints them resolved) and set the scope to
`ava.v1:read`. Then:

```bash
npm run ring:link      # OAuth, opens the authorize page
npm run ring:devices   # proves it: real devices, real event history
```

**The blocker, stated plainly:** Ring only delivers webhooks to a staging user with a
**physical Ring device**, an **active Ring Protect plan**, and a **US address**. Credentials
alone get you the REST API — devices and event history — but not live doorbell events.

That is why the simulator exists and why it signs payloads for real. See
[friction/ring-api.md](friction/ring-api.md); it is our strongest piece of product feedback.

---

## Tier 5 — Alexa+ itself

The MCP server is complete and spec-compliant today. What I **cannot tell you from the
documentation I have read** is the exact mechanism for registering a self-hosted MCP server
with Alexa+ for the developer preview — whether it is a console registration, an allowlist,
or something else.

Rather than guess: ask in the hackathon office hours or the Devpost discussion. It is a
ten-minute question for someone who knows, and the answer changes nothing about the code —
the server is already serving the right protocol at the right URL.

The rules also allow a **simulated Alexa+ experience in a web app** as an accepted path, and
our web app plus `npm run mcp:demo` already cover that. So this is not on the critical path
for submitting.

---

## Tier 6 — things that are simulated, and should stay that way for now

These are recorded rather than transmitted in demo mode. Each has a real seam in
[`services/api/src/lib/actions.ts`](../services/api/src/lib/actions.ts).

| Capability | What a real version needs | My recommendation |
|---|---|---|
| SMS / messaging | Amazon SNS, Pinpoint, or Twilio | Leave simulated |
| Phone calls | Amazon Connect or Twilio Voice | Leave simulated |
| Pharmacy refills | No public API — integrations are per-pharmacy chain | Leave simulated |
| Appointment booking | An EHR or practice scheduling system | Leave simulated |

**Why leave them:** the contacts in the demo are fictional, so there is nobody to message.
More importantly, shipping a half-tested pharmacy order into a care product — where a
mistake means somebody's medication — is not a trade worth making for a demo. The tool
descriptions already tell the model to report honestly: a refill is a *request* the pharmacy
confirms separately, not a completed order.

Judges tend to respect a clearly-labelled simulation more than a half-working integration,
and the friction logs say exactly which is which.

---

## The practical order

1. **`npx @modelcontextprotocol/inspector` against `localhost:8787/mcp`** — free, 15 minutes,
   and you get to actually talk to the thing.
2. **AWS account + `npm run deploy`** — real Bedrock conversation, real Polly voice, real
   HTTPS URL. This is the single biggest upgrade.
3. **Ring credentials** — proves the API integration with `npm run ring:devices`, even
   without a device.
4. **Ask about Alexa+ registration** in office hours.
5. **Leave tier 6 simulated** and say so on camera.

## Full environment reference

Every variable, with defaults, is in [`.env.example`](../.env.example). Nothing in it is
mandatory.
