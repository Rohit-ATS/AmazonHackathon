# careflow-consent-engine

A dependency-free consent state machine for AI agents that can take real-world actions.
**The agent proposes; this decides.**

```bash
npm install careflow-consent-engine
```

## Why this exists

An LLM agent with tools will, sooner or later, call one it should have asked about first.
Prompting helps; it does not guarantee. "Always confirm before sending a message" is an
instruction to a system whose entire job is generating plausible text, and a plausible
confirmation is not a confirmation.

This package moves the guarantee out of the prompt and into a state machine. There is no
code path from *the model said something* to *a sensitive action ran* that does not pass
through an explicit, unambiguous, non-expired confirmation of that exact action.

It was built for [CareFlow](https://github.com/Rohit-ATS/AmazonHackathon), a voice
assistant that turns Ring doorbell events into a consent-based conversation for people
receiving care at home — a context where "the agent messaged your daughter because it
thought you said yes" is not an acceptable failure. Nothing in the package knows about
Ring, care, or voice, so it works for any agent that can act on someone's behalf.

## Usage

```ts
import { createConsentMachine } from 'careflow-consent-engine';

const machine = createConsentMachine({
  blockedActions: ['delete_account'],                 // add app-specific refusals
  confirmationTtlMs: 60_000,
  actor: 'user:123',
});

machine.observe({ kind: 'doorbell' });               // -> observed
machine.offer([
  { id: 'notify_daughter', label: 'Contact Maya', sensitive: true,
    payload: { to: 'maya', message: 'Someone is at the door.' } },
  { id: 'do_nothing', label: 'Do nothing', sensitive: false },
]);                                                  // -> awaiting_choice
machine.choose('notify_daughter');                   // -> awaiting_confirmation
machine.confirm(true);                               // -> acting

const action = machine.confirmedAction!;
machine.assertExecutable(action);                    // throws unless exactly approved
await sendMessage(action.payload);
machine.complete({ ok: true });                      // -> done
```

Non-sensitive actions skip the confirmation turn — there is nothing to undo about making a
note — so `choose()` takes them straight to `acting`.

## States

```
                    ┌──────────── cancelled   (declined, or cancel())
                    │
idle ─ observe ─► observed ─ offer ─► awaiting_choice ─ choose ─► awaiting_confirmation
                                            │                            │
                                            │ choose (not sensitive)     │ confirm(true)
                                            ▼                            ▼
                                          acting ◄───────────────────── acting
                                            │                            │
                                            └── complete ─► done        └─ (TTL) ─► timed_out
```

## What it guarantees

Each of these has a test that would fail if the property were only a convention.

| Guarantee | How |
|---|---|
| **Consent cannot be skipped** | `confirm()` throws from any state but `awaiting_confirmation`, and `assertExecutable()` throws from any state but `acting`. |
| **The action executed is the action approved** | The chosen action is deep-frozen at choose time; `assertExecutable()` compares the whole descriptor, payload included, with key order normalized. Same id but a different message fails. |
| **No double sends** | A repeat `confirm()` is recorded as `duplicate_confirmation` and ignored, so a double-tap or a retried HTTP request cannot send twice. |
| **Blocked capabilities stay blocked** | Refused when offered, when chosen, at the moment of consent, and again at execution — including for a machine rehydrated from a snapshot written before the blocklist changed. |
| **Ambiguity never advances state** | `choose()` requires an exact id. No fuzzy matching, no prefixes, no closest-option. An approximate id is not an id. |
| **Stale consent expires** | Pending confirmations expire after `confirmationTtlMs` (default 60s), checked lazily so a machine restored from storage comes back `timed_out` rather than still-pending. |
| **The audit trail is append-only** | `history()` returns copies; mutating them does nothing. Every transition records what, when, from, to, actor, and the reason for any refusal. |

## API

| Member | Purpose |
|---|---|
| `createConsentMachine(config?, snapshot?)` | Create, or rehydrate from a snapshot. |
| `.observe(event?)` | A new event. Clears any previous decision — consent for the last visitor is not consent for this one. |
| `.offer(options)` | Put choices on the table. Blocked actions are filtered out and the refusal logged. |
| `.choose(actionId)` | Exact id. Sensitive → `awaiting_confirmation`; otherwise → `acting`. |
| `.confirm(affirmative)` | The explicit yes or no. |
| `.complete(result?)` | The side effect finished. |
| `.cancel(reason?)` | Abandon, from any non-terminal state. |
| `.can(action)` | Guardrail check. Never mutates; safe in any state. |
| `.assertExecutable(action)` | Throws unless this exact action is approved and the machine is `acting`. Call it immediately before the side effect. |
| `.history()` | The audit trail. |
| `.snapshot()` | JSON-serializable state, for storing a conversation between requests. |

`state`, `pendingAction`, `confirmedAction`, and `options` are readonly properties.
Reading `state` or `pendingAction` also expires a stale confirmation, so they never report
a pending action that is no longer valid.

`unlock_door`, `disarm_alarm`, `medical_advice`, and `emergency_dispatch` are always
blocked. `blockedActions` adds application-specific refusals; it cannot disable the built-in
safety boundary.

## Stateless servers

Keep the machine wherever you keep the conversation:

```ts
const machine = createConsentMachine(config, await store.get(sessionId));
machine.choose(actionId);
await store.put(sessionId, machine.snapshot());
```

Snapshots survive JSON round-trips, and TTL is evaluated on read rather than by a timer,
so a snapshot restored an hour later correctly comes back as `timed_out`.

## Design notes

**Why a separate `assertExecutable` instead of returning the action from `confirm()`?**
Because the call site that performs the side effect is the one that needs checking, and it
is usually not the call site that handled the confirmation. One extra line next to the
`await` is cheap insurance.

**Why is a blocked action filtered out of `offer()` rather than throwing?** An agent that
proposes something impossible is a bug worth logging, not a reason to break the
conversation. The user still gets the choices that are real. Being told "yes, and then no"
is worse than a clear no.

**Why freeze the action?** Otherwise a caller holding a reference could change
`payload.message` after approval, and every equality check downstream would still pass.

## Development

```bash
npm install
npm test                               # 31 tests
npx tsx examples/ring-doorbell.ts      # worked example on a real Ring webhook payload
```

The example runs against genuine Ring Partner API webhook v1.1 payloads in
`fixtures/ring-events/`.

## License

MIT
