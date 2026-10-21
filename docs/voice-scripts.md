# Voice scripts

The exact dialogue for both demo scenarios plus the refusals, so the video can be cut against
a fixed script and re-recorded without re-improvising.

These are the lines the **scripted orchestrator** produces, which is what runs without AWS
credentials. With Bedrock configured the wording varies slightly — the model phrases the
Observe/Explain/Ask turn — but the structure, the disclosure, and every state transition are
identical, because Bedrock only supplies words and the state machine is deterministic.

Run `npm run demo:story` to hear it read back as a transcript with assertions.

---

## Scenario A — the scheduled caregiver

**Setup:** Eleanor is home after a short hospital stay. Jordan, her home-health nurse, is due
now. Press **Scheduled caregiver arrives**.

> **CareFlow:** I'm an AI assistant, not a medical professional. I can help coordinate care
> and contact your care team. Your scheduled care provider, Jordan Mbeki, appears to be at the
> front door. Would you like to tell them you're ready, or ask for a few more minutes?

> **Eleanor:** Tell Jordan I'll be ready in two minutes, and remind them that I need help
> organizing my medications.

> **CareFlow:** Just to confirm — should I tell Jordan Mbeki you'll be ready in 2 minutes?

> **Eleanor:** Yes, please.

> **CareFlow:** Okay. I'll tell Jordan Mbeki you'll be ready in 2 minutes now.

**On screen:** the caregiver dashboard shows the handoff — *"Ready in 2 minutes"*, Eleanor's
request in her own words, and the note *"Patient request: I need help organizing my
medications."*

**Points worth making on camera**
- The disclosure is the first thing said, every session.
- "Appears to be" — CareFlow matched a schedule; it did not identify a person. It never
  claims more than it knows.
- Nothing was sent until she said yes.
- "Help organizing my medications" is a care task, not a dosage question. Relaying it is
  coordination, which is exactly what CareFlow is for.

---

## Scenario B — the unexpected visitor

**Setup:** Later the same evening. Press **Unexpected visitor**.

> **CareFlow:** I'm an AI assistant, not a medical professional. I can help coordinate care
> and contact your care team. There is someone at the front door, but I don't see a scheduled
> visit. Your next visit isn't until 10:38 PM. Would you like me to say you're unavailable,
> contact Maya Reyes, or do nothing?

> **Eleanor:** Contact my daughter.

> **CareFlow:** Just to confirm — should I notify Maya Reyes?

> **Eleanor:** Yes.

> **CareFlow:** Okay. I'll notify Maya Reyes now.

**On screen:** the timeline shows the Ring event, the decision with its reason, the approval,
and the notification — each timestamped.

**Points worth making on camera**
- The reason is shown verbatim: *"No visit window covers 7:38 PM — nearest scheduled visit is
  160 minutes away."* If the explanation is not good enough to show the user, it is not good
  enough.
- The agent offers Maya because Eleanor approved Maya. A contact marked "not approved" is
  refused, whatever anyone asks.

---

## Scenario C — the emergency-assist prototype

**Setup:** Shown separately, and labelled a prototype on screen. Press **I need help**.

> **CareFlow:** I'm an AI assistant, not a medical professional. I can help coordinate care
> and contact your care team. If this is a medical emergency, please call emergency services
> directly. I can let your care team know you need help. Would you like me to tell them now?

> **Eleanor:** Yes, tell my care team.

> **CareFlow:** Okay. I'll let Maya Reyes and Riverside Home Care know you need help now.

**Points worth making on camera**
- Patient-initiated only. There is no code path from inference to this flow — CareFlow never
  decides on its own that someone needs help.
- It does not contact emergency services, and it says so before anything else.
- It does not assess how serious anything is. It relays a message the patient asked it to
  relay.
- Confirmation is still required, even though speed would be convenient here. That is the
  point of a consent system: it holds when it is inconvenient.

---

## The refusals

Worth 20 seconds on camera. They are the most persuasive part of the demo, because they are
the part a careless build would get wrong.

**Door unlock**

> **Eleanor:** Just unlock the door and let them in.
>
> **CareFlow:** I'm not able to unlock or open doors — I don't have that control, by design.
> I can let them know you're coming, or contact someone you trust. Which would you like?

Ring's partner scope is read-only (`ava.v1:read`), so CareFlow could not unlock a door even
if it wanted to — and `unlock_door` is on the blocklist regardless, refused from every state
by both the domain gate and the consent engine.

**A medical question**

> **Eleanor:** Should I take a double dose of my blood pressure tablets?
>
> **CareFlow:** I'm an AI assistant, not a medical professional, so I can't answer that. I can
> pass the question to your care team, or ask Jordan to go through it with you at the visit.
> Would you like me to send it on?

Note the shape: a refusal plus a real next step. A refusal that leaves someone with nothing is
not good enough.

**Asking who is there**

> **Eleanor:** Who is that at the door?
>
> **CareFlow:** I can't identify people at the door — I only know whether a visit is
> scheduled. Right now I don't see one. Would you like me to contact someone you trust?

No face recognition. Adding it to a product for people receiving care at home would change
what the product is.

---

## Delivery notes

- **One question per turn.** If a line has two question marks, it is wrong — the Bedrock path
  discards such turns automatically and falls back to these scripted lines.
- **Short sentences.** Eleanor may be walking to the door while listening.
- **Never claim an action has happened before it has.** "I'll notify Maya now", then the
  timeline confirms it. The model is blocked from saying "I have notified" at all.
- **Warm, not chummy.** It should never pretend to be a person, and never pretend to be her
  nurse.

## Timing for a three-minute video

| Time | Beat |
|---|---|
| 0:00–0:20 | The problem: the door, the walker, the nurse waiting |
| 0:20–0:45 | What CareFlow is, in one sentence, over the patient screen |
| 0:45–1:40 | Scenario A, end to end, including the handoff on the caregiver dashboard |
| 1:40–2:15 | Scenario B, plus the timeline and audit trail |
| 2:15–2:40 | Technical proof: the signed payload, the verification, DynamoDB, Bedrock, Polly |
| 2:40–3:00 | The refusals and the safety panel, then the closing line |

Closing line:

> "CareFlow does not diagnose, surveil, or make medical decisions. It helps people receiving
> care stay informed, independent, and in control."
