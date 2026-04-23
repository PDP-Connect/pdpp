# Private generated connector pilot brief

**Status:** owner exploration brief
**Date:** 2026-04-23
**Depends on:** `agent-generated-custom-connectors-open-question-2026-04-23.md`

## Why this exists

The open question note establishes that PDPP could plausibly support a lane for:

- private
- owner-scoped
- agent-assisted
- protocol-conformant
- semantically weaker than reviewed reusable connectors

That is useful framing, but it does not answer the empirical question:

**Can one real generated connector clear a meaningful PDPP bar without collapsing into hand-wavy exceptions?**

This brief exists to answer that question with one bounded pilot.

## The pilot in one sentence

Run one **private generated connector** experiment for one owner and one source,
with a **snapshot-like or append-only** stream shape, a **mandatory verifier and
evidence bundle**, and a success bar that requires both **PDPP conformance** and
**generic downstream usability**.

## Primary question

Can an owner or owner-directed agent produce a connector artifact bundle that:

1. behaves like a PDPP connector,
2. supports honest reruns / incremental collection at a narrow but real level,
3. exposes enough truthful metadata that a generic consumer can browse, filter,
   page, and search the resulting custom data without source-specific knowledge?

## Why this pilot is the right first cut

This is intentionally narrower than "agent-generated connectors" in general.

It avoids three premature traps:

1. **Published ecosystem promises**
   This pilot is not about reusable marketplace connectors.

2. **High-mutation semantics**
   Mutable-state connectors with deletes, merges, and deep gap recovery are not
   the right first proving ground.

3. **Semantic overclaim**
   The point is not to prove the agent deeply understands the source. The point
   is to see whether PDPP can host a generated connector lane with honest,
   bounded guarantees.

## Pilot status label

Use the provisional label:

- `generated/private`

That is enough for this phase. Do not turn this brief into a full trust-tier
taxonomy.

## Scope constraints

The pilot should obey all of these:

1. **One owner only**
   The artifact is private and owner-scoped by default.

2. **One source only**
   No multi-source orchestration in the pilot.

3. **Snapshot-like or append-only only**
   The connector may expose:
   - append-only event/activity streams, or
   - full snapshot streams whose semantics are declared honestly

   It should not claim rich mutable-state / tombstone semantics unless it can
   actually prove them.

4. **At most a small stream set**
   Prefer one stream; at most two or three tightly related streams.

5. **No published reuse promise**
   The artifact does not promise cross-owner stability or compatibility.

6. **No semantic completeness claim beyond what is evidenced**
   If coverage is curated, sampled, partial, or narrow, the artifact must say so.

## Recommended first-source shape

Choose a source with these properties:

- the owner can access it reliably
- the data is personal and worth keeping
- records have a stable obvious source identifier, or a stable synthesized key is
  practical
- the main useful output is a table / activity log / history list
- reruns can be expressed as either:
  - "collect new items since checkpoint", or
  - "refresh the current snapshot honestly"
- a verifier can cheaply tell whether the session/page is valid before
  extraction

Avoid as a first pilot:

- highly dynamic inbox/chat products with frequent edits and deletes
- sources whose only useful representation is deeply relational
- sources requiring heroic anti-bot bypass just to stay logged in
- sources whose data model is only intelligible after a long ontology exercise

## Minimum artifact bundle

The generated connector artifact must include all of the following.

### 1. Connector declaration

A durable declaration covering:

- connector id or generated name
- provenance
- source description
- stream list
- schema per stream
- declared capabilities and limitations

### 2. Record identity rules

Per stream:

- primary key strategy
- whether the key is source-native or synthesized
- why it is expected to remain stable across reruns

### 3. Incremental semantics declaration

Per stream:

- append-only vs snapshot-like
- checkpoint shape
- what a rerun means
- what the connector does **not** guarantee

This must be explicit. The pilot cannot hide behind "best effort."

### 4. Extraction artifact

One of:

- generated code
- a durable extraction plan
- a replayable request plan
- a saved descriptor bundle

It must be inspectable and rerunnable. A pure conversational transcript is not
enough.

### 5. Verifier hook

At minimum:

- auth/session verifier before extraction
- hard stop on verifier failure

If the source needs additional integrity checks, include them explicitly.

### 6. Evidence bundle

Enough evidence to inspect and rerun failures, such as:

- captured traces
- sampled source artifacts
- saved plans/descriptors
- fixture-like outputs
- run logs with stable identifiers

## What the pilot must prove

### A. Protocol conformance

The artifact must:

- pass manifest/schema/runtime validation
- emit valid PDPP protocol messages
- avoid secret leakage
- express partial/failure states honestly under existing connector semantics

### B. Incremental honesty

The artifact must:

- rerun from prior state without inventing hidden behavior
- either collect new records honestly or refresh snapshots honestly
- avoid claiming delete/update guarantees it does not actually implement

### C. Generic consumer usability

A generic consumer must be able to:

- discover the stream(s)
- inspect schema and field metadata
- page records
- filter on supported fields
- perform lexical retrieval if the stream declares searchable fields

The key test is that a consumer should not need source-specific code just to
work with the generated data as data.

### D. Bounded semantic honesty

The artifact must not imply stronger understanding than it has.

It should declare whether it is:

- full source coverage
- curated subset
- exploratory extraction
- snapshot of one visible surface only

## What the pilot does not need to prove

It does **not** need to prove:

- marketplace-grade reuse
- stable schema across many owners
- broad source completeness
- semantic correctness equivalent to a hand-reviewed connector
- rich delete/tombstone behavior
- semantic/vector retrieval

## Suggested harness checks

The pilot should be judged by a small explicit harness, not by vibes.

### Harness 1 — connector/runtime conformance

- valid declaration/schema
- valid record identity
- valid `STATE`
- valid `DONE`
- no forbidden fields

### Harness 2 — rerun behavior

Run the connector twice against the same owner/source and verify:

- declared checkpoint state is emitted
- second run does not duplicate records beyond declared semantics
- append-only streams only add new records
- snapshot-like streams remain honest about replacement/refresh behavior

### Harness 3 — verifier behavior

- verifier exists
- extraction stops when verifier fails
- verifier failure is legible in run output

### Harness 4 — generic read utility

Given only the PDPP surfaces and the emitted metadata, a consumer can:

- list streams
- inspect schema
- fetch records
- page
- filter
- lexically search if declared

## Preferred implementation posture

The pilot should lean toward:

- agent-assisted authoring
- durable generated artifacts
- deterministic extraction/runtime behavior after generation

That is a better fit than "agent improvises extraction from scratch every run."

In other words:

- agent creativity at authoring time
- explicit artifacts and conformance checks at runtime

## Deliverables

The pilot should produce:

1. one generated/private connector artifact bundle
2. one short note explaining the source and declared limits
3. one harness result set covering the four categories above
4. one downstream demonstration:
   - browse
   - page
   - filter
   - lexical search if applicable
5. one owner conclusion:
   - viable lane
   - viable only with stricter constraints
   - or not yet viable

## Stop-and-report conditions

Stop rather than widening the pilot if any of these become necessary:

- cross-owner compatibility guarantees
- rich mutable-state semantics
- delete/tombstone guarantees
- connector-specific consumer code just to make the data usable
- unverifiable agent-only runtime behavior
- hand-wavy "trust the prompt" instead of inspectable artifacts

## What success looks like

The pilot is successful if, after one run and one rerun, we can honestly say:

- this artifact behaves like a PDPP connector
- its rerun behavior is narrow but truthful
- its limits are explicit
- its emitted data is generically usable without source-specific consumer code

That would justify deeper work on the lane.

## What failure would teach us

Failure is still useful if it tells us clearly that one of these is missing:

- a stronger artifact bundle
- a stronger verifier requirement
- a stricter generated/private status boundary
- a simpler allowed stream model
- a richer conformance harness before this lane is real

## Next step after this brief

If this brief is accepted, the next move should be:

- pick one candidate source,
- define the smallest viable artifact bundle for it,
- and write an execution brief for the pilot worker.
