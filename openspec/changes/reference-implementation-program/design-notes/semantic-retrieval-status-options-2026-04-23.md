# Semantic Retrieval Status Options — 2026-04-23

**Status:** owner decision memo (project-scoped, non-normative)  
**Purpose:** decide the right current status and next move for semantic retrieval over authorized PDPP records.

This note is narrower than the older open question in
`add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md`.
That note maps the whole decision space. This note answers a simpler owner
question:

> What should PDPP do next about semantic retrieval, and what status should it
> have right now?

## Question

PDPP now has two strong signals:

1. agents need better retrieval than linear pagination and exact filters
2. custom/generated owner data will become much more valuable if generic
   consumers can navigate it effectively

Lexical retrieval is the immediate floor. The remaining question is:

> Should semantic retrieval be treated as `reference-only`, an `optional
> extension`, or `core` PDPP behavior, and what is the right next step?

## Current facts

### 1. Semantic retrieval pressure is real

The need is not hypothetical.

- real agents already hit the limit of record listing + exact filters
- lexical retrieval will help materially, but it will not close the whole gap
- generated/private connectors will make schema names and field labels more
  idiosyncratic, increasing pressure for meaning-based retrieval

So semantic retrieval is not a luxury topic. It is a likely future capability.

### 2. Semantic retrieval is much more opinionated than lexical retrieval

Semantic retrieval carries choices that lexical retrieval avoids:

- embedding model choice
- model upgrade / re-embedding cost
- language and locale bias
- vector index backend
- reranking policy
- self-export treatment for derived artifacts

This is exactly the kind of capability that can create accidental protocol
gravity if the reference ships it casually.

### 3. The reference should be hackable, but the boundary must stay truthful

For semantic retrieval, "hackable reference" is a feature, not a bug.

Different owners or implementations may reasonably want:

- different embedding models
- different language-localized models
- different reranking stacks
- different storage/index backends

That argues strongly against baking one model choice into core PDPP.

At the same time, it does **not** argue for a vague boundary. If a public
semantic capability exists, clients need truthful metadata about what is being
offered.

### 4. The public semantic question is not just "do we have embeddings?"

There are at least four separate questions:

1. Is semantic retrieval public at all?
2. If public, is it a text-query semantic surface, a raw vector surface, or
   both?
3. What capability metadata must implementations publish?
4. What remains implementation-defined?

These are separable. PDPP should not pretend they collapse into one yes/no.

## Option A — Implementation-defined / reference-only experiment

Treat semantic retrieval as a reference-server experiment or implementation
detail for now.

Likely form:

- reference ships a semantic retrieval surface for its own UI/agent workflows
- behavior is documented honestly as reference behavior
- no immediate public portability claim across PDPP implementations

### Best argument for this option

- gives us a proving cycle before standardization
- preserves freedom on model choice, query shape, and rebuild/version strategy
- avoids prematurely turning a single reference choice into protocol truth

### Best argument against this option

- if the feature is public enough that agents rely on it, "reference-only"
  becomes a fig leaf
- other implementations will still want to copy it
- useful behavior can become de facto standard without the right declaration and
  metadata

### Owner read

This is the safest immediate implementation posture, but it is too weak as the
long-term framing if the capability proves broadly useful.

## Option B — Optional extension

Treat semantic retrieval as a named public optional capability with explicit
discovery.

Likely form:

- a declared semantic retrieval capability family
- explicit server metadata about what the server supports
- clients rely on it when advertised
- model/backing details remain partly implementation-defined but truthfully
  surfaced

### Best argument for this option

- it matches the "useful, public, but opinionated" nature of the feature
- it lets the reference lead without pretending the capability belongs in core
- it allows configurability and localization without forcing one canonical model
- it gives generated/private data a path to richer generic consumer navigation

### Best argument against this option

- capability negotiation overhead is real
- two servers may both advertise semantic retrieval but behave very differently
- if the metadata contract is weak, the extension label just hides
  incompatibility instead of solving it

### Owner read

This is the strongest likely long-term home **if** semantic retrieval graduates
beyond experimentation.

But it is not the right immediate first move until we have one proving cycle on
the metadata and query-shape questions.

## Option C — Core

Treat semantic retrieval as part of the mandatory PDPP read contract.

Likely form:

- every conforming implementation supports semantic retrieval
- clients may assume it exists
- the protocol standardizes enough about the query shape and capability metadata
  that interop is meaningful

### Best argument for this option

- agents and clients would get a much stronger portability story
- the protocol would directly own a capability that is likely to matter a lot
  for real-world usability

### Best argument against this option

- this is too opinionated and too unsettled right now
- model choice and rebuild/version cost are not neutral implementation details
- forcing universal support now would create more lock-in than clarity

### Owner read

Not the right status now.

Semantic retrieval should not be core until there is much stronger evidence
that:

- the public capability shape is stable
- the metadata story is honest and sufficient
- the ecosystem cost of optionality is worse than the cost of universal
  implementation

## Recommendation

**Recommended current posture: `experimental optional extension`, with
explicitly provisional status and truthful capability metadata.**

That means:

1. do **not** make semantic retrieval core now
2. it is acceptable to expose it publicly as an extension during prelaunch,
   because there are no outside users yet and the iteration cost is low
3. the extension must be clearly marked as experimental / unstable
4. design work still matters because the public boundary must remain truthful
5. if the experiment succeeds, we can later stabilize it as a normal extension

This is different from lexical retrieval on purpose. Lexical retrieval is
already portable enough to standardize as an extension. Semantic retrieval is
not there yet, but the current project stage makes a provisional extension
acceptable.

## What the experiment should prove

The first proving cycle should answer:

1. Is the right public entrypoint:
   - text query only
   - text query + optional semantic mode
   - or a dedicated semantic surface?

2. What must a server declare for a client to use semantic retrieval safely?

3. Which parts are implementation-defined without breaking usefulness?

4. How should self-export and rebuild/version state treat derived semantic
   artifacts?

## Minimum metadata bar for any future public semantic capability

Even in an extension world, a semantic retrieval capability should not be vague.

If exposed publicly, the server should eventually declare at least:

- semantic retrieval is supported
- endpoint location
- whether the query input is text, vector, or both
- whether lexical blending is present
- whether snippets are supported
- model identifier or model family actually used for indexing/querying
- dimensions or vector-shape facts if raw vector queries are ever supported
- default limit / max limit
- any clearly material language/locale bias if applicable

The exact schema is still open. The principle is not.

## What should remain implementation-defined

These should stay out of core protocol commitments:

- exact embedding backend
- exact vector DB or ANN structure
- tokenizer details
- ranking formula
- reranker choice
- per-owner or per-deployment localized model selection

The reference should be free to be hackable here.

The rule is:

- implementation freedom behind the boundary
- truthful declaration at the boundary

## Why this matters for generated/private connectors

Generated/private connectors increase the value of semantic retrieval because:

- schemas may be owner-specific
- field labels may be idiosyncratic
- lexical field names alone may be weak clues for generic consumers

But that is **not** a reason to rush semantic retrieval into core.

It is a reason to make sure the next generated/private pilot is designed with
semantic retrieval in mind, even if the pilot only requires lexical retrieval as
the guaranteed floor.

## Promotion criteria

Promote semantic retrieval from `experimental optional extension` to a
stabilized `optional extension` only if:

- one proving cycle shows a stable enough capability shape
- the discovery metadata is clear and sufficient
- the public semantics are useful without overclaiming result portability
- the rebuild/version/export story is no longer hand-wavy

Promote it from a stabilized `optional extension` to `core` only if:

- serious clients materially depend on it everywhere
- the ecosystem cost of optionality becomes obvious
- and the opinionated parts are bounded enough to standardize honestly

## Immediate next step

The next semantic-retrieval artifact should be a narrower design note answering:

- what is the smallest honest **experimental semantic extension**,
- what exact metadata it must declare,
- and which parts of that extension are still explicitly unstable.
