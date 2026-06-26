## Context

Connector manifests are the authoring point where a connector says what clients can safely do with already-granted fields. The system intentionally does not infer semantics from field names at read time. That keeps honesty strong, but it means missing manifest declarations become real product gaps.

The 2026-06-26 manifest audit found that message-like search affordances are now mostly in place, but time, range, aggregation, and facet affordances are uneven. It also found a possible trap: the existing role-authoring guide says `x_pdpp_role: event-time` should not be used as a generic timestamp marker. That boundary should remain. A timestamp can be range-filterable or groupable without being the presentation event-time slot for an event card.

## Decision

Treat manifest query affordances as a separate authoring contract from presentation roles:

- `query.search.lexical_fields` and `query.search.semantic_fields` describe text retrieval.
- `query.range_filters` describes fields that can bound record reads and search.
- `query.aggregations.group_by_time` describes schema-compatible time fields that can produce calendar buckets.
- `x_pdpp_role` describes how a record card reads; it does not make a field searchable, filterable, or groupable.

The implementation should add declarations only when the field is present, granted, top-level, and the backend supports the declared operation for that field's schema type. Integer epoch fields must not be declared as `group_by_time` unless the server contract is intentionally extended to support them.

The audit should produce a machine-readable allowlist for fields that appear useful but are intentionally unsupported, with one-line reasons. This keeps the test from forcing bad semantics while preventing silent drift.

## Alternatives

- **Use `event-time` everywhere a timestamp exists.** Rejected. It violates the presentation/query boundary and makes message, transaction, and metric streams look like event cards.
- **Infer range/search/facet support from names.** Rejected. It recreates the field-name guessing problem the role work removed.
- **Declare every string searchable and every time-like field groupable.** Rejected. It indexes identifiers/statuses and can declare backend-invalid operations, especially for integer epochs.
- **Only document the guidance.** Rejected. Connector authors will miss it; manifest-honesty tests must enforce the contract.

## Acceptance Checks

- Every first-party connector stream with a useful owner-facing text field either declares lexical/semantic search where appropriate or has an explicit allowlist reason.
- Every first-party connector stream with a useful schema-compatible time field either declares a range filter and, where meaningful, `group_by_time`, or has an explicit allowlist reason.
- No `group_by_time` declaration targets a field the server rejects for time-bucket aggregation.
- Presentation roles remain valid: no duplicate `primary-title`, no role on absent fields, and no use of `event-time` as a generic query-time marker.
- Compact schema and MCP schema surfaces expose the resulting capabilities accurately enough for a client to avoid trial-and-error.

## Residual Risks

- Some streams are inherently ambiguous: metrics, inventory, stats, and local-file metadata can be useful for filtering but poor as presentation events. The allowlist must record those decisions instead of forcing fake card roles.
- Adding declarations may require deployed instances to rebuild indexes or refresh field-capability projections.
- The connector authoring guide still needs prior-art research beyond this repo audit before it becomes a durable contributor guide.

