# Record-query contract review — 2026-04-21

**Status:** active review / careful-review required
**Author:** Codex (owner agent)

## Purpose

Capture an explicit project decision: the public record-query contract now deserves careful review before the team hardens it into a generated reference contract, OpenAPI artifact, or framework migration.

This note is not a normative PDPP edit and not yet a change proposal. It exists so the repo does not drift into either of these mistakes:

- treating the current Core query surface as already settled just because it is written down
- treating the current reference implementation as the de facto contract just because it ships today

## Why this needs a slower pass

The record-query surface is now higher-stakes than an ordinary reference-only cleanup because it sits at the intersection of:

- the root PDPP Core spec
- the live reference implementation
- future OpenAPI / machine-readable reference contracts
- future typed clients and query builders
- future AI-facing docs surfaces (`llms.txt`, `llms-full.txt`, MCP/docs)

If the team moves too quickly here, it can freeze the wrong thing in three places at once:

1. prose spec
2. executable reference contract
3. generated docs / client surfaces

## Current facts

The current Core spec advertises a broader `GET /v1/streams/{stream}/records` surface than the live reference implementation actually honors.

Directionally, the intended surface is:

- `limit`
- `cursor`
- `order`
- exact filters
- range filters
- `view`
- `fields`
- `expand[]`
- `expand_limit[...]`
- `changes_since`
- stable sort by `(cursor_field, primary_key)`
- `freshness` metadata

The live reference implementation already proves and relies on:

- exact-match filtering
- `view` / `fields`
- grant-aware field/resource/time-range enforcement
- `changes_since`
- opaque pagination

The live reference does **not** yet fully prove or implement:

- range filter operators
- relation expansion
- stable sort and page cursors keyed to `(cursor_field, primary_key)` rather than internal row id
- `freshness` metadata on the read surfaces promised by Core

That means the issue is not just documentation discoverability. There is a real spec/reference gap.

## Working posture

Proceed optimistically, but not casually.

The optimistic assumption is:

- the intended query API is probably directionally right
- several parts of it are worth keeping
- the project should prefer a truthful machine-readable reference contract over retreating into hand-wavy prose

But the team should not freeze the surface into OpenAPI or a new server stack until the higher-risk areas have been reviewed deliberately.

## Review targets

The careful-review work should answer, item by item, whether each area should be:

- **kept as-is and implemented**
- **narrowed before implementation**
- **reframed as reference-only instead of normative**

The main review targets are:

1. **Range filters**
   - Which field types support `gte` / `gt` / `lte` / `lt`?
   - Should unsupported operators be rejected by field type?
   - Do we want arbitrary scalar filtering or a narrower, manifest-declared filterability model?

2. **Expansion**
   - Should `expand[]` remain part of the public contract?
   - If yes, should the launch reference limit it to depth-1 manifest-declared relationships only?
   - What exact error and grant-check behavior is durable contract versus reference choice?

3. **Stable sort and cursor semantics**
   - Is `(cursor_field, primary_key)` still the right durable sort model?
   - How should nulls, missing cursor values, and mutable-state updates behave?
   - What cursor payload shape is required to keep the promise honest?

4. **Freshness**
   - Is `freshness` still important enough to keep in the contract?
   - If yes, what minimum semantics are strong enough to be useful without overstating source recency?

5. **Truthful machine-readable contract**
   - What should the reference claim today?
   - What should remain intentionally absent from the first OpenAPI / generated contract layer until implemented?

## Immediate non-decisions

This note does **not** yet decide:

- whether Core should narrow to the current reference implementation
- whether the reference implementation should catch up to Core everywhere
- whether the API server should move from Express to Fastify immediately
- the exact OpenAPI generation mechanism

Those are downstream decisions. This note only establishes that the contract needs deliberate review before those choices are finalized.

## Near-term execution sequence

1. audit the live query surface against Core and examples
2. classify each area as keep / narrow / reference-only
3. update the root spec intentionally where needed
4. make the reference implementation truthful to the chosen contract
5. only then freeze the surface into OpenAPI / generated docs / typed clients

## Success condition

This review is complete when the project can say, truthfully and without ambiguity:

- the root PDPP spec says exactly what the query API means
- the reference implementation either implements that meaning or clearly scopes what is not yet shipped
- the machine-readable contract matches the implementation
- generated docs and AI-facing surfaces no longer force users to guess between prose and code
