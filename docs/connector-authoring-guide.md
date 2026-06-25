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
8. **Declare time honestly.** Use range filters and `group_by_time` only on fields that carry the source event time the owner expects to see. Do not group by ingest time unless the stream is explicitly about ingestion.
9. **Prefer bounded read before full fetch.** Long text should remain readable by bounded field/window tools. Full fetch/export is a fallback, not the normal path for ordinary message classification.
10. **Run the manifest-honesty tests.** If the tests fail, fix the manifest or make the exclusion rule explicit in the test. Do not weaken the test to land a connector.

## Field Examples

| Field | Good Declarations | Avoid |
| --- | --- | --- |
| `messages.text` | `lexical_fields`, `semantic_fields`, `x_pdpp_role: "primary-title"` | Treating it as readable-only. |
| `messages.sent_at` | range filter, `group_by_time`, `x_pdpp_role: "event-time"` | Using ingest/fetched time for event charts. |
| `messages.author` | lexical if owner-visible, `x_pdpp_role: "actor"` | Embedding it semantically as body text. |
| `attachments.filename` | lexical when useful, `x_pdpp_role: "primary-title"` | Semantic-indexing path/hash/blob fields. |
| `transactions.memo` | lexical and semantic when owner-authored/free text | Treating transaction IDs as semantic text. |
| `records.url` | exact/display only if needed | Searchable/semantic by default. |

## Tests That Enforce This

- `packages/polyfill-connectors/src/search-affordance-manifest-honesty.test.ts`
- `packages/polyfill-connectors/src/presentation-role-manifest-honesty.test.ts`

These tests are part of the guide. If a connector author has to remember the rule without a failing test, the rule is not durable enough.

## Research Basis

See [connector-authoring-semantics-prior-art-2026-06-24.md](research/connector-authoring-semantics-prior-art-2026-06-24.md).
