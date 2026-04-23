## Why

PDPP core defines record listing, exact and declared-range filters, expansion, cursoring, and `changes_since` — but no lexical retrieval contract. The evidence that this gap is real has accumulated:

- `apps/web/content/docs/spec-data-query-api.md` explicitly defers richer cross-stream search to a hypothetical future `POST /v1/search`.
- The reference's `/_ref/search` is still a reference-only artifact-and-record jump helper, not a publicly portable retrieval surface.
- The web dashboard's text search today brute-forces a fan-out substring scan across streams, which is materially slow on a real local corpus.
- An outside agent with valid grant access recently fell back to querying SQLite directly rather than trust the server's public surface, because no retrieval surface was good enough to be trusted.
- The reference optimistically added an FTS5 index behind `_ref/search` to stop that surface being unusable; that branch was explicitly scoped to stay reference-only and **does not** resolve the public contract question (see `design-notes/control-plane-search-lexical-index-open-question-2026-04-22.md`).

The owner decision, captured in `design-notes/lexical-retrieval-launch-worker-brief-2026-04-23.md` and `design-notes/lexical-retrieval-status-options-2026-04-23.md`, is to publicly launch **lexical retrieval as an optional extension**, not as ambient reference magic and not yet as mandatory core. The surface-status rubric in `design-notes/surface-status-ladder-2026-04-23.md` classifies this capability as the canonical example of an optional extension today.

This change drafts the smallest honest public lexical-retrieval contract that can live on that rung: named, discoverable, capability-declared, grant-safe, lexical-only, and portable enough to be implemented by something other than the reference. Semantic/vector retrieval remains explicitly out of scope.

## What Changes

- **Introduce a new optional extension capability** named `lexical-retrieval` that implementations MAY expose. Core PDPP remains unchanged; serious clients MUST NOT assume lexical retrieval exists unless it is advertised.
- **Define one public endpoint**: `GET /v1/search`, dedicated and cross-stream, with query parameters restricted to `q` (required), `limit`, `cursor`, and repeated `streams[]`. No DSL, no `rank=...`, no arbitrary field filters, no connector-specific parameters, no semantic/vector parameters.
- **Define a `search_result` result shape** that returns candidate references (stream, `record_key`, `record_url`, `emitted_at`, `matched_fields`, optional `snippet`) rather than fully hydrated records. Ordering is relevance-oriented but no portable numeric score is exposed.
- **Define grant-safe authorization semantics** on the search path: the extension searches only over streams + fields the caller is authorized to read AND the stream has declared searchable. Streams with zero authorized+searchable fields for the caller simply contribute zero hits. Snippets never surface text from ungranted fields.
- **Define a stream-level `query.search.lexical_fields` declaration** for searchable fields. v1 accepts top-level textual fields only (no nested paths, no arrays, no blobs, no connector-specific semantics).
- **Define a small server-level discovery layer** that answers only global facts about the extension: whether it is supported, where the endpoint lives, whether cross-stream is supported, whether snippets are supported, and global limit defaults. It does **not** duplicate per-stream field declarations, and it does **not** become a broader capability document.
- **Define opaque cursor pagination** distinct from record-list pagination and from `changes_since`. No promise of monotonic timestamps.
- **Describe a reference implementation plan using SQLite FTS5** without making SQLite normative. The contract defines portable behavior; FTS5 is one valid backing store.
- **Cleanup truthfulness drift** created by current surfaces:
  - `/_ref/search` remains reference-only (spine-oriented artifact/operator jump). It MUST NOT be re-documented as the public lexical retrieval surface, and it MUST NOT be aliased to `/v1/search`.
  - The dashboard's brute-force text search MUST be redescribed in docs as a temporary reference-only fallback, not as a public retrieval claim. Once the reference ships the extension, the dashboard SHOULD consume it.
  - `spec-data-query-api.md` MUST be updated to reflect that public lexical retrieval lives in this extension at `GET /v1/search`, not in hypothetical future `POST /v1/search`. The existing deferral wording must no longer imply silent core growth.
- **Explicit non-goals** for this tranche: no semantic/vector retrieval, no embeddings/versioning, no cross-connector entity resolution, no generic predicate/boolean DSL, no connector-specific search params, no mandatory-core promotion, no new dashboard-only ad hoc search layer, no `POST /v1/search` body-DSL, no portable numeric relevance score, no overloading of `/_ref/search` as public.

## Capabilities

### New Capabilities
- `lexical-retrieval-extension`: defines an optional, discoverable, grant-safe, lexical-only retrieval surface at `GET /v1/search` with stream-level searchable-field declarations and a small server-level discovery layer.

### Modified Capabilities
- *(none)*. This is intentionally introduced as a new optional capability rather than as a modification of `reference-implementation-architecture`. Promotion to core or absorption into an existing capability is a separate future decision per `design-notes/lexical-retrieval-status-options-2026-04-23.md`.

## Impact

- `openspec/specs/lexical-retrieval-extension/spec.md` (new, on archival)
- `apps/web/content/docs/spec-data-query-api.md` (truthfulness edits: remove or rewrite the "richer cross-stream search via `POST /v1/search`" deferral wording; point public lexical retrieval at the new extension)
- `apps/web/content/docs/` (new or cross-referenced extension doc describing `GET /v1/search`, stream-level `query.search.lexical_fields`, and the server-level discovery surface)
- `reference-implementation/` (future implementation tranche): build the extension as a first-class public surface over SQLite FTS5, keep `/_ref/search` distinct, retire the dashboard brute-force fan-out in favor of the extension
- Any existing `/_ref/search` docs that overclaim public portability (fix wording; do not widen scope)

## Deferred / Follow-ups

These are intentionally excluded from this change. They are listed so future tranches can pick them up without having to rediscover the shape:

- `POST /v1/search` with a body-DSL for richer queries (only if usage proves the v1 surface too narrow).
- Portable numeric relevance score (requires a stable definition).
- Promotion to core PDPP (requires stabilized ecosystem evidence per the surface-status ladder).
- Semantic/vector retrieval as a separate future capability or reference-first experiment.
- Nested paths, arrays, or blob indexing in `lexical_fields`.
- Connector-specific ranking/tokenization hints as portable contract.
