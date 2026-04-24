# Semantic Retrieval First Implementation Shape — 2026-04-24

**Status:** owner recommendation (project-scoped, non-normative)  
**Purpose:** narrow the first reference implementation of the semantic
retrieval experimental extension so the implementation tranche does not sprawl.

**Depends on:**

- `semantic-retrieval-status-options-2026-04-23.md`
- `semantic-retrieval-experimental-extension-2026-04-23.md`
- `semantic-retrieval-metadata-carrier-2026-04-23.md`
- `add-semantic-retrieval-experimental-extension`

## Question

The semantic retrieval extension is approved as design/spec.

What is the smallest honest **first implementation shape** the reference should
target?

This note is about implementation staging, not about changing the public
contract.

## Recommendation

The first implementation should bias toward:

- **pure semantic retrieval first**
- **no snippet generation unless it is cheap and clearly grant-safe**
- **one configured model**
- **one index per deployed server configuration**
- **no hybrid/reranking ambition unless it is already local and obvious**

In practice, that means:

1. default `lexical_blending: false`
2. allow `snippets: false` for the first implementation
3. emit `matched_fields: []` rather than fake attribution
4. support exactly one configured model at a time
5. keep `index_state` honest and simple

## Why this is the right first cut

The experimental extension is already carrying enough new surface area:

- public route
- semantic-field declarations
- capability advertisement
- grant-safe field enforcement
- vector/index drift reporting

The first implementation should prove that the surface can be real and honest.
It does not need to prove the richest retrieval stack on day one.

## 1. Prefer pure semantic mode first

The public contract allows:

- `retrieval_mode: "semantic"`
- `retrieval_mode: "hybrid"`

But the first reference implementation does **not** need to use both.

Default posture:

- advertise `lexical_blending: false`
- return `retrieval_mode: "semantic"` on every result

Why:

- removes one major source of ranking ambiguity
- keeps the implementation from depending on lexical search internals
- makes semantic-vs-lexical evaluation cleaner during the proving cycle

Hybrid blending can be added later without changing the public route shape.

## 2. Snippets are optional; use that

The extension allows `snippet` to be omitted.

The first implementation should feel free to advertise:

- `snippets: false`

if grant-safe, verbatim snippet generation is not cheap and obvious.

Why:

- snippet generation is not the core value of the first proving cycle
- snippet generation is one of the easiest places to accidentally leak text or
  blur the contract into model-generated summaries
- a public semantic route with no snippets is still useful if record identity
  and ranking are honest

If snippets are implemented in v1, they should be:

- verbatim substrings only
- field-attributed only
- easy to test

Not:

- generated summaries
- paraphrases
- cross-field stitched prose

## 3. Honest emptiness beats fake attribution

`matched_fields` is required, but may be empty when attribution is not honest.

The first implementation should prefer:

- `matched_fields: []`

over:

- guessed field attribution
- chunk-to-field heuristics presented as certainty

This is especially important if the index is chunk-based or if one embedding is
derived from concatenated fields.

## 4. One configured model per server

The first implementation should support exactly:

- one configured model id
- one dimensions value
- one distance metric

per running server configuration.

No multi-model routing in the first tranche.

Why:

- simplifies metadata truthfulness
- simplifies `index_state`
- simplifies rebuild semantics
- avoids dragging the implementation tranche into model-selection UX or
  multi-model compatibility

The contract already leaves multi-model advertisement for a future tranche.

## 5. Keep `index_state` simple and honest

The first implementation only needs to support the already-approved vocabulary:

- `built`
- `building`
- `stale`

And it should interpret them conservatively:

- `built`: semantic index agrees with configured model + declared fields
- `building`: index build currently in progress
- `stale`: the semantic surface is not ready to claim full semantic coverage

When `stale`, the first implementation should do one of:

- return empty results
- return partial semantic results honestly
- or withdraw `supported: true`

It should **not**:

- silently fall back to lexical-only behavior
- keep reporting `built`
- fake continuity across model/field drift

## 6. First implementation should stay local-first

The first reference build should prefer a locally-hostable stack.

Not because hosted embeddings are forbidden, but because the first proving
cycle should minimize:

- deployment friction
- hidden costs
- dependency sprawl

This is an implementation preference, not a protocol requirement.

## 7. What not to optimize for yet

The first implementation should not chase:

- best possible recall
- fancy reranking
- hybrid scoring sophistication
- multi-lingual perfection
- embedding export
- debug/explainability APIs on the public surface

Those are second-cycle concerns.

## 8. Success bar for the first implementation

The first implementation is good enough if:

1. it truthfully advertises semantic retrieval
2. it enforces grant/field boundaries correctly
3. it returns useful candidate references
4. it avoids lying during `building` / `stale` states
5. it gives us a real basis to compare semantic vs lexical retrieval on actual
   tasks

## Consequence for the implementation tranche

If the implementation worker faces a choice between:

- a smaller, more honest pure-semantic build
- and a richer hybrid/snippet-heavy build

the default owner preference should be:

- ship the smaller honest build first

The experimental extension already gives us room to learn. We should use that
room to keep the first implementation disciplined.
