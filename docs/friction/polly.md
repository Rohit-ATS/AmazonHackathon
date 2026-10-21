# Friction: Amazon Polly

**Used for:** speaking the agent's turns to the patient. `POST /api/tts` returns mp3, or a
`204` telling the browser to use its own speech synthesis.

**Status: unverified against the live service at time of writing.** The integration is written
and typechecked ([`services/api/src/lib/tts.ts`](../../services/api/src/lib/tts.ts)); we have
been running on the browser-speech fallback locally. Updated once the stack is deployed.

---

## 1. Neural engine availability is per-region and per-voice — S3, anticipated

Not every voice supports `Engine: neural`, and not every region offers the neural engine at
all. A request that is valid in `us-east-1` can fail elsewhere with an error about the engine
rather than the voice, which sends you looking in the wrong place.

**What we did about it.** `synthesize()` returns `undefined` on *any* failure — missing
credentials, missing SDK, unsupported engine, unsupported voice — and the API answers `204`,
which the frontend treats as "use the browser voice". The voice actually in use is shown in
the UI, so a silent downgrade is visible rather than mysterious.

**Suggestion.** A documented matrix of voice × region × engine would save a lookup. The error
could also name the alternative: "voice X does not support the neural engine in region Y;
standard is available".

---

## Design notes

- **Neural, not standard.** For this product the voice is not cosmetic. The difference between
  a warm voice and a robotic one is the difference between an assistant somebody lets into
  their home and one they switch off.
- **SSML pacing: 92% rate, 400ms between sentences.** An accessibility decision, not a
  stylistic one — the listener may be older, hard of hearing, and walking to the door while it
  talks.
- **Escaping before SSML.** Agent text can contain apostrophes and quotes from the patient's
  own words, so it is escaped before being wrapped in `<speak>`. Unescaped content inside SSML
  is a parse error at best.
- **Never fatal.** Polly being unavailable must degrade the voice, never fail the turn.

**Would we build with it again?** Yes. A single API call, mp3 straight back, and SSML gives
exactly the control this product needs over pacing.
