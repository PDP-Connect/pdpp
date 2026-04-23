# Lexical Retrieval Status Options — 2026-04-23

**Status:** owner decision memo (project-scoped, non-normative)  
**Purpose:** decide the right status for lexical retrieval over authorized records: `reference-only`, `optional extension`, or `core`.

This note is deliberately narrower than the broader semantic-retrieval note. It is only about **lexical retrieval** and only about **status/governance**, not about embeddings.

## Question

PDPP now has enough evidence that "agents need better server-side retrieval" is not hypothetical.

The remaining question is:

> Should lexical retrieval over authorized records be treated as `reference-only`, an `optional extension`, or `core` PDPP behavior?

## Current facts

### 1. Current core PDPP does not define lexical retrieval

The current core read contract defines:

- record listing
- exact filters
- declared range filters
- expansion
- cursoring
- `changes_since`

It does **not** define:

- `q=`
- BM25 / FTS
- snippets
- cross-stream search
- ranking semantics

`spec-data-query-api.md` explicitly says richer cross-stream search could be added later via `POST /v1/search`, which means the current posture is "not part of core yet."

### 2. Current main implementation is materially insufficient for agent navigation

The current implementation evidence is strong:

- `/_ref/search` is still spine-only exact/fuzzy artifact lookup, not retained-record lexical search
- dashboard text search is a brute-force fan-out across streams with substring matching in application code
- on the live local corpus, brute-force search takes seconds and scales poorly
- an outside agent with valid access dropped to SQLite instead of trusting the server surface

That means the problem is real. The current floor is not acceptable.

### 3. Lexical retrieval is much less opinionated than semantic retrieval

Compared with vector/semantic retrieval, lexical retrieval avoids:

- embedding model choice
- embedding versioning
- model portability across owners/servers
- language/model lock-in at the protocol layer

It still has real design questions:

- separate `/v1/search` vs query extension on existing endpoints
- cross-stream vs per-stream shape
- snippets and grant-field leakage
- score semantics and pagination
- capability discovery

But those are substantially more tractable than the semantic case.

## Option A — Reference-only

Treat lexical retrieval as a useful reference feature only.

Likely form:

- improve `/_ref/search` or add another reference-designated read surface
- use it for dashboard/operator/agent workflows targeting the reference
- make no public PDPP interoperability claim

### Best argument for this option

- fastest path to a useful server
- no protocol or extension commitment yet
- good proving ground for real workloads
- safe if we still think the right public shape is unclear

### Best argument against this option

- the need is not merely operator convenience
- serious clients and agents benefit from this capability directly
- keeping it reference-only encourages out-of-band fallbacks and duplicated client indexing
- useful reference behavior is likely to gain de facto gravity anyway

### Owner read

This is too weak as the end state if lexical retrieval proves broadly valuable. It is acceptable only as a short proving stage.

## Option B — Optional extension

Treat lexical retrieval as a public optional capability with explicit discovery.

Likely form:

- a named extension surface
- declared in server metadata / capability discovery
- clients adapt when advertised
- lexical only; no embeddings required

### Best argument for this option

- public and useful without overcommitting the core
- matches the current reality that not every implementation may want to ship search immediately
- lets the reference lead honestly without silently legislating
- aligns with the repo's broader preference for small core + explicit higher-power capability declaration

### Best argument against this option

- introduces capability negotiation overhead
- risks fragmenting the ecosystem into "servers with usable search" and "servers without"
- if every serious implementation ends up needing it, extension status may just delay the inevitable core decision

### Owner read

This is the strongest current fit.

It acknowledges that lexical retrieval is:

- more than reference ergonomics
- less settled than core
- portable enough to define honestly

It gives the ecosystem a real public surface without pretending the universality question is already settled.

## Option C — Core

Treat lexical retrieval as part of the mandatory PDPP read contract.

Likely form:

- every conforming RS supports lexical search
- clients may assume it exists
- conformance tests define the portable behavior

### Best argument for this option

- avoids fragmentation
- recognizes that retrieval may be necessary for real-world usability at owner data scale
- prevents a world where every serious client must implement multiple fallback paths

### Best argument against this option

- the exact public shape is not settled yet
- grant-safe snippets, score semantics, discovery, and cross-stream shape are still open
- the ecosystem has not yet proved that every serious implementation can or should pay this cost
- current evidence supports "valuable" more strongly than it supports "must be universal now"

### Owner read

This is plausible later, but premature now.

Core should remain the destination only if we later conclude that:

- serious clients cannot work well without lexical retrieval
- the capability shape has stabilized
- the optionality tax is worse than the universal implementation tax

## Recommendation

**Recommended current status: `optional extension`, with a strong reference implementation.**

That means:

1. the reference should ship a real lexical retrieval surface that agents can use effectively
2. the public behavior should be framed as an explicit optional capability, not ambient reference magic
3. the capability should be discovered truthfully
4. semantic retrieval should remain a separate later question

## Why this is better than the alternatives

### Better than `reference-only`

Because the need is not purely local to the reference UI. The agent evidence shows a generic client/agent retrieval problem, not just a dashboard polish problem.

### Better than `core`

Because lexical retrieval is close enough to public utility to deserve real shape and metadata, but not yet settled enough to force on every implementation.

## What would change this recommendation

### Promote to `core` if:

- multiple serious client classes materially depend on it
- capability negotiation becomes obvious ecosystem tax
- the public lexical shape stabilizes
- snippets / grant interaction / pagination semantics are nailed down cleanly

### Demote to `reference-only` if:

- we discover the only useful shape is too implementation-specific to define portably
- real client demand turns out to be much lower than current agent/operator evidence suggests

## Decision rule for the next step

The next step should **not** be another general search debate.

It should be:

> define the smallest honest lexical retrieval capability that could live as an optional extension

That work should answer:

- endpoint shape
- stream scoping
- result shape
- score exposure or non-exposure
- snippet policy
- grant-field safety
- capability discovery
- reference implementation strategy

Once that exists, the core-vs-extension question can be revisited with less speculation.
