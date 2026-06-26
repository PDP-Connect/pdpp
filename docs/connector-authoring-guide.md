# Connector Authoring Guide

This guide is for first-party connector manifests. Keep it open while adding or reviewing a connector.

The goal is not "valid JSON." The goal is an honest, useful record surface: clients can search what should be searched, filter what should be filtered, group what should be grouped, display records without guessing, and ask for bounded follow-up reads before full fetch/export.

## Required Review

1. **Name the stream for the owner, not the implementation.** A stream name should describe a stable source collection or derived subset. Do not encode a temporary predicate into a stream name.
2. **Declare readable fields narrowly.** Every schema field is a disclosure surface. Do not add raw blobs, oversized bodies, hidden implementation paths, tokens, or diagnostics unless the stream purpose requires them.
3. **Declare search deliberately.** Natural-language owner-visible fields such as `text`, `content`, `body_text`, `summary`, `description`, `title`, `memo`, and `caption` should be in `query.search.lexical_fields`. Meaning-bearing title/body/note fields should also be in `query.search.semantic_fields`.
4. **Do not semantic-index identifiers.** IDs, URLs, paths, hashes, MIME types, status codes, timestamps, currency codes, and enum-like strings are not semantic text. Use exact filters, range filters, relationships, or display roles instead.
5. **Declare presentation roles.** Every supported stream must declare `schema.properties[field].x_pdpp_role` on at least one field. Use one `primary-title`; use `secondary`, `event-time`, `actor`, `amount`, or `media` only when the field really fills that slot.
6. **Keep type and role separate.** `x_pdpp_type` controls formatting. `x_pdpp_role` controls placement. A text field can be a title, body, actor label, or supporting detail.
7. **Declare relationships explicitly.** If a record points at another stream, add a relationship. Do not expect clients to infer joins from `*_id` fields.
8. **Declare time honestly, and keep range/group separate from presentation.** A field can be range-filterable or `group_by_time`-groupable without being the card's `event-time` slot — these are independent axes. Declare `range_filters` on any granted date/date-time field useful for bounded reads (skip ingest `fetched_at` and the stream's sync `cursor_field`). Declare `group_by_time` on the record's *event* axis (its creation/start time), not on secondary state markers (`updated_at`, `closed_at`, `completed_at`, `last_*`), interval closings (`end_*`), or ingest time. **`group_by_time` is schema-gated:** the server accepts it only on a `string` field with `format: date`/`date-time` — never on an integer epoch (those are range-only). Grouping (`group_by`/`group_by_time`) also requires `aggregations.count: true` on the stream.
9. **Facets are `group_by` on scalar fields.** Stable low-cardinality scalar fields (status, type, category, currency, method, subreddit, channel) can be declared under `query.aggregations.group_by` for grouped counts. There is no separate `eq` operator; `group_by` is the facet/equality channel. Don't facet free text or high-cardinality identifiers.
10. **Prefer bounded read before full fetch.** Long text should remain readable by bounded field/window tools. Full fetch/export is a fallback, not the normal path for ordinary message classification.
11. **Honest non-support over fake affordances.** If a field looks useful for an affordance but you intentionally withhold it (privacy-sensitive addresses, snapshot/accounting periods, operational job timing, integer-epoch `group_by_time`), add a justified entry to `packages/polyfill-connectors/src/query-affordance-allowlist.ts`. Do not silently omit it — the honesty test fails on useful-but-undeclared fields and on stale allowlist entries alike.
12. **Run the manifest-honesty tests.** If the tests fail, fix the manifest or add a justified allowlist entry. Do not weaken the test to land a connector.

## Field Examples

| Field | Good Declarations | Avoid |
| --- | --- | --- |
| `messages.text` | `lexical_fields`, `semantic_fields`, `x_pdpp_role: "primary-title"` | Treating it as readable-only. |
| `messages.sent_at` | range filter, `group_by_time` (NO `event-time` role — a message is not an event card) | Stamping `event-time` on a message timestamp just to chart it; using ingest/fetched time for event charts. |
| `events.start` (calendar) | range filter, `group_by_time`, `x_pdpp_role: "event-time"` | Withholding the event-time role on a genuine event card. |
| `orders.status` | `query.aggregations.group_by` facet | Leaving a stable status enum unfacetable, forcing clients to guess. |
| `skills.mtime_epoch` (integer) | range filter only; allowlist `group_by_time` | Declaring `group_by_time` on an integer epoch the server rejects. |
| `messages.author` | lexical if owner-visible, `x_pdpp_role: "actor"` | Embedding it semantically as body text. |
| `attachments.filename` | lexical when useful, `x_pdpp_role: "primary-title"` | Semantic-indexing path/hash/blob fields. |
| `transactions.memo` | lexical and semantic when owner-authored/free text | Treating transaction IDs as semantic text. |
| `records.url` | exact/display only if needed | Searchable/semantic by default. |

## Tests That Enforce This

- `packages/polyfill-connectors/src/search-affordance-manifest-honesty.test.ts` — lexical/semantic search coverage.
- `packages/polyfill-connectors/src/presentation-role-manifest-honesty.test.ts` — presentation roles.
- `packages/polyfill-connectors/src/query-affordance-manifest-honesty.test.ts` — range/`group_by_time`/`group_by` coverage, server-validity (date-string `group_by_time`, scalar `group_by`, `count: true`), and the both-directions allowlist check.
- `packages/polyfill-connectors/src/query-affordance-schema-projection.test.ts` — proves declared affordances surface in `field_capabilities` (clients don't read raw manifest JSON).

The intentional-non-support allowlist lives in `packages/polyfill-connectors/src/query-affordance-allowlist.ts`.

These tests are part of the guide. If a connector author has to remember the rule without a failing test, the rule is not durable enough.

## Research Basis

- [connector-authoring-semantics-prior-art-2026-06-24.md](research/connector-authoring-semantics-prior-art-2026-06-24.md) — search/filter/facet/role as separate axes (Algolia, Elasticsearch, Plaid).
- [connector-query-affordance-authoring-2026-06-26.md](research/connector-query-affordance-authoring-2026-06-26.md) — the verified rule set behind the query-affordance honesty contract.
- [connector-query-affordance-audit-2026-06-26.md](research/connector-query-affordance-audit-2026-06-26.md) — the audit that scoped this tranche.
