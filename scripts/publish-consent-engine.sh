#!/usr/bin/env bash
#
# Build the standalone careflow-consent-engine repository.
#
#   bash scripts/publish-consent-engine.sh            # build it locally
#   bash scripts/publish-consent-engine.sh --push     # ...and create + push the public repo
#
# The Open Source mini challenge wants a separate public project with its own licence, so
# this extracts packages/consent-engine into a self-contained repo: standalone package.json
# (no workspace protocol), its own vitest config and tsconfig, the Ring fixtures the example
# depends on, and MIT.
#
# It is a script rather than a one-off copy so the extraction is repeatable — the monorepo
# copy stays the source of truth, and this can be re-run after any change.

set -euo pipefail

REPO_NAME="careflow-consent-engine"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${CONSENT_ENGINE_OUT:-${TMPDIR:-/tmp}/$REPO_NAME}"
PUSH="${1:-}"

echo "Building $REPO_NAME in $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/src" "$OUT/test" "$OUT/examples" "$OUT/fixtures/ring-events"

cp "$SRC/packages/consent-engine/src/"*.ts        "$OUT/src/"
cp "$SRC/packages/consent-engine/test/"*.ts       "$OUT/test/"
cp "$SRC/packages/consent-engine/README.md"       "$OUT/README.md"
cp "$SRC/packages/consent-engine/LICENSE"         "$OUT/LICENSE"
cp "$SRC/fixtures/ring-events/"*.json             "$OUT/fixtures/ring-events/"

# The example reaches up three levels for fixtures inside the monorepo; standalone it is two.
sed "s|'../../../fixtures/ring-events/|'../fixtures/ring-events/|" \
  "$SRC/packages/consent-engine/examples/ring-doorbell.ts" > "$OUT/examples/ring-doorbell.ts"

cat > "$OUT/package.json" <<'JSON'
{
  "name": "careflow-consent-engine",
  "version": "0.1.0",
  "description": "A dependency-free consent state machine for AI agents that can take real-world actions. The agent proposes; this decides.",
  "license": "MIT",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "keywords": [
    "consent", "ai-agent", "llm", "guardrails", "state-machine",
    "safety", "human-in-the-loop", "tool-use", "agent-safety"
  ],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "example": "tsx examples/ring-doorbell.ts"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^5.0.5"
  }
}
JSON

cat > "$OUT/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "examples/**/*.ts"]
}
JSON

cat > "$OUT/.gitignore" <<'TXT'
node_modules/
dist/
*.tsbuildinfo
TXT

cat > "$OUT/vitest.config.ts" <<'TS'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
TS

cd "$OUT"
git init -q
git add -A
git -c user.name="Rohit" commit -q -m "careflow-consent-engine: consent state machine for AI agents

A dependency-free TypeScript state machine that makes it structurally impossible for an
agent to take a sensitive action without explicit confirmation of that exact action.

Built for CareFlow (https://github.com/Rohit-ATS/AmazonHackathon), a voice assistant that
turns Ring doorbell events into a consent-based conversation for people receiving care at
home — a context where \"the agent messaged your daughter because it thought you said yes\"
is not an acceptable failure. Nothing here knows about Ring, care, or voice.

Seven guarantees, each with a test that would fail if the property were only a convention:
consent cannot be skipped; the executed action is structurally identical to the approved
one; repeat confirmations are recorded and ignored; blocked capabilities are refused at
offer, choose, consent and execution; choose() requires an exact id so a model cannot
\"sort of\" trigger an action; confirmations expire lazily so a rehydrated machine comes
back timed_out; history() is append-only.

31 tests, zero runtime dependencies, MIT.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

echo
echo "Built: $OUT"
echo "Files: $(git ls-files | wc -l | tr -d ' ')"

if [ "$PUSH" = "--push" ]; then
  echo
  echo "Creating and pushing the public repo..."
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push \
    --description "A dependency-free consent state machine for AI agents that can take real-world actions."
  echo
  echo "Done: $(gh repo view --json url -q .url)"
else
  echo
  echo "Not pushed. To create and push the public repo:"
  echo "  bash scripts/publish-consent-engine.sh --push"
  echo "or manually:"
  echo "  cd \"$OUT\" && gh repo create $REPO_NAME --public --source=. --remote=origin --push"
fi
