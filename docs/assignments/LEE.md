# Lee — Web app, UX, demo, submission

**You own:** `apps/web/**`, `README.md`, `docs/submission/**`, `docs/friction/**`.
**You do not touch:** backend, Ring, infra, or agent code. The API is a contract, not a suggestion.

**Read first:** `docs/CONTRACT.md` — the HTTP API table and SSE payloads are all you need.
The backend runs locally with `npm run dev:api` and serves seeded demo data from minute one, so
you are never blocked waiting on Rohit or Damir.

Two of the four judging criteria (**Design**, and most of **Potential Impact**) are decided by
what you build, and the judges may only ever watch the video. You decide whether this reads as a
product or as a hackathon demo.

## Stack

Vite + React + TypeScript, already scaffolded. Plain CSS or Tailwind — your call, pick one and
commit. No component-library kitchen sink; four screens do not need one.

## Four screens, in build order

**1. Patient voice screen** — the hero shot of the video.

- One enormous status line: *Listening… / Someone is at your front door / Sending…*
- Live transcript, agent and patient lines visually distinct, newest at the bottom
- Big primary **Speak** button (press-to-talk, Web Speech API), plus always-visible
  **Repeat**, **Contact caregiver**, **Cancel**
- Minimum 48px touch targets everywhere. Large default text scale, plus a **Larger text**
  toggle that genuinely reflows the layout rather than only bumping font-size
- Visible consent state: when the agent is waiting on confirmation, the screen states what it is
  about to do and shows **Yes** / **No**. A judge must be able to *see* consent happening.
- Audio: play the mp3 from `POST /api/tts` (Amazon Polly); if it returns 204, fall back to
  browser `speechSynthesis`. Handle both — the demo may run without AWS.

**2. Caregiver dashboard**

- Today's scheduled visits with status (upcoming / arrived / completed)
- The active event, the patient's request verbatim, and the handoff note
- This screen is what makes CareFlow look like a real care product rather than a toy

**3. Event timeline** — one vertical, timestamped list mixing Ring events, AI decisions, patient
approvals, and executed actions. Each AI decision shows *why* ("no visit scheduled within 45
minutes"). This is the screen that proves the system is auditable.

**4. Safety and privacy panel** — Consent required: Yes · Medical advice: Disabled · Automatic
door unlock: Disabled · Data retention: Demo mode · Trusted contacts: Patient-controlled. Read it
from `GET /api/safety`; do not hardcode it. A hardcoded panel is a claim we cannot back, and a
judge may ask.

Plus a **demo control strip**, visually separate like a stage control: buttons that
`POST /api/demo/ring-event` for "Scheduled caregiver arrives", "Unexpected visitor", and
"Delivery". These fire genuinely signed Ring webhook payloads through the real pipeline — say so
on camera, it is the difference between a simulator and a fake.

## Non-UI deliverables — start these Oct 21, do not leave them to the 23rd

- `README.md`: what it is, architecture diagram, setup from a clean clone, the AWS services
  table, the Ring integration explanation, and the open-source repo link. Clone-and-run must
  actually work — test it in a fresh directory.
- Architecture diagram, drawn properly (the one in the project brief is the content).
- `docs/submission/devpost.md`: project description, what we built during the submission window,
  track selections (Ring primary, AWS Builder, Open Source), and the per-tool product feedback
  answer. Collect feedback from Rohit (Ring API, Lambda, DynamoDB, Polly, API Gateway, CDK) and
  Damir (Bedrock).
- `docs/friction/*.md`: one entry per tool — task attempted, steps taken, expected vs actual,
  severity, workaround, actionable suggestion. **This is worth up to a 10% judging bonus.** Nag
  us for entries daily; we will forget.
- Demo video, under 3 minutes, public, English, no copyrighted music or third-party marks. Lead
  with the strongest 30 seconds — judges are not required to watch past 3:00.

## Definition of done

- [ ] Four screens working against the live local API
- [ ] Press-to-talk, Polly playback, and browser fallback all working
- [ ] Large-text mode and keyboard-only operation both work
- [ ] Demo strip fires real Ring-signed events
- [ ] README passes a clean-clone test by someone who has never run it
- [ ] Devpost text, product feedback, friction logs, and video done by the evening of Oct 22

## Timeline

- **Oct 20:** shell, patient screen, live transcript against seeded data
- **Oct 21:** dashboard, timeline, safety panel, demo strip, accessibility pass
- **Oct 22:** polish, README, diagram, video, submission draft
- **Oct 23:** submit by 09:00 Pacific. The deadline is noon Pacific; we are not finding out what
  Devpost does under load at 11:55.
