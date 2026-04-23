# Record-query contract proposed direction — 2026-04-21

**Status:** proposed direction for normative revision
**Author:** Codex (owner agent)

## Purpose

Turn the current audit and research into a concrete recommendation for the next PDPP Core revision.

This note is the bridge between:

- the research/audit already captured on disk
- the eventual root-spec edits
- the later reference/OpenAPI/Fastify work

It is intentionally opinionated. The goal is not to mirror every comparator mechanically, but to apply the best lessons with PDPP's own taste and constraints.

## Recommendation in one sentence

Keep the query API powerful, but stop pretending that all future streams support the same power uniformly.

That means:

- keep a small, durable global contract
- declare the higher-risk capabilities explicitly
- make unsupported shapes fail loudly

## Proposed contract layout

### 1. Small global core

These should remain part of the portable, shared PDPP read contract:

- `limit`
- `cursor`
- `order`
- `view`
- `fields`
- exact `filter[{field}]`
- `changes_since`
- stable sort semantics
- blob fetch
- `freshness`

But some of these need sharper wording, not removal.

### 2. Capability-declared higher-risk features

These should remain in PDPP, but in a more bounded and explicit form:

- range filters
- expansion
- expansion limits

The key move is:

- do not define them as if every field or relation supports them by default
- require explicit declaration where the semantics are not universally safe

### 3. Truthful reference contract

The reference implementation should later publish the actual shipped surface via:

- OpenAPI
- generated docs/examples
- typed query helpers
- AI-facing docs surfaces

But that layer should describe what the reference actually supports, not what Core merely aspires to.

## Proposed durable semantics

### Keep globally available: exact filters

Recommended contract:

- exact `filter[{field}]` remains globally available for **authorized top-level scalar fields**
- unknown fields return `400`
- unauthorized fields return `403`
- non-scalar fields return `400`

Why:

- this is already implemented directionally
- it is powerful enough to be useful across many streams
- equality on top-level scalar values is still human-reviewable and does not create the same semantic sprawl as richer query grammars

### Narrow: range filters

Recommended contract:

- `filter[{field}][gte|gt|lte|lt]` remains part of PDPP
- but it is only valid for fields the stream declares as range-queryable
- range-queryable fields must be orderable scalar types, at minimum:
  - `integer`
  - `number`
  - `string` with `format: date`
  - `string` with `format: date-time`
- unsupported field/operator combinations return `400`
- no nested paths, no arrays, no OR grammar, no text-search grammar

Recommended declaration shape in stream metadata:

```json
{
  "query": {
    "range_filters": {
      "source_created_at": ["gte", "gt", "lte", "lt"]
    }
  }
}
```

Why:

- keeps useful power
- avoids pretending every scalar field has meaningful order semantics
- maps well to FHIR-style typed search capability

### Narrow: expansion

Recommended contract:

- `expand[]` remains part of PDPP
- but only for manifest/stream-declared relationships
- expansion depth is `1` in v0.1
- expanded data appears only under `expanded`
- `expand_limit[{relation}]` is valid only for expanded `has_many` relations
- default/max limits are relation-bounded and declared
- expansion never widens grant permissions

Recommended declaration shape in stream metadata:

```json
{
  "relationships": [
    {
      "name": "messages",
      "stream": "messages",
      "foreign_key": "conversation_id",
      "cardinality": "has_many"
    }
  ],
  "query": {
    "expand": [
      {
        "name": "messages",
        "default_limit": 10,
        "max_limit": 50
      }
    ]
  }
}
```

Why:

- keeps explicit, bounded power in the Stripe sense
- avoids drifting into a generic relational query language
- keeps the consent and grant model understandable

### Keep and sharpen: stable sort

Recommended contract:

- list reads are ordered by `(cursor_field, primary_key)`
- opaque cursors encode logical sort position, not implementation row ids
- null or absent `cursor_field` values sort after present values
- compound primary keys remain allowed

Why:

- this is still the right model for portable cursor safety
- the current reference implementation is behind, but the contract should not be weakened to match that shortcut

### Keep and sharpen: freshness

Recommended contract:

- keep `freshness`
- preserve its advisory semantics
- make `status: "unknown"` a first-class honest value
- do not imply source freshness guarantees the RS does not actually have

Why:

- useful for operators and clients
- aligned with auditability/transparency
- safe if phrased honestly

### Keep and implement: blob fetch

Recommended contract:

- keep blob fetch in the public read surface
- keep authorization tied to discovery through an authorized record

Why:

- it is useful and conceptually clean
- it does not create the same semantic sprawl as broad query algebra

## Proposed stream-metadata shape

The minimum useful addition is a `query` object on stream metadata.

Recommended v0.1 shape:

```json
{
  "object": "stream_metadata",
  "name": "conversations",
  "schema": { },
  "primary_key": ["id"],
  "cursor_field": "source_updated_at",
  "relationships": [
    {
      "name": "messages",
      "stream": "messages",
      "foreign_key": "conversation_id",
      "cardinality": "has_many"
    }
  ],
  "query": {
    "range_filters": {
      "source_created_at": ["gte", "gt", "lte", "lt"]
    },
    "expand": [
      {
        "name": "messages",
        "default_limit": 10,
        "max_limit": 50
      }
    ]
  }
}
```

Notes:

- exact filtering does not need per-field declaration if the global rule is "authorized top-level scalar fields"
- `changes_since` and stable sort do not need per-stream declaration in the first revision; they are already anchored by `semantics`, `cursor_field`, and the Collection Profile model
- later capability surfaces may grow broader than this, but this is enough to stop the current ambiguity

## Recommended spec-edit direction

The next root-spec revision should:

1. keep `fields`, `view`, exact filters, `changes_since`, stable sort, blob fetch, and `freshness`
2. narrow range-filter semantics to declared/orderable fields
3. narrow expansion to declared depth-1 relationships with declared limits
4. define a small `query` capability object on stream metadata
5. make unsupported query shapes explicit protocol errors rather than silent no-ops
6. standardize the canonical expansion response shape under `expanded`

## What this intentionally does not do yet

- define a full FHIR-style capability document
- define nested expansion
- define text search
- define boolean filter algebra
- define arbitrary nested-path filtering
- force the reference contract to expose more than it actually ships today

## Owner recommendation

Proceed with a normative Core revision in this direction.

This is the strongest balance I can see between:

- PDPP's own design principles
- ecosystem-grade protocol lessons from Open Banking / FHIR / SMART
- tasteful developer-facing discipline from Stripe / Plaid
- the need to keep the reference implementation honest and finishable
