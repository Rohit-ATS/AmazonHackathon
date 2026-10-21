# Friction: Amazon Bedrock

**Used for:** two narrow jobs — phrasing the Observe/Explain/Ask turn from a Ring event plus a
visit match, and extracting a structured intent from free speech. Bedrock never decides
whether an action may run, and never executes one.

**Status: unverified against the live service at time of writing.** The integration is
written, typechecked, and wired behind a deadline-and-fallback wrapper
([`packages/agent/src/bedrock.ts`](../../packages/agent/src/bedrock.ts)), and the
output-validation layer is unit-tested. We have not yet run it against a real Bedrock
endpoint, so the entries below are design-time friction, not runtime reports. We would rather
say that than imply experience we do not have. **This file gets updated once the stack is
deployed.**

---

## 1. Model id versus cross-region inference profile — S2, anticipated

**The problem we designed around.** A Bedrock model id and a cross-region inference profile id
look almost identical, differing by a region prefix (`us.`, `eu.`). On most accounts the
un-prefixed foundation-model id fails with an access error even though the model is clearly
listed, and the error does not say "you probably want the inference profile".

This is the kind of mistake that costs twenty minutes at 2am on day three.

**What we did about it.** `BEDROCK_MODEL_ID` is configuration, never hardcoded, and both
`.env.example` and the orchestrator file document the discovery command:

```bash
aws bedrock list-foundation-models --query "modelSummaries[].modelId" --output table
```

The CDK stack grants `bedrock:InvokeModel` on both ARN shapes — the foundation-model ARN and
the inference-profile ARN — so whichever id turns out to be correct, IAM is not the thing that
breaks.

**Suggestion.** When `InvokeModel` fails on a model id that exists but is only reachable via
an inference profile, say so in the error: "this model requires an inference profile; try
`us.<id>`". The information is on the server side already.

## 2. Access is granted per model, per region — S3, anticipated

Model access is granted per account and per region, and a model being listed does not mean it
is callable. We designed for this rather than discovering it: the orchestrator falls back to
the scripted engine on *any* Bedrock failure, so an unapproved model degrades the voice rather
than breaking the demo.

**Suggestion.** `list-foundation-models` could include an `accessStatus` field. Today you find
out by calling and failing.

---

## What the design does well, and why

Written down because it is the reasoning we would want reviewed:

- **The Converse API over raw InvokeModel.** One request shape across models, and tool use is
  first-class rather than hand-rolled JSON parsing.
- **Intent extraction is a tool call with an enumerated `action_id`**, not "respond with
  JSON". The model must pick from actions we offered. It cannot name a recipient the patient
  has not approved, because that recipient is not in the enum.
- **An explicit `unclear` flag in the tool schema.** The model is told that being unsure is a
  better answer than guessing, and `unclear: true` routes to the scripted path. A wrong guess
  here sends a message to a real person.
- **Temperature 0 for intent, 0.3 for phrasing.** This is a care product, not a creative
  writing exercise; the same event should produce roughly the same words.
- **Output validation before a patient hears it.** The model's text is checked for the AI
  disclosure, for length, for more than one question, and for over-claims ("I have notified
  Maya", "I'll call 911", "I am a nurse"). Any of those discards the turn and uses the
  scripted wording. Slightly stiffer phrasing beats a warm sentence that is not true.
- **A 2.5-second deadline.** Past it, the scripted orchestrator answers. For a care
  assistant, dead air is itself a failure.
- **IAM scoped to the configured model**, not `*` — a wildcard would also let a
  prompt-injected agent reach every model in the account.

**Would we build with it again?** The programming model is right for this: a managed endpoint,
no inference infrastructure, and tool schemas that let us constrain the model to a closed set
of actions. The thing we would want before relying on it in production is a clearer story for
"which exact model id can this account call, right now".
