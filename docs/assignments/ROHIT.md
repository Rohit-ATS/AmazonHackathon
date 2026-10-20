# Rohit — Ring integration, backend, AWS

**Owns:** `packages/ring/**`, `packages/shared/**`, `services/api/**`, `infra/**`,
`scripts/**`, `fixtures/**`.

This is the track-critical path. "Tech Implementation" asks how effectively the project uses the
required tech, and the Ring track requires that the repo *actually call* Ring technology — an
import, an entry point, a real request — not a README mention. If this part is weak, no amount of
UI polish rescues the submission.

## Constraint found in the Ring docs

Real Ring webhooks require a physical Ring device, an active Ring Protect plan, and a US
location. We have none of those. The rules explicitly allow a simulator, so the integration is
built such that the simulator is *indistinguishable from production at the boundary*:

- A real Ring Partner API client against `https://api.amazonvision.com`: OAuth 2.0 PKCE account
  linking, `POST https://oauth.ring.com/oauth/token` exchange and refresh, `GET /v1/devices`,
  `GET /v1/devices/{id}`, `GET /v1/history/devices/{id}/events`. Real code paths, switchable to
  live credentials with env vars alone.
- A simulator that emits **byte-exact Ring webhook v1.1 payloads** (`meta.version`,
  `meta.request_id`, `data.id` in Ring's `<device>_button_press_<ts>` form, `attributes.source`,
  `attributes.sub_type`, `relationships.devices.links.self`) signed with a real HMAC-SHA256
  `X-Signature: sha256=<hex>` over the raw body.
- A webhook handler doing production verification: constant-time signature compare over raw
  bytes before parsing, `meta.request_id` idempotency, and HTTP 200 inside Ring's 5-second
  budget with the slow work deferred.

That combination is honest, demonstrable on camera, and far stronger than a mocked fetch.

## Work items

1. `packages/shared` — types and care-plan schema. Do this first; it unblocks both teammates.
2. `packages/ring` — OAuth client, API client, webhook verification, event normalization,
   simulator, Ring fixtures.
3. `services/api` — Lambda handlers as pure functions, a local dev server wrapping the same
   handlers, a DynamoDB store with a local JSON fallback so teammates need no AWS account,
   scheduled-visit matching, action executors, audit log, SSE, and the Polly TTS proxy.
4. `infra` — CDK: Lambda, API Gateway (HTTPS, which Ring requires), DynamoDB single table,
   Bedrock and Polly IAM, CloudWatch log retention.
5. Scripts — `dev:api`, `demo:scheduled`, `demo:unexpected`, `ring:link`, `ring:devices`,
   `seed`, `deploy`.
6. Secrets hygiene — nothing but `.env.example` in git; client secret and HMAC key from SSM or
   Secrets Manager in deployed mode. Judges read repositories.
7. Friction log and product feedback for Ring API, Lambda, DynamoDB, Polly, API Gateway, and CDK.

## Definition of done

- [ ] `npm run dev:api` works on a clean clone with zero AWS credentials
- [ ] `npm run demo:scheduled` produces a signed Ring payload that passes real verification and
      lands as a matched session in the UI
- [ ] Tampered signatures and replayed `request_id` values are both rejected, with tests
- [ ] Deployed Lambda, DynamoDB, Bedrock, and Polly; URL shared with the team
- [ ] `docs/aws-services.md` documents every AWS service and how it is used (AWS Builder entry)
- [ ] The live Ring API path verified against the Ring developer portal if credentials arrive
