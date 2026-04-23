# Semantic Retrieval Reference Experiment — 2026-04-23

**Status:** owner experiment brief (project-scoped, non-normative)  
**Purpose:** define the smallest honest semantic retrieval experiment the PDPP
reference should be allowed to run next, without accidentally turning a single
embedding/model stack into ambient protocol truth.

**Superseded:** by
`semantic-retrieval-experimental-extension-2026-04-23.md` after the owner
decision that prelaunch / no-user conditions justify a narrow public
experimental extension posture instead of a purely reference-only experiment.

**Depends on:**

- `surface-status-ladder-2026-04-23.md`
- `semantic-retrieval-status-options-2026-04-23.md`
- `add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md`

## Why this exists

The status memo already decided the posture:

- semantic retrieval is **not core now**
- its likely long-term home is a future **optional extension**
- the immediate next step is a **reference-first experiment**

This brief answers the next question:

> What is the smallest semantic retrieval experiment the reference can run that
> is useful, truthful, and still safely below protocol gravity?

## Owner decision

The experiment should be:

- **reference-only**
- **text-query semantic retrieval**
- **cross-stream**
- **candidate-reference oriented**
- **server-chosen model, but explicitly declared**

It should **not** be:

- a public `/v1/*` contract
- a raw-vector API
- a promise of cross-implementation result portability
- an excuse to skip lexical retrieval as the guaranteed floor

## Why this is the smallest honest experiment

This shape gives us real learning on the hard questions:

- does semantic retrieval materially beat lexical on real PDPP workloads?
- what metadata does a client/agent actually need?
- which parts are public-boundary facts vs local implementation detail?

It avoids premature commitments on:

- public extension shape
- client-supplied vectors
- embedding export format
- multi-model concurrency
- portable score semantics

## Primary user and framing

The primary user for this experiment is:

- the owner's own operator surface or owner-run agent targeting the reference

That is an explicit framing choice for the experiment only. It does **not**
mean the protocol is now owner-only. It means the first semantic proving cycle
should optimize for learning before interop.

## Experiment surface

### Route class

Use a **reference-only** surface, not a public RS surface.

The experiment should live under `/_ref/*`, not `/v1/*`.

That keeps the truth boundary clear:

- lexical retrieval remains the public retrieval floor
- semantic retrieval remains a reference experiment

### Query input

The experiment should accept **text queries only**.

Do **not** support in the first experiment:

- raw vector input
- client-provided embeddings
- mode switching between multiple semantic models
- public ranking knobs

The whole point is to answer whether a text-in semantic surface is already
useful enough to justify further work.

### Stream scope

The experiment should be **cross-stream** with optional stream narrowing.

Reason:

- that matches how agents actually search
- it gives the experiment the same realistic workload shape lexical retrieval
  already had to address
- it is directly relevant to generated/private data, where the point is
  cross-stream discovery over idiosyncratic schemas

## Result shape

Return **candidate references**, not hydrated records.

The result shape should stay close to the lexical retrieval reference:

- `stream`
- `record_key`
- `record_url` when available
- `emitted_at`
- `matched_fields`
- optional `snippet`

Reference-only additions are acceptable if needed, such as:

- a reference-local similarity/confidence field
- an explanation field naming the retrieval mode used

But the experiment must treat those as:

- reference-only
- non-portable
- explicitly not a candidate public contract yet

## Required field model

The experiment must not silently embed every textual field in every stream.

Use a **declared field set** per stream.

Candidate shape:

```json
{
  "query": {
    "search": {
      "semantic_fields": ["text", "subject", "body"]
    }
  }
}
```

The declaration can remain experimental/reference-only for now, but the
principle is fixed:

- semantic retrieval must be opt-in per field
- fields must be textual
- search must remain grant-safe

This is especially important for generated/private connectors, where field
meaning may be uneven and we should not auto-embed every string blindly.

## Grant and snippet safety

The semantic experiment must follow the same safety rule as lexical retrieval:

- search only granted streams
- search only granted fields
- search only declared semantic fields
- snippets must never reveal ungranted text

No "embed everything, filter later" loophole.

If a field is not safe to disclose as text, it is not safe to semantically
search via a public-ish server surface either.

## Required experiment metadata

Even though this is reference-only, the experiment must publish enough metadata
to make its behavior legible.

At minimum the experiment should declare:

- semantic retrieval is supported on this reference instance
- endpoint location
- query input mode: `text`
- whether lexical blending is active
- declared model identifier or model family
- vector dimensions
- distance metric
- snippets supported: yes/no
- default limit / max limit
- index state:
  - built
  - building
  - stale/rebuild-required

If the configured model has a material language or locale bias that is known,
the reference should surface that too.

The exact metadata carrier can remain reference-specific in this phase. The
important thing is that the experiment does not behave like a black box.

## Strong recommendation on model/config posture

The experiment should support a **server-configured model choice**, not a hard
coded protocol choice.

That means:

- the reference may pick a default
- owners/implementers may swap it
- the active choice must be declared truthfully

This is the right balance between:

- hackable internals
- honest external behavior

It also leaves space for localized deployments:

- an Italian owner can choose an Italian-friendly model
- the reference remains truthful about that choice

## What should remain implementation-defined in the experiment

The experiment may keep these local:

- exact embedding backend
- storage/index backend
- ANN strategy
- tokenizer details
- reranker details
- lexical blending formula
- batch/rebuild mechanics

The rule is:

- observable capability facts must be declared
- optimization and ranking internals may remain local

## What the experiment must not do

The first semantic experiment must not:

- redefine `/v1/search`
- create a public semantic contract by accident
- promise portable numeric scores
- promise cross-server comparable results
- require client-supplied vectors
- require multi-model indexing
- define self-export of embeddings as canonical

If any of those become necessary for the experiment to feel useful, stop and
report rather than widening the experiment casually.

## Success criteria

The experiment is successful if it shows all of these:

1. **Material retrieval lift**
   On a small real task set, semantic retrieval finds useful records that
   lexical retrieval misses or ranks poorly.

2. **Truthful metadata is possible**
   The behavior can be described clearly enough that an agent/operator knows
   what it is using.

3. **Safe field gating holds**
   Semantic retrieval does not create a second ungoverned disclosure path.

4. **The rebuild/version story is bounded**
   The experiment can say what model/index is active and whether it is current
   enough for its own declared behavior.

## Stop-and-report conditions

Stop the experiment rather than widening it if any of these become necessary:

- public `/v1/*` exposure before the metadata story is clear
- raw vector query support
- multiple live model families at once
- embedding export as part of the canonical owner self-export
- semantic search over undeclared fields
- hand-wavy "just trust the model" ranking without declared behavior

## Relationship to lexical retrieval

Lexical retrieval remains the public retrieval floor.

That means:

- semantic retrieval should not block lexical retrieval work
- semantic retrieval should not replace lexical retrieval in generic clients
- generated/private pilots should assume lexical retrieval is the guaranteed
  baseline
- semantic retrieval, if present, is additive and experimental

## Relationship to generated/private connectors

This experiment matters before the generated/private pilot because it clarifies
something important:

- a custom owner-specific schema does not automatically force semantic retrieval
- but semantic retrieval may become an important additive tool for navigating
  such data generically

The pilot should therefore be designed to:

- succeed with lexical retrieval alone
- optionally benefit from semantic retrieval if the reference experiment is
  available

## Next step after this brief

If this brief is accepted, the next semantic artifact should be either:

1. a worker brief for a **reference-only semantic retrieval spike**, or
2. a smaller note deciding the exact **reference metadata carrier** for the
   experiment

Do **not** jump straight from this brief to a public extension proposal.
