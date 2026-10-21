# Friction: build tooling (npm, vitest, Node on Windows)

Not Amazon tools, but they cost real time during the hackathon window, and the entries are
reproducible.

---

## 1. Blocked `postinstall` leaves esbuild in an unclear state — S3, verified

**Task.** `npm install` in a fresh workspace, then run TypeScript via `tsx`.

**What happened.** npm's install-script blocking printed:

```
npm warn install-scripts 2 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
```

esbuild's `postinstall` is what fetches its native binary, so the warning reads like "your
toolchain is broken". We spent time working out whether `tsx` and Vite would actually run.

**Resolution.** They do — the platform-specific `@esbuild/win32-x64` package was installed as
an optional dependency, and `node -e "require('esbuild')"` loads fine. The blocked script was
a no-op in this case.

**Suggestion.** The warning would be far more useful if it said what the consequence is:
"blocked; this package may not have its native binary" versus "blocked; no effect detected".
As written, every blocked script looks equally alarming.

---

## 2. A fresh scaffold ships with critical advisories — S3, verified

**Task.** Add a test runner.

**What happened.** `npm install vitest@^2` produced 6 vulnerabilities, 2 critical
(`tinypool` prototype pollution → RCE, and `@vitest/mocker` path traversal). The fix was
`vitest@5`, two majors up. `npm audit fix --force` would have done it, but on a hackathon
repo that judges will read, silently taking a major-version bump via `--force` is how you
discover a breaking change at 2am.

**Resolution.** Bumped deliberately to `vitest@^5.0.5`, re-ran, confirmed `found 0
vulnerabilities`, and re-ran the suite. No code changes were needed.

**Suggestion.** None for Amazon. Noted because "clean npm audit" is a reasonable thing for
judges to check, and it took a deliberate decision rather than an automatic one.

---

## 3. Atomic `rename` fails with EPERM inside OneDrive — S2, verified

**Task.** Persist local demo state with a write-temp-then-rename, so a crash cannot leave a
half-written JSON file.

**What happened.** Every write failed:

```
Error: EPERM: operation not permitted, rename
'...\.careflow-state.json.36920.tmp' -> '...\.careflow-state.json'
```

The repository lives under `C:\Users\<user>\OneDrive\...`. On Windows, renaming over an
existing file fails if anything holds a handle on the target, and the OneDrive sync client
routinely does. The failure surfaced as a generic 500 from an unrelated endpoint, which cost
most of the debugging time — the stack trace pointed at `appendAudit`, not at the storage
layer's design.

**Resolution.** Retry the rename up to three times with backoff, then fall back to writing in
place. Losing atomicity on a local demo store is much better than losing the write. See
`services/api/src/lib/store.ts`.

**Suggestion.** For anyone building dev tooling on Windows: assume `rename` over an existing
file is unreliable in synced folders, and do not let the atomic-write pattern be the only
path. Node's error message is accurate but gives no hint that a sync client is the usual
cause.

---

## 4. StrictMode double-invoked effects defeat skip-first-write — S2, verified

**Task.** Persist an accessibility preference, while letting the care plan supply the default
when the user has never chosen.

**What happened.** The obvious implementation — a `useRef` guard that skips the first write —
silently does not work under React 19 StrictMode in development, because effects are mounted,
unmounted, and re-mounted. The second run writes. The symptom was subtle and bad: a patient
whose care plan asks for large text got normal text, because `null` ("never chosen") had been
overwritten with `"false"` before the care plan arrived.

**Resolution.** Stopped trying to detect the first render. The preference is now
`boolean | undefined`, where `undefined` genuinely means "never chosen", and storage is only
written in the toggle handler. See `usePreference` in `apps/web/src/App.tsx`.

**Lesson worth repeating:** "skip the first effect run" is not a safe pattern under
StrictMode. If a value distinguishes unset from false, model that in the state rather than in
effect timing.
