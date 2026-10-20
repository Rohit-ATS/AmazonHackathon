# Damir — Voice agent, consent engine, safety

**You own:** `packages/consent-engine/**` and `packages/agent/**`. Nobody else touches those.
**You do not touch:** the backend, Ring code, infra, or the web app. If you need something from
the API, ask Rohit and he changes it.

**Read first:** `docs/CONTRACT.md` — the orchestrator seam section is literally your spec.

You are the reason this project wins on *Quality of the Idea*, and you are also our Open Source
mini-challenge entry. Two deliverables, in this order.

---

## Deliverable 1 — `careflow-consent-engine` (also our Open Source entry)

A standalone, dependency-free TypeScript package: a consent state machine that makes it
*structurally impossible* for an AI agent to take a sensitive action without explicit
confirmation. It lives at `packages/consent-engine/` in our repo, and you also push it to its
own public GitHub repo (`careflow-consent-engine`, MIT license). That separate repo URL is what
we submit for the Open Source mini challenge. The rules reward a real reusable feature with
tests far more than a README tweak.

States: `observed -> awaiting_choice -> awaiting_confirmation -> acting -> done`,
plus `cancelled` and `timed_out`.

Public API — keep it this small, that is what makes it reusable:

```ts
createConsentMachine(config): ConsentMachine
machine.observe(event)        // -> observed
machine.offer(options)        // -> awaiting_choice
machine.choose(action)        // -> awaiting_confirmation (sensitive) | acting (benign)
machine.confirm(affirmative)  // -> acting | cancelled
machine.complete(result)      // -> done
machine.can(action)           // guardrail check, returns {allowed, reason}
machine.history()             // append-only audit trail
```

Hard requirements — each one needs a unit test that proves it:

1. `confirm()` throws unless the state is `awaiting_confirmation`.
2. The action executed is byte-identical to the action confirmed (no substitution).
3. A second `confirm()` on the same pending action is a no-op, not a second send (replay safety).
4. Blocklisted actions (`unlock_door`, `disarm_alarm`, `medical_advice`, `emergency_dispatch`)
   are refused in every state, with a reason string.
5. Ambiguous input never advances state — `choose()` requires an exact action id, so an LLM
   cannot "sort of" trigger a notification.
6. Confirmation expires after `config.confirmationTtlMs` (default 60s), moving to `timed_out`.
7. `history()` is append-only and records who, what, and when for every transition.

Ship with: `vitest` tests (aim for 90%+ on the state machine), a README with a ten-line usage
example and a short "why this exists" paragraph, `LICENSE` (MIT), and
`examples/ring-doorbell.ts` driven by the real Ring payloads in `fixtures/ring-events/` so the
example is credible rather than hypothetical.

## Deliverable 2 — `packages/agent`: the voice agent on Bedrock

Implement `createOrchestrator()` exactly as specified in `docs/CONTRACT.md`. A deterministic
scripted version already ships at `packages/agent/src/scripted.ts` and the demo runs on it
today — your job is the Bedrock version behind the identical signature, keeping scripted as the
automatic fallback whenever Bedrock errors or exceeds 2.5 seconds. The demo must never go silent.

Bedrock does exactly two jobs. Do not let it do a third:

- **Classify and explain:** given the normalized `CareEvent` plus the visit match, produce the
  Observe / Explain / Ask utterance.
- **Extract intent:** turn free speech ("tell Jordan I'll be ready in two minutes and I need
  help with my meds") into `{action, params, note}` — a structured object, nothing more.

Bedrock never executes anything. The consent engine decides. That separation is the whole pitch,
and it is also the thing that makes the project defensible as a care product.

Conversation shape: `Observe -> Explain -> Ask -> Confirm -> Act -> Summarize`. One question per
turn, short sentences. Patients may have hearing, vision, or cognitive limits.

Non-negotiable safety behaviour:

- The first utterance of every session includes: *"I'm an AI assistant, not a medical
  professional. I can help coordinate care and contact your care team."*
- Any medical question gets the redirect, never an answer: no symptoms, no medication advice, no
  "that sounds like an emergency". Redirect to the care team and offer to contact them.
- Never claim to detect an emergency. Never imply it contacted emergency services.
- "Open the door" / "let them in" — explain that CareFlow cannot unlock doors, and offer to
  speak to the visitor instead. This is a feature; show it in the demo.
- Unrecognised speech twice in a row — fall back to the on-screen buttons, and say so out loud.

Also write `docs/voice-scripts.md`: the exact lines for both demo scenarios, so Lee can cut the
video against a fixed script and we can re-record without re-improvising.

## Definition of done

- [ ] `npm test -w @careflow/consent-engine` green, all seven requirement tests present
- [ ] Separate public repo pushed with MIT license, README, and example
- [ ] `createOrchestrator` works against real Bedrock and falls back to scripted on failure
- [ ] Medical-boundary and door-unlock refusals demonstrable on camera
- [ ] `docs/voice-scripts.md` written
- [ ] Product feedback on Bedrock in `docs/friction/bedrock.md` — what you used it for, what
      worked, what needs work, how onboarding felt, whether you would build with it again

## Timeline

- **Oct 20:** consent engine plus tests done and pushed to its own repo. Read the scripted
  orchestrator so you know the seam.
- **Oct 21:** Bedrock classify and intent extraction wired; prove the fallback by revoking creds.
- **Oct 22:** safety refusals polished, voice scripts final, friction log written.
