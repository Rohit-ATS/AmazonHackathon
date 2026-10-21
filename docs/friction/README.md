# Friction log

What actually slowed us down, in the order we hit it. Each entry: the task, what we did, what
we expected, what happened, severity, the workaround, and a concrete suggestion.

**Honesty note.** This log separates two things:

- **Verified** — we hit it, with a timestamp and a workaround in the repo.
- **Unverified at time of writing** — documented behaviour we designed around but have not
  yet exercised against the live service (no Ring hardware, no deployed stack at the time of
  writing). These are marked, and we would rather flag them than imply experience we do not
  have.

Severity: **S1** blocked us · **S2** cost over an hour · **S3** cost under an hour · **S4**
a papercut.

| # | Tool | Issue | Severity | Status |
|---|---|---|---|---|
| 1 | Ring Partner API docs | No SDK, and the fact is buried in a 370k-character page | S3 | Verified |
| 2 | Ring Partner API | Webhooks need hardware + a Protect plan + a US address | S1 | Verified (as a blocker we designed around) |
| 3 | Ring Partner API docs | Webhook payload schema sits below the fold of an enormous page | S3 | Verified |
| 4 | Ring Developer Portal | Webhook URL is fixed at onboarding, not changeable via API | S3 | Unverified |
| 5 | Amazon Bedrock | Model ids vs cross-region inference profile prefixes | S2 | Unverified |
| 6 | Amazon Polly | Neural engine availability is per-region and per-voice | S3 | Unverified |
| 7 | npm | Blocked `postinstall` leaves esbuild-based tooling in an unclear state | S3 | Verified |
| 8 | npm / vitest | A fresh scaffold ships with 2 critical advisories | S3 | Verified |
| 9 | Node on Windows | Atomic `rename` fails with `EPERM` inside OneDrive | S2 | Verified |
| 10 | Web Speech API | `speechSynthesis` can fire neither `onend` nor `onerror` | S2 | Verified |
| 11 | React 19 | StrictMode double-invoked effects defeat skip-first-write guards | S2 | Verified |
| 12 | AWS CDK | `NodejsFunction` does not carry non-code assets into the bundle | S3 | Unverified |

Per-tool detail:

- [ring-api.md](ring-api.md)
- [bedrock.md](bedrock.md)
- [polly.md](polly.md)
- [aws-cdk-lambda-dynamodb.md](aws-cdk-lambda-dynamodb.md)
- [tooling.md](tooling.md)
- [web-platform.md](web-platform.md)

## The one thing we would change

Ring's simulator story. Everything else here is ordinary integration friction. But a partner
API whose central feature — webhooks — cannot be exercised at all without buying hardware and
a subscription, in one country, means the first honest thing a new developer builds is a fake.
We built a good one (byte-exact payloads, real HMAC signatures, verified by the same code path
as production), and it is genuinely demonstrable. It also took a working day that could have
gone into the product. See [ring-api.md](ring-api.md) for the specific ask.
