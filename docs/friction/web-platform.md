# Friction: Web Speech API

**Used for:** speech-to-text in the patient screen, and as the text-to-speech fallback when
Amazon Polly is unavailable.

**Would we build with it again?** For recognition, yes — with the firm caveat below. For
synthesis, only as a fallback, which is how we use it.

---

## 1. `speechSynthesis` can fire neither `onend` nor `onerror` — S2, verified

**Task.** Speak the agent's turn, then re-enable the microphone button when it finishes.

**What we did.** Awaited a promise that resolves on `utterance.onend` or `utterance.onerror`.

**Expected.** One of the two always fires.

**What happened.** Neither did. The promise never settled, `speaking` stayed `true`, and the
"Hold to speak" button was disabled permanently. We caught it only because we drove the real
UI in a headless browser during QA, where no voices are installed — the same failure is
documented in the wild on desktop Chrome when the voice list has not loaded yet, and it would
have been a brutal bug to hit live, since the microphone would simply never come back.

**Resolution.** Race the utterance against a length-proportional timeout (~14 characters per
second, 2s floor, 30s ceiling) and settle either way. See `apps/web/src/lib/useVoice.ts`.

**Suggestion.** For anyone using the API: never treat `onend` as guaranteed. Always have a
timeout, and always keep a non-voice path to every action.

---

## 2. Recognition quality is the reason buttons are the real interface — design note

Not a bug, but the single most important platform constraint for this product.

`SpeechRecognition` accuracy drops sharply with age-related voice changes, accents,
background noise, and quiet speech — which describes a large share of the people CareFlow
exists for. A design that depends on recognition would exclude its own users.

So the architecture treats speech as an accelerator, never a requirement: every action is
reachable from large on-screen buttons, the backend accepts an `actionId` as readily as a
transcript, and two consecutive recognition failures make the agent say so out loud and point
at the buttons.

This is worth stating plainly because it is easy to demo voice in a quiet room with a clear
speaker and conclude the problem is solved.

---

## 3. Browser-specific notes

- The API is `webkitSpeechRecognition` in Chromium and unavailable in Firefox. We feature-
  detect and disable the microphone button with an explanation rather than letting it fail.
- Recognition requires a secure context. `localhost` counts, so local development works, but
  a demo served over plain HTTP from an IP address will silently have no microphone.
- `speechSynthesis.cancel()` before starting recognition is necessary, or the agent
  transcribes itself.
