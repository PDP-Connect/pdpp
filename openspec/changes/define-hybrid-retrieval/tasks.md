## 1. Contract

- [x] Add reference-contract schema for hybrid retrieval capability metadata.
- [x] Add reference-contract schema for `GET /v1/search/hybrid`.
- [x] Decide first-tranche pagination: snapshot cursor or no cursor support.
      _Decision: no cursor support in v1. The endpoint rejects the `cursor`
      parameter with `invalid_request` and the advertisement carries
      `cursor_supported: false`. Clients that need paging beyond `limit`
      fall back to the individual `/v1/search` and `/v1/search/semantic`
      endpoints, each of which has a snapshot-honest cursor of its own._

## 2. Implementation

- [x] Advertise `capabilities.hybrid_retrieval` only when lexical and semantic retrieval are both available.
- [x] Implement `GET /v1/search/hybrid` by composing existing lexical and semantic planners.
- [x] Deduplicate by `(connector_id, stream, record_key)`.
- [x] Return source provenance and per-source score objects.
- [x] Preserve the existing lexical and semantic endpoint behavior unchanged.

## 3. Tests

- [x] Metadata advertisement tests.
- [x] Happy-path owner-token hybrid search across at least two streams.
- [x] Client-token grant projection test.
- [x] Dedup test for record matching both sources.
- [x] Lexical-only and semantic-only provenance tests.
- [x] Cursor behavior test matching the chosen pagination design.
- [x] Cross-surface cursor rejection tests.

## 4. Dashboard Follow-Up

- [ ] If the endpoint is implemented, update dashboard search to prefer hybrid retrieval when advertised.
- [ ] Preserve graceful fallback to existing client-side lexical+semantic blend when not advertised.

_Deferred per task-packet scope: the dashboard should only be touched once the API is green and the change is very small. The blend already works client-side and the advertisement is fail-closed._

## 5. Validation

- [x] Run lexical and semantic retrieval suites.
- [x] Run `pnpm --filter @pdpp/reference-contract run check:generated`.
- [x] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `pnpm --dir apps/web run types:check` if dashboard changes.
      _N/A — no dashboard changes in this tranche._
- [x] Run `openspec validate define-hybrid-retrieval --strict`.
- [x] Run `openspec validate --all --strict`.
