# Friction: Ring Partner API

**Used for:** OAuth account linking, device and event-history reads, and webhook signature
verification. The whole Ring track hinges on this, so it got the most attention.

**Would we build with it again?** Yes. The API itself is clean, the webhook signing scheme is
the right one, and the docs are unusually specific where it matters (exact header names, exact
retry budget). The friction is almost entirely about *getting started*, not about the API.

---

## 1. There is no SDK, and finding that out takes a while — S3, verified

**Task.** Find the official Ring SDK and start from it.

**What we did.** Opened the API documentation and searched for an SDK or client library.

**Expected.** A one-line answer near the top: "there is no SDK, use an HTTP client."

**What happened.** The page is ~370,000 characters. The sentence "There is no official Ring
Partner SDK" is real and correct, but it is a long way down, and the hackathon resources page
returns HTTP 403 to a plain fetch, so we could not quickly cross-check. We spent about forty
minutes reading before we were confident we were not missing something.

**Workaround.** Wrote a small typed client by hand —
[`packages/ring/src/client.ts`](../../packages/ring/src/client.ts). This turned out fine; the
API is simple enough that a generated SDK would not have helped much.

**Suggestion.** Put "No SDK — use any HTTP client. Here is a 20-line example." in a box at the
top of the API documentation, and on the hackathon resources page. For a weekend hackathon,
the first question every developer asks is "what do I install?", and the answer is currently
40 minutes deep.

---

## 2. Webhooks require hardware, a subscription, and a US address — S1, verified as a blocker

**Task.** Receive a real doorbell event in a local development environment.

**What we did.** Followed the Develop and Test documentation through to the point of
delivering a webhook to a staging user.

**Expected.** Some way to trigger a test event — a "send test webhook" button, a sandbox
device, a CLI command, anything.

**What happened.** Webhook delivery requires a physical Ring device on an active Ring Protect
plan, located in the US. There is no documented way to have Ring send you a webhook without
all three. For a hackathon team without Ring hardware, the core event path of the Ring track
is unreachable.

**Severity: S1.** Not because it stopped the project — the rules explicitly allow a simulator
— but because it changed what the first day was spent on.

**Workaround.** Built a simulator designed to be indistinguishable from production at the
boundary ([`packages/ring/src/simulator.ts`](../../packages/ring/src/simulator.ts)): byte-exact
webhook v1.1 payloads including Ring's `<device>_button_press_<epoch_ms>` id convention, signed
with a real HMAC-SHA256 `X-Signature` over the exact bytes sent. Our webhook handler verifies
them the production way, so simulated deliveries exercise the real code path instead of
bypassing it. Swapping in live credentials changes configuration, not code.

**Suggestion, in priority order.**

1. **A "Send test event" button in the Developer Portal.** Pick a device id, pick an event
   type, press send. This is the single highest-leverage thing for developer adoption, and it
   is a few days of work.
2. **A virtual staging device.** One that appears in `GET /v1/devices` and can emit events.
   It would let partners build and test the whole integration before owning hardware.
3. **Publish a signed example payload per event type**, with the HMAC key used to sign it, so
   developers can verify their verification. We had to derive our confidence from the prose
   description of the algorithm rather than from a known-good example, which is the kind of
   thing that is easy to get subtly wrong (see below).

The Playground mentioned in the May 2026 release notes looks like it addresses part of this;
it was not discoverable from the path we followed through the docs.

---

## 3. The webhook payload schema is below the fold — S3, verified

**Task.** Learn the exact field names so our simulator could match them.

**What we did.** Read the API documentation, then had to request the second 100k-character
chunk of the page to reach "Webhook v1.1 Payload Structure".

**Expected.** Webhook payloads documented on their own page, or at least linked from the
events list.

**What happened.** The event-type list and the payload schema are far apart in one very long
page. We nearly built against a guessed schema.

**Details that mattered and were easy to miss:**
- `data.id` follows a different convention per event type: `<device>_button_press_<ts>` but
  `<device>_motion_<ts>`. We would have guessed one pattern for both.
- `attributes.timestamp` is epoch **milliseconds**, while `meta.time` is ISO-8601. Mixing
  them up produces timestamps in 1970 that look like a bug in your own code.
- `motion_detected` carries extra attributes (`timestamp_readable`, `sub_type`) that
  `button_press` does not.

**Suggestion.** Split webhooks onto their own documentation page, and put a complete example
payload next to each event type in the event-type table. The information is all there; it is
the layout that costs time.

---

## 4. Signature verification is described, not demonstrated — S3, verified

**Task.** Implement `X-Signature` verification correctly.

**Expected.** A code sample, or at least a worked example with a fixed key, a fixed body, and
the expected hex digest.

**What happened.** The algorithm is described accurately in prose — HMAC-SHA256 over the raw
body, hex, `sha256=` prefix, constant-time compare. The one critical detail, "hash the body
exactly as received, before any JSON parsing", is stated but easy to read past. A developer
who parses the JSON first and re-serializes it will get a signature that never matches, with
no indication of why.

**Workaround.** We wrote a test that signs compact JSON and verifies against pretty-printed
JSON of the same object, asserting that it fails — which pins the exact mistake we were
worried about. See `packages/ring/test/webhook.test.ts`.

**Suggestion.** Publish a verification vector: a key, a body, and the expected header value.
Three lines of documentation that would let every partner prove their implementation in a
minute.

---

## 5. Webhook URL is fixed at onboarding — S3, unverified

**What the docs say.** The webhook URL is configured during partner onboarding and cannot be
changed through the API; it is self-managed through the Development Portal.

**Why it is friction.** Local development against a tunnel URL (ngrok and similar) means a URL
that changes on every restart. If it can only be changed through a portal UI, iterating on a
laptop is painful.

**Status.** We did not get to exercise this, since we had no device to deliver webhooks from.
Flagging it because the constraint is documented and it would bite a team with hardware.

**Suggestion.** Allow a webhook URL update via the API, or support multiple registered URLs
per app with one marked as the development target.

---

## What worked well

Worth saying, since a friction log skews negative:

- **The auth model is correct.** PKCE on the partner-initiated flow, rotating refresh tokens,
  a read-only scope by default. `ava.v1:read` meaning CareFlow *cannot* unlock a door is a
  genuinely good default, and we built a product feature out of it — we can tell a patient
  truthfully that the assistant has no door control.
- **Rate limits are documented with real numbers** (100 TPS per partner) and the right headers
  (`X-RateLimit-*`, `Retry-After`). Many APIs leave you to discover this in production.
- **The five-second webhook budget is stated explicitly**, which directly shaped our
  architecture: the model call got a 2.5s deadline and a fallback because of that sentence.
- **`meta.request_id` for idempotency** is called out clearly. Retry semantics are usually
  where integrations rot, and having the dedupe key named in the docs meant we got it right
  on the first pass.
