# Capability discovery framing — 2026-04-22

**Status:** active owner framing / rubric frozen before further research
**Author:** Codex (owner agent)

## Purpose

Define the exact protocol-design question and evaluation rubric for the next PDPP capability-discovery pass.

This note exists so the project does **not** do fuzzy research against a fuzzy target. The goal is to freeze:

1. the precise question we are trying to answer
2. the rubric we will use to judge candidate designs

Only after those are stable should the project audit existing research coverage and compare concrete design candidates.

## Why this deserves its own pass

The April 2026 record-query revision intentionally moved PDPP away from one flat global query contract and toward a smaller global core plus capability-declared higher-risk features. The current Core now uses stream metadata `query` capabilities for:

- `range_filters`
- `expand`

That revision resolved the immediate spec/reference mismatch, but it did **not** fully settle the longer-haul discovery question:

- is per-stream `query` metadata enough?
- what, if anything, belongs in server-level capability discovery?
- should PDPP eventually define a broader capability document, and if so, when?

This is now a higher-stakes design question because the answer will shape:

- future normative PDPP spec text
- reference/OpenAPI contract structure
- typed client and query-builder ergonomics
- AI-facing docs and agent surfaces
- future multi-implementation interoperability

## The exact decision question

The project should answer the following question explicitly:

> What capability-discovery model should PDPP standardize so that humans, clients, and agents can determine truthfully and with low ambiguity what a server and a given stream support, without forcing every future stream into the same global query contract and without introducing incidental protocol complexity?

That top-level question breaks into four subquestions:

1. **Server-level vs stream-level**
   - Which capabilities belong in server metadata because they apply across the resource server?
   - Which capabilities belong only in per-stream metadata because they are schema- or relation-specific?

2. **Minimal v0.1 vs future expansion**
   - Is the current per-stream `query` object sufficient for v0.1 and the near-term reference/OpenAPI work?
   - If not, what additional discovery surface is required now rather than later?

3. **Broader capability document**
   - Should PDPP eventually define a broader capability-discovery document analogous in spirit to `FHIR CapabilityStatement`, OAuth authorization-server/protected-resource metadata, or SCIM `ServiceProviderConfig`?
   - If yes, what problem would that solve that stream metadata does not already solve cleanly?

4. **Contract layering**
   - How should normative PDPP capability discovery relate to:
     - manifest metadata
     - stream metadata
     - machine-readable reference contracts such as OpenAPI
     - reference-only `/_ref` or control-plane surfaces

## What this decision is **not**

This pass is **not** deciding:

- the entire query contract again
- whether Fastify is the right server substrate
- the exact OpenAPI generation mechanism
- control-plane IA
- whether every future feature must be represented in v0.1 capability discovery

Those downstream choices depend on a cleaner answer to the discovery-shape question, but they are not the question itself.

## Evaluation rubric

Candidate designs should be judged against the following criteria.

### 1. Honest

Does the design advertise only real support, rather than implied or aspirational support?

Questions:

- Can an implementation say exactly what it supports today?
- Does the shape avoid encouraging silent fallback or inference by clients?

### 2. Elegant

Does the design contain only essential complexity, rather than incidental machinery, duplicated concepts, or merge-heavy layering?

This follows the Rich Hickey lens: prefer essential complexity that comes from the problem, reject accidental complexity introduced by the design itself.

Penalize designs that:

- duplicate the same capability facts in multiple places
- require clients to merge overlapping documents to answer simple questions
- solve hypothetical future needs with extra machinery the protocol does not yet need
- add a second or third discovery layer mainly because it is fashionable

Reward designs that:

- let a client answer "what can I do with this stream?" with minimal indirection
- scale by repeating one clean pattern rather than introducing special cases
- preserve room for growth without pre-building a framework for everything

### 3. Interoperable

Can independent implementations converge on the same meaning, or does the design leave too much room for incompatible interpretation?

Questions:

- Would two different PDPP servers expose comparable capability signals?
- Could a generic client behave correctly across implementations?

### 4. Composable

Does the model fit cleanly with adjacent standards and existing PDPP layering rather than fighting them?

Questions:

- Does it sit cleanly alongside OAuth authorization-server metadata, protected-resource metadata, and manifest metadata?
- Does it avoid inventing a parallel metadata universe where existing patterns already suffice?

### 5. Stream-safe

Does the design work for unknown future streams rather than only the current examples?

Questions:

- Can it express a stream with exact filters only?
- a stream with declared range filters on one field but not another?
- a stream with no expansion?
- a stream with one expandable relation?
- a stream with no special query capabilities at all?

### 6. Human-reviewable

Does the model preserve PDPP's consent and minimization philosophy rather than hiding powerful behavior behind obscure technical metadata?

Questions:

- Would an operator or implementer still be able to explain what a stream supports in plain terms?
- Does the model avoid turning request-time capability discovery into a shadow consent model?

### 7. Machine-readable

Can the design feed generated contracts, validators, typed clients, docs, and agents directly?

Questions:

- Can OpenAPI or equivalent machine-readable artifacts reflect it cleanly?
- Can an SDK or agent construct valid requests from it without guesswork?

### 8. Incremental

Can the project start with a small truthful version now without foreclosing a better future model later?

Questions:

- Can we ship a minimal discovery model now and extend it later without breaking clients?
- Does the design force the protocol to solve tomorrow's problems before today's needs are stable?

## Working assumptions going into the next pass

These are not yet final decisions, but they are the current owner assumptions to test:

1. The current per-stream `query` object is probably directionally right.
2. A broader capability document may eventually be useful, but it should not be added unless it solves a concrete problem that stream metadata cannot solve elegantly.
3. Server-level capability discovery, if added, should be small and clearly separate from stream-specific query power.
4. The best long-term answer is likely layered, but the layering must earn its complexity.

## Candidate family to evaluate next

The next pass should compare at least these candidate families explicitly:

### A. Stream-only capability discovery

- Keep capability discovery primarily in stream metadata.
- The current `query` object grows only as needed.
- No separate broader capability document yet.

### B. Layered server + stream discovery

- Small server-level capability metadata for cross-stream/global facts.
- Per-stream metadata remains authoritative for stream-specific query power.
- Broader capability document deferred unless later justified.

### C. Broader capability document

- Add a more explicit global capability-discovery surface.
- Stream metadata still exists, but the broader document becomes a first-class discovery layer.
- Requires proof that the additional layer solves real interoperability or client-generation problems.

These candidates should be scored against the rubric rather than judged by intuition alone.

## Immediate next step

With this framing frozen, the next owner pass should:

1. audit what relevant research is already captured on disk
2. identify what targeted additional research is still needed
3. compare the candidate families against the rubric and concrete scenarios
4. only then recommend a capability-discovery shape for PDPP

## Success condition

This framing step is complete when the project can say:

- the capability-discovery question is now explicit
- the scoring rubric is explicit
- the next research/design pass can be run deliberately instead of improvisationally
