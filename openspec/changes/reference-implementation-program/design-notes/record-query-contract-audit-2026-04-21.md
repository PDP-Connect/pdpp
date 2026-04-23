# Record-query contract audit — 2026-04-21

**Status:** first-pass audit / classification
**Author:** Codex (owner agent)

## Purpose

Compare the current Core record-query promises to the live reference implementation and classify each major area as:

- **keep and implement**
- **narrow before implementation**
- **reference is already aligned**

This is the first two steps of the current review sequence:

1. audit the live query surface against Core and examples
2. classify each area as keep / narrow / reference-only

It is intentionally upstream of any normative rewrite.

## Scope

Primary focus:

- `GET /v1/streams`
- `GET /v1/streams/{stream}`
- `GET /v1/streams/{stream}/records`
- `GET /v1/streams/{stream}/records/{id}`
- `GET /v1/blobs/{blob_id}`

Primary files reviewed:

- `spec-core.md`
- `spec-data-query-api.md` (historical only)
- `apps/web/content/docs/spec-data-query-api.md`
- `reference-implementation/server/index.js`
- `reference-implementation/server/records.js`
- current read/query tests in `reference-implementation/test/*`

## Feature-by-feature audit

### 1. `fields` / `view`

**Core says**

- list reads support `view` or `fields`
- they are mutually exclusive
- fields are top-level only
- required fields remain included

**Reference does**

- validates `view` and `fields` mutual exclusion
- resolves `view` to field lists
- enforces grant-authorized field subsets
- projects disclosures accordingly

**Current read**

- the design is aligned
- this is one of the strongest parts of the current query surface

**Classification**

- **reference is already aligned**
- keep as durable contract

### 2. exact `filter[{field}]`

**Core says**

- exact-match filter exists
- unauthorized fields must be rejected

**Reference does**

- exact equality only
- rejects unauthorized fields
- carries query rejection through timelines and CLI/operator surfaces

**Current read**

- the core behavior is real and useful
- this is safe to keep

**Classification**

- **reference is already aligned**
- keep as durable contract

### 3. range filters `filter[{field}][gte|gt|lte|lt]`

**Core says**

- range operators are supported

**Reference does**

- does not implement comparator semantics
- current `passesRequestFilters()` only supports exact string equality against direct values

**Current read**

- this is real drift, not a docs misunderstanding
- the contract currently promises more than the reference delivers
- based on the principles + prior art review, the broader issue is not just missing implementation; it is that the contract may be too broad unless operator/field semantics are typed explicitly

**Classification**

- **narrow before implementation**

**Why narrow first**

- arbitrary comparator support across all fields is too loose
- typed/operator rules should be explicit before the feature is hardened into OpenAPI or generated clients

### 4. `expand[]` / `expand_limit[...]`

**Core says**

- list reads support `expand[]` and `expand_limit[...]`
- record detail supports `expand[]`
- unknown expand must error
- expansion must not widen grant permissions
- expanded relations appear under `expanded`

**Reference does**

- no real expansion handling on the read paths
- no hydration logic on record list or record detail
- only the `invalid_expand` error code mapping exists

**Current read**

- this is the highest-risk area in the current contract
- the reference does not support it
- the docs/examples are not even fully self-consistent on expansion payload shape
- the design needs narrowing before implementation to avoid accidental query-language sprawl

**Classification**

- **narrow before implementation**

**Likely narrowing direction**

- manifest-declared relationships only
- depth 1 only in the reference unless stronger evidence emerges
- bounded per-relation limits
- explicit grant checks per expanded relation
- one canonical response shape before implementation starts

### 5. stable sort by `(cursor_field, primary_key)`

**Core says**

- list reads are sorted by `(cursor_field, primary_key)` for cursor safety

**Reference does**

- normal pagination is ordered by internal row id
- page cursors encode internal ids

**Current read**

- the current implementation is not aligned
- but the intended design is still probably right
- this is a strong candidate for "keep and implement" rather than narrowing away

**Classification**

- **keep and implement**

**Caveats to settle during implementation**

- null or missing cursor-field handling
- compound primary keys
- mutable-state ordering semantics
- cursor payload shape

### 6. `changes_since`

**Core says**

- distinct token space from normal pagination
- projection-aware eligibility
- tombstones for deletions
- `next_changes_since` on terminal page
- HTTP 410 on expiry

**Reference does**

- all of the above, with real grant-aware behavior and strong tests

**Current read**

- this is one of the strongest parts of the current read/query surface

**Classification**

- **reference is already aligned**
- keep as durable contract

### 7. `freshness`

**Core says**

- the RS MAY attach `freshness` to stream lists, stream metadata, and record-list responses
- Collection Profile Tier 2 conformance text currently treats those surfaces as required freshness publication points, with `status: "unknown"` when recency is unknown

**Reference does**

- stream list returns `record_count` and `last_updated`, not `freshness`
- stream metadata omits `freshness`
- record list omits `freshness`

**Current read**

- the implementation is behind
- but the design itself is reasonable if the semantics stay advisory and honest

**Classification**

- **keep and implement**

**Caveat**

- the minimum viable contract should allow `status: "unknown"` and avoid overstating source recency guarantees

### 8. blob fetch

**Core says**

- blob fetch is part of the RS read surface
- `GET /v1/blobs/{blob_id}` is defined, with authorization tied back to granted record access

**Reference does**

- no blob route today
- only the `blob_not_found` error code exists in the server error map

**Current read**

- this is another real spec/reference gap
- unlike expansion, this does not look conceptually over-broad; it looks simply unfinished or out of scope

**Classification**

- **keep and implement**, unless the project intentionally narrows the public read surface to exclude blob delivery for this phase

## Summary classification

### Reference already aligned

- `fields`
- `view`
- exact `filter[{field}]`
- `changes_since`

### Keep and implement

- stable sort by `(cursor_field, primary_key)`
- `freshness`
- blob fetch

### Narrow before implementation

- range filters
- `expand[]`
- `expand_limit[...]`

## Most important conclusion

The current gap is not just "the docs are unclear."

It is:

- some parts of the intended query surface are already real and strong
- some parts are promised but unimplemented
- and the highest-risk unimplemented parts are also the ones most likely to deserve narrowing before we freeze them into a machine-readable contract

That means the right next move is not immediate OpenAPI generation from the current prose.

The right next move is:

1. revise the chosen query contract intentionally
2. then make the implementation and machine-readable contract truthful to that choice
