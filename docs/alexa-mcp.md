# CareFlow on Alexa+: the MCP server

CareFlow's companion is a **self-hosted MCP server** speaking the **Streamable HTTP**
transport at spec revision **2025-11-25**. One endpoint, `POST|GET|DELETE /mcp`.

```bash
npm run dev:api     # serves /mcp on :8787
npm run mcp:demo    # drives it as a real client, start to finish
```

No SDK. The transport is implemented directly in
[`services/api/src/mcp/server.ts`](../services/api/src/mcp/server.ts), because the rules
ask for a self-hosted MCP server and the transport rules are the part a host actually
exercises. Writing them out is the proof.

## Connecting a host

```json
{
  "mcpServers": {
    "careflow": { "type": "http", "url": "https://<your-deployment>/mcp" }
  }
}
```

Locally that is `http://localhost:8787/mcp`. A browser-based host must send an `Origin`
that CareFlow recognises; add it with `CAREFLOW_MCP_ORIGINS`.

## Transport compliance

Each of these is a MUST in the spec and has a test in
[`services/api/test/mcp.test.ts`](../services/api/test/mcp.test.ts):

| Rule | Behaviour |
|---|---|
| Single endpoint, POST + GET | `/mcp`; GET opens an SSE stream for server-initiated messages |
| Session management | `MCP-Session-Id` issued on `initialize`; **400** without it afterwards, **404** once terminated so the client re-initializes |
| Protocol version | Unsupported `MCP-Protocol-Version` → **400**; absent → assume `2025-03-26` rather than reject |
| Notifications and responses | **202 Accepted**, no body |
| Requests | `application/json` response (the client MUST support both that and SSE) |
| `Accept` header | Must list `application/json` *and* `text/event-stream`, else **406** |
| Origin validation | A present, unrecognised `Origin` → **403**. An absent one is fine: that is a non-browser host, which is the normal case |
| Session teardown | `DELETE` → **204** |
| Unknown tool | JSON-RPC `-32601`, not a result with `isError` — the model cannot fix that by changing arguments |

The Origin check **fails closed**. An empty allowlist rejects every browser origin rather
than waving them through, because the whole point of the rule is DNS rebinding.

## The tools

Seventeen, in five groups. Adding more is one `register()` call.

**Who they are, and today**
`get_care_profile` · `get_daily_brief`

**Companionship** — what makes it a relationship rather than a query interface
`recall_memories` · `save_memory` · `log_check_in` · `get_recent_check_ins` · `set_reminder`

**People**
`list_contacts` · `message_contact` · `call_contact`

**Medication**
`list_medications` · `request_medication_refill`

**Appointments**
`list_appointments` · `book_appointment`

**Safety**
`get_support_resources` · `escalate_to_care_team`

**The gate**
`confirm_action`

## How consent works, and why it is server-side

MCP says clients **should** keep a human in the loop before a sensitive tool call. "Should"
is not a guarantee, and we are not willing to let someone's daughter be phoned because a
host application skipped a confirmation dialog.

So the gate lives in the server:

```
model                     CareFlow                        the person
  │  message_contact ───────►│
  │                          │ stages the action, sends nothing
  │ ◄── confirmation_required│
  │     askExactly: "..."    │
  │  ────────────────────────┼───── asks, out loud ───────────►│
  │ ◄────────────────────────┼────── "yes" ───────────────────┤
  │  confirm_action ────────►│
  │                          │ assertExecutable() then acts
  │ ◄────── status: done ────│
```

A sensitive tool returns `status: "confirmation_required"`, a `confirmationId`, and
`askExactly` — the precise sentence to say, so consent is not paraphrased into something
vaguer. Nothing happens until `confirm_action` arrives with that id and `affirmative: true`.

The action is frozen inside [`@careflow/consent-engine`](../packages/consent-engine) at the
moment it is staged, and `assertExecutable()` runs immediately before the side effect — so
the message that gets sent is necessarily the message that was approved, not one edited
afterwards.

**A host that ignores all of this simply cannot make anything happen.** That is the property
we wanted.

Also enforced: a confirmation is single-use (a retried request cannot send twice), expires
after ten minutes, and a non-boolean answer is refused rather than guessed.

## The safety design

The companion is **not a therapist**, and the instructions the host model receives at
`initialize` say so before anything else. It does not give medical advice, discuss doses,
interpret symptoms, diagnose, or assess anyone's mental state.

When someone is struggling, the designed behaviour is to **stay and hand over**:

1. Listen. Do not rush to fix it. Do not counsel.
2. Call `get_support_resources` — crisis line plus their own on-call nurse — and read it out.
3. Offer to reach a person they trust, via `escalate_to_care_team` or `call_contact`.
4. If there is any suggestion of immediate danger, tell them to call emergency services
   **directly**. CareFlow cannot call on anyone's behalf and must never imply it has.

`get_support_resources` is the one tool that never needs confirmation and is always
available. Everything that reaches a human still asks first — including the escalation.
Speed would be convenient there, and a consent system that bends when it is inconvenient is
not a consent system.

## Honesty about what actually happens

In demo mode, messages, calls, refills and bookings are **recorded rather than transmitted**,
because the people in the fixture are fictional. The tool descriptions tell the model to
report what really happened: a refill is a *request* the pharmacy confirms separately, and
an appointment is a *request to humans*, not a booking. The seam for real delivery is in
[`services/api/src/lib/actions.ts`](../services/api/src/lib/actions.ts).

Wiring a real pharmacy order into a hackathon build, where a mistake means somebody's
medication, is not a trade worth making.

## What CareFlow knows about medication

Names, schedules, and days of supply. **No doses, no conditions, no clinical history.** It
reminds and requests repeats; it does not advise. Data it never holds is data it cannot leak
and cannot reason about when it should not be reasoning at all.

## Relationship to the Ring app

Same backend, same consent engine, same care plan — two ways in:

- **Ring** ([docs/ring-app.md](ring-app.md)): a doorbell event starts a conversation about
  a specific moment at the front door.
- **Alexa+** (this document): the person starts a conversation whenever they want one, at
  any hour.

The second is the bigger product. The first is what proved the consent architecture works
before it was pointed at anything harder.
