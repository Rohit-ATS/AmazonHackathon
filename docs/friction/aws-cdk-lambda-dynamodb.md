# Friction: AWS CDK, Lambda, DynamoDB, API Gateway, Secrets Manager

**Used for:** the deployed stack —
[`infra/lib/careflow-stack.ts`](../../infra/lib/careflow-stack.ts).

**Status: the stack is written and typechecks against `aws-cdk-lib`, but is unverified — not
yet deployed at time of writing.** The entries below are design-time decisions and anticipated
friction. Updated after the first `cdk deploy`.

---

## 1. `NodejsFunction` bundles code, not assets — S3, anticipated

esbuild bundles the dependency graph, which is exactly right for code and silently wrong for
anything read at runtime. Our care plan is a JSON fixture read with `fs` at startup, so it is
invisible to the bundler and would be missing in Lambda with an unhelpful ENOENT.

**What we did about it.** An `afterBundling` command hook copies `fixtures/care-plan.json`
into the bundle, with separate commands for Windows (`xcopy`) and POSIX (`cp`) — the hook
emits shell strings, so it is platform-specific by nature, and a Mac-only hook would have
broken our Windows machine.

**Suggestion.** A first-class `assets: ['path']` option on `NodejsFunction` would meet a
common need simply. The `commandHooks` escape hatch works, but it requires writing shell for
two platforms.

## 2. The Ring HMAC key must not be an environment variable — design decision

Lambda environment variables are readable by anyone with
`lambda:GetFunctionConfiguration`, and a webhook signing key in plaintext configuration is the
kind of thing that ends up visible in a screenshot during a demo.

The key lives in Secrets Manager and is read once at cold start. If it cannot be read, the
service **refuses to start** rather than falling back to the development key — accepting
webhooks nobody signed would be worse than being down. `loadConfig()` throws if a deployed
environment has neither `RING_HMAC_KEY` nor `RING_HMAC_SECRET_NAME`.

## 3. Raw request bytes through API Gateway — S2, anticipated and designed around

Ring's signature covers the exact bytes of the request body. API Gateway base64-encodes binary
bodies, and the obvious implementation — read `event.body` as a string — corrupts any
non-ASCII byte before verification, producing signature failures that look like a bug in your
own HMAC code.

`services/api/src/lambda.ts` decodes to a `Buffer` with the correct encoding and passes the
raw bytes through untouched. This is the single most likely thing to break on first deploy, so
it is called out here and commented in the code.

## 4. Decisions we would defend in review

- **arm64 (Graviton).** Cheaper per millisecond, and nothing here is architecture-specific.
- **10s timeout, 1024 MB.** Ring requires a 200 within five seconds; a cold start on 128 MB
  can eat most of that. The memory buys startup speed, not throughput.
- **DynamoDB single table with time-prefixed sort keys.** The timeline and audit trail read
  back in order with one Query and no client-side sorting, so the demo cannot show events out
  of order under load.
- **Conditional writes for idempotency.** `attribute_not_exists(pk)` on the `EVENT#` row is
  what makes a Ring retry a no-op.
- **TTL on dedupe markers.** Seven days — long enough for any plausible retry, short enough
  that the table does not grow forever.
- **A known limitation, stated rather than hidden:** the timeline read is a `Scan` with a
  `begins_with` filter. Correct for a demo spanning days, wrong at real volume; the right fix
  is a GSI keyed on date.

## 5. HTTP API over REST API

Cheaper, lower latency, and we need none of REST API's extra features. The one thing to know
is that CORS configuration differs between the two, so half the search results do not apply.
The deployed stack takes an explicit browser origin; `*` is the local development default
only.

**Would we build with it again?** CDK, yes — defining IAM next to the thing it grants access
to is worth the build complexity, and typechecking the infrastructure caught two mistakes
before deploy. The `NodejsFunction` asset gap is the one rough edge.
