## 1. Audit And Contract

- [x] 1.1 Convert the 2026-06-26 manifest semantics audit into a machine-readable expected-affordance table for first-party manifests.
- [x] 1.2 Define the allowlist shape for intentionally unsupported useful fields, with one-line reasons.
- [x] 1.3 Reconcile the existing role-authoring guide so `event-time` remains a presentation role, not a generic timestamp/query marker.

## 2. Manifest Updates

- [x] 2.1 Add missing lexical and semantic search declarations for useful owner-facing text fields that remain uncovered.
- [x] 2.2 Add missing `query.range_filters` declarations for useful schema-supported date, date-time, and other range fields.
- [x] 2.3 Add missing `query.aggregations.group_by_time` declarations only for schema-supported time fields where count-over-time is meaningful.
- [x] 2.4 Add or defer facet/equality affordances explicitly: either implement supported facet declarations or record that the current query contract does not expose manifest-authored facets yet. (Implemented via `query.aggregations.group_by` on stable scalar facet fields.)

## 3. Enforcement

- [x] 3.1 Add manifest-honesty tests for useful undeclared search, range, aggregation, and facet/equality affordances. (`query-affordance-manifest-honesty.test.ts`)
- [x] 3.2 Add validation that `group_by_time` targets only fields accepted by the server aggregation schema. (date/date-time string only; integer epoch rejected.)
- [x] 3.3 Add compact-schema and MCP-schema checks proving clients can discover the declared affordances without raw manifest JSON. (`query-affordance-schema-projection.test.ts`; MCP schema-token + reference compact-view suites green.)

## 4. Authoring Guidance

- [x] 4.1 Research prior art for connector/schema authoring guidance and record findings under `docs/research/`. (`connector-query-affordance-authoring-2026-06-26.md`, building on the 2026-06-24 prior-art doc.)
- [x] 4.2 Update the connector authoring guide with a concise checklist for search, range, aggregation, facets, presentation roles, and non-support justifications.
- [x] 4.3 Link the guide from the contributor entry point used by connector authors. (CONNECTORS.md already links `docs/connector-authoring-guide.md`.)

## 5. Validation

- [x] 5.1 Run manifest-honesty tests. (26 honesty + projection tests green.)
- [x] 5.2 Run package-level polyfill connector validation. (typecheck clean; ultracite clean on new files.)
- [x] 5.3 Run reference schema/field-capability tests affected by projection changes. (77 aggregate/schema-get + 15 compact-view tests green.)
- [x] 5.4 Run MCP schema/tool tests affected by compact capability output. (22 schema-token-budget tests green.)
- [x] 5.5 Run `openspec validate complete-connector-query-affordances --strict`. (valid)
- [x] 5.6 Run `git diff --check`. (clean)
