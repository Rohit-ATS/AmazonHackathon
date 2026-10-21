# CareFlow as a Ring app

**Short answer to "where does the Ring stuff belong":** a Ring app is not a bundle you
upload. It is a **registration in the Ring Developer Console that points at URLs you host**.
CareFlow hosts all four of them. There is no separate "Ring app project" to create — this
repository *is* the app.

```
Ring Developer Console                      This repository
──────────────────────                      ───────────────
Account Link URL    ──────────────────────► GET  /ring/link
Token Exchange URL  ──────────────────────► POST /ring/token-exchange
Webhook URL         ──────────────────────► POST /ring/webhook
Default Redirect    ──────────────────────► GET  /ring/redirect

Listing fields (name, descriptions, …) ───► ring-app/listing.json
Implementation                         ───► services/api/src/lib/ringapp.ts
                                            packages/ring/**
```

Run `GET /ring/status` on any deployment and it prints those four URLs fully resolved,
plus whether credentials are configured and whether an account is currently linked.

## What each URL does

| URL | Who calls it | What it does |
|---|---|---|
| **Account Link** `/ring/link` | The user's browser, opened by the Ring app | A server-rendered page explaining what CareFlow will and will not be able to do, then a button through to Ring's authorize page. Starts PKCE and stores the verifier against an unguessable `state`. |
| **Token Exchange** `/ring/token-exchange` | Ring's servers | Receives the authorization code, swaps it for tokens, persists them. Accepts JSON or form encoding, since the docs do not pin the content type. |
| **Webhook** `/ring/webhook` | Ring's servers | Signed device events. HMAC-SHA256 verified over the raw bytes before parsing, deduped on `meta.request_id`, 200 inside five seconds. |
| **Default Redirect** `/ring/redirect` | The user's browser | Where Ring sends someone after linking when no platform-specific link applies. Hands them back to the CareFlow interface. |

The link pages are **server-rendered HTML, not part of the React app**, on purpose. Ring
opens them in a plain browser with no guarantee the SPA has loaded, and an account-link page
that depends on a JavaScript bundle is a page that sometimes does not appear.

## Public app or private app

| | Private | Public |
|---|---|---|
| Where it appears | "My Ring Apps", for connected accounts only | Listed in the Ring Appstore |
| Certification | Not required | Required |
| Listing fields | Name, optional icon | Full listing: icon, descriptions, categories, images |

`ring-app/listing.json` is set to **private**, which is the right route for a hackathon
project. It also carries the full public listing copy, so switching is a console change
rather than a writing exercise.

## Registering it

1. **Amazon Developer Portal → Ring → create an app.** Note the Client ID, Client Secret,
   and HMAC Signature Key — they are shown once.
2. **Set the four URLs** from `GET /ring/status` (or `ring-app/listing.json`, substituting
   your deployed origin). All four must be HTTPS, which is why the deployed stack puts API
   Gateway in front of Lambda.
3. **Set the scope** to `ava.v1:read`.
4. **Put the secrets where they belong.** `RING_CLIENT_ID` and `RING_CLIENT_SECRET` as
   environment variables; the HMAC key in Secrets Manager, read at cold start. The service
   refuses to start in a deployed environment if it cannot read the HMAC key — accepting
   webhooks nobody signed would be worse than being down.
5. **Link a staging user.** Developer Portal → Ring → Test → "Log in with Ring". Up to ten
   staging users are allowed.
6. **Verify**: `GET /ring/status` should report `accountLinked: true`, and
   `npm run ring:devices` should list real devices.

## Scope: read-only, on purpose

The partner-initiated flow grants `ava.v1:read`. CareFlow could not unlock a door even if
it wanted to — and `unlock_door` is on the blocklist regardless, refused from every state by
two independent checks.

This is worth saying plainly to a user, and the account-link page does: *"What it cannot do:
unlock doors, disarm alarms, or view live video."* A permission screen that lists what a
thing **cannot** do is rarer than it should be, and it is the honest version.

## Testing without a device

Real webhook delivery needs a physical Ring device, an active Ring Protect plan, and a US
address. Until then, `npm run demo:scheduled` signs a byte-exact webhook v1.1 payload and
POSTs it to `/ring/webhook` over HTTP, so the same verification path runs. Swapping in live
credentials changes configuration, not code. See [friction/ring-api.md](friction/ring-api.md).

## Privacy

What CareFlow asks Ring for, and what it does with it:

- **Device list and event metadata.** Used to tell the patient what happened at their door
  and whether it matches a scheduled visit.
- **No video, no images, no audio.** CareFlow never requests a live view or a recording.
- **No face recognition.** CareFlow does not identify who is at the door and says so when
  asked. It knows only whether a visit is scheduled.
- **Speech stays on the device.** Speech-to-text uses the browser's Web Speech API rather
  than streaming a care recipient's voice to a server.
- **Patient-controlled contacts.** CareFlow refuses to notify anyone the patient has not
  approved, whatever it is asked to do.
- **Demo mode records notifications rather than sending them**, because the contacts in the
  demo are fictional. No real patient data is in this repository, and `npm run seed` fails
  if a contact address does not look fictional.

## A note on Alexa

Alexa+ is a **separate primary track** in this hackathon, not an add-on to the Ring entry.
It wants a self-hosted MCP server (spec 2025-11-25+, Streamable HTTP) or an Agent Skill —
a different integration from Ring's webhooks-and-OAuth model.

A project may enter **one primary track**, so CareFlow being a Ring app is a decision, not
an oversight. The ideas are not interchangeable either: CareFlow's premise is that a
doorbell event should become a consent-gated conversation, which is a Ring-shaped problem.

If you want to pursue Alexa+ as well, it is a second submission with its own repository and
demo, not something to bolt onto this one.
