## Context

The reference now exposes `GET /v1/connectors` and per-stream metadata, and recent work added range filters, filtered retrieval, and safe `expand[]`. The data is present but scattered: clients must inspect schema, query declarations, relationships, and grant behavior separately. That is hostile to assistant clients and leads to broad fetching.

## Goals / Non-Goals

Goals:

- Make query planning self-service for clients and agents.
- Keep existing metadata backward-compatible.
- Represent exact filters, range operators, lexical fields, semantic fields, and expansion relations in one normalized shape.
- Make grant-relative usability explicit where the bearer token limits fields.

Non-goals:

- New query grammar, new operators, sorting, aggregations, hybrid search, or score output.
- Hiding existing schema metadata that is already returned today.
- Inventing portable cross-connector field semantics such as `date` or `amount` aliases.

## Decisions

### Add `field_capabilities` beside existing metadata

The least disruptive shape is a new object keyed by top-level field name:

```json
{
  "field_capabilities": {
    "received_at": {
      "schema": { "type": "string", "format": "date-time" },
      "granted": true,
      "exact_filter": true,
      "range_filter": { "operators": ["gte", "gt", "lte", "lt"] },
      "lexical_search": false,
      "semantic_search": false
    }
  }
}
```

This mirrors what clients need to decide before issuing a request and leaves existing `query.*` declarations intact.

### Keep expansions relation-level

Expansion is not a field capability on a scalar field. Include an `expand_capabilities` list derived from `query.expand[]` and `relationships[]`, with relation name, related stream, cardinality, and limit metadata. This avoids forcing joins into a field map.

### Distinguish declared from usable

For owner tokens, declared and usable normally match. For client tokens, a stream may declare a range filter on a field outside the grant. The capability shape should make that visible with `granted` and `usable`/`reason` fields rather than requiring clients to learn by receiving `field_not_granted`.

## Acceptance Checks

- A client can fetch one stream metadata document and know which fields can be used in exact filters, range filters, lexical search, semantic search, and expansions.
- A field outside the client grant is not advertised as usable even if the stream declares it.
- Existing clients that read `schema`, `query`, and `relationships` continue to work.
