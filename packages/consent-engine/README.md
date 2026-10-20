# careflow-consent-engine

**Owner: Damir.** Placeholder so the workspace installs — see `docs/assignments/DAMIR.md`
for the full spec, and `docs/CONTRACT.md` for how it plugs in.

A dependency-free consent state machine that makes it structurally impossible for an agent
to take a sensitive action without explicit confirmation. This directory is mirrored to its
own public repo (MIT) as our Open Source mini-challenge entry.

The backend already enforces the same invariants independently in
`services/api/src/lib/sessions.ts` — the two are meant to be redundant, so that a bug in
either one is not enough to send a message nobody approved.
