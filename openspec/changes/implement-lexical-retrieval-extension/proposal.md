## Why

The `add-lexical-retrieval-extension` change is approved as canonical design and spec. The public contract (extension status, `GET /v1/search`, stream-level `query.search.lexical_fields`, RS metadata advertisement, grant-safe semantics, opaque-cursor pagination, no portable numeric score) is locked.

That change deliberately does not implement code — only the contract. This change implements that contract in the reference and removes the truthfulness drift the design called out:

- The reference does not yet ship a public `/v1/search` surface; agents and the dashboard fall back to brute-force fan-out (`apps/web/src/app/dashboard/search/page.tsx`'s `searchRecords()` JSON-stringifies every record it fetches and substring-matches in JS).
- The reference does not yet advertise a `capabilities.lexical_retrieval` block on its RFC 9728 protected-resource metadata document.
- Stream metadata responses pass `mStream.query` straight through (`reference-implementation/server/index.js` line ~2014), so `query.search.lexical_fields` is already plumbed end-to-end *if* a manifest declares it — but no manifest does, and no validator constrains the shape.
- `apps/web/content/docs/spec-data-query-api.md` still defers public lexical retrieval to a hypothetical `POST /v1/search`. That sentence is now stale and needs to point at the new extension.
- `/_ref/search` today is spine-only (traces/grants/runs jump). It does not currently overclaim public retrieval, but its reference-only status should be noted in code comments now that a public sibling exists at `/v1/search`.

This change makes the approved contract real in the reference, satisfies all spec scenarios with executable tests, and leaves the repo more truthful than it found it.

## What Changes

- Add stream-level `query.search.lexical_fields` declaration to a representative subset of seed manifests (Reddit `posts.title`, `posts.selftext`, `comments.body`, `comments.post_title`) so the contract is exercised end-to-end. Other manifests stay non-participating — that itself proves the "stream MAY participate" branch.
- Tighten `validateConnectorManifest()` in `reference-implementation/server/auth.js` so `query.search.lexical_fields`, when present:
  - is a non-empty array of strings
  - references only top-level fields declared in the stream's `schema.properties`
  - references only string-typed schema entries
  - rejects nested paths, arrays, and blob references
  - rejects unknown fields
- Add `capabilities.lexical_retrieval` to `buildProtectedResourceMetadata()` in `reference-implementation/server/metadata.js` with the six required keys (`supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, `max_limit`) when the reference exposes the extension.
- Implement `GET /v1/search` in `reference-implementation/server/index.js`:
  - allow only `q`, `limit`, `cursor`, `streams[]`; reject every other parameter (including the now-explicitly-rejected `connector_id`) with `invalid_request_error` and identify the rejected parameter
  - resolve grant + manifest using the same path the existing record-listing handler uses
  - for owner-token callers, search across every owner-visible connector on this RS (no public `connector_id` param); for client-token callers, scope by the grant
  - hard-error with `permission_error` / `grant_stream_not_allowed` on `streams[]` entries the caller is not authorized to read
  - search only over `(stream, field)` pairs in (declared `lexical_fields`) ∩ (grant-readable fields); silently drop streams whose intersection is empty
  - return `search_result` candidates with required `stream`, `record_key`, `emitted_at`, `connector_id`, `matched_fields`; include `record_url` for the canonical single-record read (with the owner-mode `connector_id` query parameter when the caller is an owner-token caller); include grant-safe `snippet` when a match exists
  - opaque cursor pagination distinct from record-list and `changes_since`; cursor encodes a frozen result snapshot for the session
  - emit a `disclosure.served` spine event with `query_shape: 'search'` so search disclosures are auditable on the same spine as record reads
- Add a new internal helper `searchRecordsLexical(storageTarget, manifest, grant, params)` in a new file `reference-implementation/server/search.js` that the route handler delegates to and that `apps/web` can also call through a server-rendered bridge. The helper goes through the same enforcement path the route does — there is no second contract.
- Build the v1 search backing as a SQLite FTS5 virtual table populated from records of streams that declare `lexical_fields`. Maintain via insert/update/delete triggers; rebuild on startup if the index is missing or out of sync. Index only declared `lexical_fields`. The index is a derived artifact: removing the records removes the index entries.
- Replace the dashboard's brute-force `searchRecords()` in `apps/web/src/app/dashboard/search/page.tsx` with a call into a new `searchRecords()` helper in `apps/web/src/lib/reference-bridge.ts` that proxies to `GET /v1/search`. Drop `recordMatches`, `extractSnippet`, and per-stream fan-out.
- Update `apps/web/content/docs/spec-data-query-api.md`: rewrite the "richer cross-stream search could be added later via `POST /v1/search`" sentence to direct readers to the lexical retrieval extension at `GET /v1/search`. Reserve `POST /v1/search` only as a possible future DSL surface, marked not-yet-spec'd.
- Add an `apps/web/content/docs/spec-lexical-retrieval-extension.md` page that documents the extension at the same depth as `spec-data-query-api.md`: endpoint, params, result shape, advertisement shape, stream declaration shape, grant-safety invariants, pagination, and non-goals. Cross-link from the docs index.
- Add a `// Reference-only.` comment band above `app.get('/_ref/search', …)` in `index.js` so future readers cannot mistake it for the public extension surface, and so the separation from `/v1/search` is visible in code.
- Tests in `reference-implementation/test/lexical-retrieval.test.js` covering every scenario in the approved spec plus `record_url` optionality and `/v1/search` ↔ `/_ref/search` separation.

Explicitly **not in this change**:

- No widening into semantic/vector retrieval, embeddings, or a body-DSL `POST /v1/search`.
- No portable numeric relevance score.
- No connector-specific search semantics.
- No new broad capability document.
- No mutation of the approved `add-lexical-retrieval-extension` design (proposal/design/tasks/spec delta) — this change only consumes it.
- No unrelated cleanup elsewhere in the repo.

## Capabilities

### New Capabilities

*(none)*. The public contract capability `lexical-retrieval` is owned by the prior `add-lexical-retrieval-extension` change. This change does not redefine it.

### Modified Capabilities

- `reference-implementation-architecture`: add reference-implementation-scoped requirements describing how the reference realizes the lexical-retrieval extension — RS metadata advertisement publication, stream-level `lexical_fields` validation in the reference's manifest validator, internal helper that the public route and the dashboard share, FTS5-backed reference index, and explicit separation from `/_ref/search`. None of these requirements re-state the public contract; they constrain how the reference itself implements it.

## Impact

- `reference-implementation/server/auth.js` — extend `validateConnectorManifest()` for `query.search.lexical_fields`
- `reference-implementation/server/metadata.js` — add `capabilities.lexical_retrieval` to `buildProtectedResourceMetadata()`
- `reference-implementation/server/index.js` — wire RS metadata params, register `GET /v1/search`, add `// Reference-only.` comment above `/_ref/search`
- `reference-implementation/server/search.js` (new) — `searchRecordsLexical()` helper + FTS5 backing logic
- `reference-implementation/server/db.js` — add the FTS5 schema + triggers (additive; no change to existing tables)
- `reference-implementation/manifests/reddit.json` — add `query.search.lexical_fields` to `posts` and `comments`
- `reference-implementation/test/lexical-retrieval.test.js` (new) — full scenario coverage
- `apps/web/src/lib/reference-bridge.ts` (or equivalent) — add `searchRecords()` proxy to `/v1/search`
- `apps/web/src/app/dashboard/search/page.tsx` — drop brute-force fan-out; call the new bridge helper
- `apps/web/content/docs/spec-data-query-api.md` — fix the `POST /v1/search` deferral wording
- `apps/web/content/docs/spec-lexical-retrieval-extension.md` (new) — extension reference doc
- `openspec/specs/reference-implementation-architecture/spec.md` — folded in on archival

## Coordination note

A separate agent is mid-flight on `swap-sqlite-driver` (`@databases/sqlite` → `better-sqlite3`). This change touches `reference-implementation/server/db.js` only to add the FTS5 schema — additive, no driver-API mutation. Implementation is done in the `implement-lexical-retrieval-extension` worktree off `7aa10d4` so the two streams stay isolated until merge.
