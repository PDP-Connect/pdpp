# Native RS Scoping Options

**Date:** 2026-04-16  
**Purpose:** Define the exact public RS scoping options for the native-provider seam, decide what the reference should choose first, and explain the implications for URLs, query params, CLI UX, and the parallel polyfill path.

## Bottom line

For the native provider path, owner and client queries should **not** require `connector_id`.

The first reference cut should choose:

> **implicit provider-local scoping for the native RS path, while preserving explicit source-scoped query parameters only on the personal-server/polyfill path**

That means:

- native provider URLs stay stream-local and clean
- native CLI UX does not require `--connector-id`
- polyfill path stays explicit about source scoping
- the underlying RS engine can still use an internal source key temporarily

This is the cleanest first choice because it fixes the ontology leak without forcing a storage rewrite or inventing a new generalized multi-source RS contract before it is needed.

---

## Scope of this memo

This memo is only about the **public RS contract** for querying data.

It is not about:

- AS request semantics
- grant serialization
- Collection Profile runtime endpoints
- storage schema refactors

The question is narrower:

> if the native provider path should not expose `connector_id`, what scoping options actually exist at the RS boundary?

---

## Current state

Today the RS uses explicit `connector_id` on the owner path:

- `GET /v1/streams?connector_id=...`
- `GET /v1/streams/:stream?connector_id=...`
- `GET /v1/streams/:stream/records?connector_id=...`
- `GET /v1/streams/:stream/records/:id?connector_id=...`
- `DELETE /v1/streams/:stream/records?connector_id=...`
- `DELETE /v1/streams/:stream/records/:id?connector_id=...`

Client-token query paths do not require the query param, but they still derive scope from:

- `grant.connector_id`

So both owner and client semantics still read as connector-scoped.

That is acceptable for the personal-server/polyfill realization.
It is not acceptable for a native provider such as `Northstar HR`.

---

## Public RS scoping options

## Option 1: Implicit provider-local scoping

### Shape

The RS is understood to represent exactly one provider’s native data surface.

Public query shape:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

No source selector appears in:

- path
- query params
- CLI flags

### Semantics

- owner tokens query the provider’s own streams directly
- client tokens query grant-scoped provider-local streams directly
- stream names are interpreted within the provider boundary

### Strengths

- cleanest native-provider contract
- matches what readers expect from a cooperating platform
- simplest CLI UX
- no connector ontology leak
- minimal change to current route family

### Weaknesses

- only works cleanly when the RS represents one native provider surface
- does not solve generic multi-source personal-server scoping
- requires app composition or deployment mode to tell the server which internal source key to use

### Best use

- native provider path

---

## Option 2: Path-scoped source/provider prefix

### Shape

The source or provider becomes part of the path:

- `GET /v1/providers/:provider/streams`
- `GET /v1/providers/:provider/streams/:stream/records`

or:

- `GET /v1/sources/:source/streams/:stream/records`

### Semantics

- the public contract always names the source boundary explicitly
- both native and polyfill paths can share one route family

### Strengths

- explicit and uniform across realizations
- avoids query-param clutter
- works better than `connector_id` query params for a multi-source engine

### Weaknesses

- makes the native provider contract look more infrastructural than necessary
- leaks realization concerns into the clean native path
- increases URL complexity
- likely over-design for the first reference cut

### Best use

- maybe later for a generalized multi-source personal server
- not the best first native-provider contract

---

## Option 3: Query-param source scoping with renamed field

### Shape

Keep current route family, but rename the query param:

- `GET /v1/streams?source=...`
- `GET /v1/streams/:stream/records?source=...`

or:

- `provider=...`
- `dataset=...`

### Semantics

- cleaner than `connector_id`
- still an explicit source selector

### Strengths

- smallest change mechanically
- storage layer can remain almost untouched
- works for polyfill and multi-source cases

### Weaknesses

- still leaks scoping into the native contract
- native CLI still needs `--source` or `--provider`
- semantically only a partial fix: “connector” disappears, but the query still feels like a source-picker

### Best use

- maybe as a transitional polyfill alias
- not the right native contract

---

## Option 4: Token-bound scoping only

### Shape

For both owner and client tokens, scoping is derived entirely from token context.

Public routes:

- `GET /v1/streams`
- `GET /v1/streams/:stream/records`

No explicit source selector, even on owner paths.

### Semantics

- owner token would need to carry provider/source context
- client token already carries grant context

### Strengths

- extremely clean URLs
- no scoping parameter anywhere

### Weaknesses

- bad fit for current owner self-export model
- owner tokens are intentionally broad and should not silently imply a hidden source boundary unless the provider is truly single-surface
- awkward for personal-server/polyfill scenarios where one owner may have multiple sources

### Best use

- not recommended as the general first step
- only plausible if a native provider issues provider-local owner tokens in a dedicated deployment

---

## Option 5: Dual contract by realization

### Shape

Use different public RS contracts for:

- native provider
- personal server/polyfill

Native:

- implicit provider-local routes

Polyfill:

- explicit source-scoped routes

### Semantics

- each realization gets the cleanest public contract for its actual shape

### Strengths

- most honest representation of the two realizations
- lets the native provider be simple and first-party
- lets the polyfill path remain explicit about source boundaries
- avoids premature generalized abstraction

### Weaknesses

- requires discipline in docs, CLI, and tests
- some shared tooling must know which realization it is speaking to

### Best use

- this is the right first reference choice

---

## Recommended first choice

Choose **Option 5**, implemented as:

- **Option 1 for the native provider**
- **current explicit source-scoped behavior for the polyfill path, cleaned up but not hidden**

Why this is the best first cut:

1. It makes the native provider honestly provider-native.
2. It avoids forcing the polyfill path to pretend it is not multi-source.
3. It avoids a broad RS route redesign before the native-provider story is proven.
4. It lets the shared RS engine keep an internal source key for now.

This is the most surgical move.

---

## What this means for public URLs

## Native provider path

Recommended public shape:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

No `connector_id`.
No `source`.
No provider prefix in the URL.

Interpretation:

- the provider boundary is implicit because the caller is already talking to `Northstar HR`

## Polyfill path

Keep explicit source scoping for now.

Current shape can remain temporarily:

- `GET /v1/streams?connector_id=...`
- `GET /v1/streams/:stream/records?connector_id=...`

But it should be understood as:

- reference-architecture / personal-server scoping
- not the native-provider contract

If desired later, the polyfill path could rename `connector_id` to `source` or move to a path prefix, but that should not block the first native-provider cut.

---

## What this means for query params

## Native path

Do not require any source-scoping query param.

Query params should be limited to actual query behavior:

- `limit`
- `cursor`
- `changes_since`
- `view`
- `fields`
- `filter[...]`

That keeps the native RS focused on data query semantics, not realization mechanics.

## Polyfill path

Keep explicit source-scoping query params until a cleaner polyfill contract is chosen.

That is honest because:

- a personal server may contain multiple sources
- explicit source scoping is part of that reality today

---

## What this means for CLI UX

## Native provider CLI UX

Owner commands should become:

- `pdpp owner streams`
- `pdpp owner query pay_statements`
- `pdpp owner get pay_statements <record-id>`
- `pdpp owner export pay_statements`

No `--connector-id`.

That is the cleanest and most understandable UX for a native provider.

## Polyfill CLI UX

Keep explicit source selection:

- `pdpp owner streams --connector-id <id>`
- `pdpp owner query top_artists --connector-id <id>`

This should be described as:

- current personal-server/reference surface

not as the universal PDPP owner UX.

## CLI implementation consequence

The owner CLI will need a realization-aware mode or endpoint/profile awareness.

That is acceptable.

It is better than forcing the native UX to inherit `--connector-id` forever just to make one command family uniform.

---

## How to keep the polyfill path honest

The risk is not only that the native path looks like a connector.
The opposite risk is pretending the polyfill path is magically first-party.

To keep the polyfill path honest:

- continue to expose explicit source scoping on that path
- continue to keep Collection Profile routes and runtime concerns on that realization only
- continue to describe it as a personal-server/polyfill deployment

Do **not** try to erase source scoping from the polyfill path before the generalized multi-source RS story is actually designed.

The two realizations should be:

- native path: clean, provider-local
- polyfill path: explicit, source-aware

That is not inconsistency. That is architectural honesty.

---

## Minimal contract cut for the reference

The smallest credible implementation move is:

1. native provider app composition mounts the RS routes without requiring `connector_id`
2. native provider app resolves a fixed internal source key, e.g. `northstar_hr`
3. polyfill/personal-server app composition keeps the current explicit source-scoped owner routes
4. CLI owner UX drops `--connector-id` for native mode but keeps it for polyfill mode

This cut does **not** require:

- rewriting `queryRecords()`
- renaming DB columns
- inventing a new universal multi-source RS contract

It only requires separating what the caller sees from how the shared engine scopes internally.

---

## Anti-patterns to avoid

### 1. Forcing the native provider to expose `source` just to preserve one universal route family

This is a cleanliness failure disguised as consistency.

### 2. Hiding source scoping on the polyfill path before there is a real replacement

That would make the personal-server story less honest.

### 3. Rewriting storage before proving the public contract

The first problem is contract truth, not schema elegance.

### 4. Introducing a generalized `/providers/:id/...` path too early

This may become useful later, but it is unnecessary for the first reference cut and makes the native provider feel less first-party.

---

## Recommendation

For the first reference implementation cut:

- make the **native provider RS path implicitly provider-local**
- keep the **polyfill path explicitly source-scoped**
- let the shared engine continue using an internal source key behind the boundary

That is the best surgical move because it:

- fixes the native ontology leak
- preserves the honesty of the polyfill path
- keeps URLs and CLI UX clean where they should be clean
- avoids a premature generalized multi-source redesign
