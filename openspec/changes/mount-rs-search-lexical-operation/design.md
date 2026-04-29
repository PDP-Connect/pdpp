## Context

`define-reference-operation-environments` established that AS/RS behavior should live behind canonical operation capsules and that hosts (Fastify, Next sandbox, tests) should adapt requests and supply environment dependencies. The streams/schema/records-read proofs landed that pattern. Lexical search is the next slice in the sequence and is explicitly called out in the parent design (Decisions §1 lists `rs.search.lexical` as a canonical operation; Contract Corrections §5 says lexical retrieval feasibility depends on `LexicalIndex` exposing backend identity and on candidate-record narrowing happening in operation-layer composition with `RecordStore`, not inside the index).

The current state of the two routes:

- Native Fastify `GET /v1/search` is already a thin route that delegates to `runLexicalSearch` in `server/search.js`. `runLexicalSearch` already accepts most resolution behaviors as injected functions (`resolveOwnerVisibleConnectorIds`, `resolveOwnerScopeForConnector`, `resolveOwnerManifestFromScope`, `buildOwnerReadGrantForManifest`, `resolveGrantManifest`), but the public-contract slice (param allowlist, advertisement gate, mode planning, cursor format, slice math, envelope shape, disclosure data) is mixed with FTS5/snapshot helpers in the same module. Hosts other than the Fastify route cannot mount the public-contract slice without dragging the SQLite-bound helpers along.
- Sandbox `/sandbox/v1/search` imports `buildLiveSearchResponse` from `apps/web/src/app/sandbox/_demo/builders.ts` — a website-local AS/RS builder whose shape was hand-aligned with the live envelope. That is the same drift class operation extraction is meant to remove.

This change does not rewrite `server/search.js` broadly. It extracts the public-contract slice from `runLexicalSearch` into an operation capsule and reduces `runLexicalSearch` to a thin native dependency wiring around the existing FTS5/snapshot helpers.

## Goals / Non-Goals

**Goals:**

- Define a canonical `rs.search.lexical` operation module whose semantics are independent of HTTP framework, sandbox UI, concrete database driver, and `process.env`.
- Mount the operation from the native Fastify reference server and from the Next sandbox route.
- Preserve `/v1/search` response shape, error codes, cursor semantics, scoring semantics, grant filtering, stream/filter query semantics, and disclosure-spine shape exactly.
- Preserve `/sandbox/v1/search` response shape exactly. Demote `buildLiveSearchResponse` to a fixture-only dependency that the public route cannot statically import.
- Move sandbox lexical-search fixture wiring into `_demo/operations-fixtures.ts` so the route handler is a thin host adapter.

**Non-Goals:**

- Do not extract a production `LexicalIndex` interface. The operation accepts capability-shaped dependencies that wrap the existing `buildSearchPlanForGrant` / snapshot helpers from `server/search.js`.
- Do not change cursor opacity, score advertisement, score-direction semantics, snippet shape, grant filtering, request allowlist, or `filter[...]` coupling to `streams[]`.
- Do not introduce Postgres, Kysely, or a generic `SearchProvider`.
- Do not touch semantic search, hybrid search, attachment blobs, runs, traces, or `_ref` routes.
- Do not refactor `server/search.js` outside the `runLexicalSearch` shell.

## Decisions

### 1. The operation owns the host-independent public-contract slice

The operation owns:

- strict v1 query-param allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`); rejects unknown keys with `invalid_request` and `param: <key>`;
- `q` non-empty required → `invalid_request` with `param: 'q'`. This applies to every host that mounts the operation, including the sandbox API route (see §6);
- `limit` clamp (default 25, min 1, max 100);
- `streams[]` normalization (string or array, trim, drop empty, return null when empty);
- `filter[...]` requires exactly one `streams[]` value → `invalid_request` with `param: 'streams'`;
- cross-stream advertisement gate: when capability metadata says `cross_stream: false`, `streams[]` is required;
- mode classification (`owner` vs `client`) from the actor;
- client-mode `streams[] ⊆ grant.streams` enforcement → `grant_stream_not_allowed` for any disallowed stream;
- owner-mode soft `streams[]` filter (no error on unknown stream);
- cursor encode/decode (base64url JSON `{snap, off}`); malformed or expired → `invalid_cursor`;
- snapshot orchestration: on a fresh request, build a snapshot via the dependency, persist it, slice the first page; on a cursor request, load the snapshot via the dependency, slice from the cursor offset; produce `next_cursor` when more results exist;
- score-advertisement gate: emit per-result `score` only when capability metadata advertises `score.supported: true` with `kind: 'bm25'` and `order: 'lower_is_better'`;
- `search_result` shape (`object`, `stream`, `record_key`, `connector_id`, `record_url`, `emitted_at`, `matched_fields`, `snippet?`, `score?`); `record_url` is delegated to the host through a `formatRecordUrl({stream, recordKey, connectorId, isOwner})` capability;
- list-envelope shape (`object: 'list'`, `has_more`, `next_cursor?`, `data: []`) — the host adds the host-shaped `url` field;
- `disclosure.served` data block (`query_shape: 'search'`, `record_count`, `has_more`, `mode`, `connector_count`).

Storage- and adapter-bound concerns stay behind dependencies:

- `getLexicalAdvertisement()` → capability metadata (controls cross-stream and score gates);
- `listOwnerVisibleConnectorIds()` → connector ids for owner fan-out;
- `resolveOwnerManifestForConnector(connectorId)` → manifest or null (null = skip this connector);
- `buildOwnerReadGrantForManifest(manifest)` → synthetic owner read grant;
- `resolveGrantManifest(actor)` → manifest the client grant resolves against;
- `buildSearchPlanForGrant({manifest, grant, streamsFilter, filter, filteredStream, connectorId})` → plan entries for one connector (this is the `LexicalIndex`-shaped capability — backend-owned);
- `buildSnapshot({q, perConnectorPlans, isOwner})` → `{snapshot_id, results}` (FTS5/ranking lives here);
- `persistSnapshot(snapshot)` / `loadSnapshot(snapshotId)` → snapshot store; `loadSnapshot` returns null on expired/missing;
- `formatRecordUrl({stream, recordKey, connectorId, isOwner})` → string.

The native route wires these against `server/search.js` helpers (existing FTS5/SQLite paths). The sandbox route wires them against fixture helpers in `_demo/operations-fixtures.ts` that scan `DEMO_RECORDS` and keep snapshots in memory.

### 2. Hosts still own auth, instrumentation, and response writing

The host adapters retain:

- token authentication (`requireToken`);
- request id / trace id assignment;
- `query.received` / `disclosure.served` event emission and `rejectQuery` error mapping;
- response writing (Fastify `res.json` / Next `Response`);
- the host-shaped `url` envelope field (`/v1/search` vs `/sandbox/v1/search`);
- sandbox demo headers and 404 envelope shape.

Operation-thrown errors carry `code` (`invalid_request`, `invalid_cursor`, `grant_stream_not_allowed`) and may carry `param` so host adapters can map them through their existing error envelopes (`rejectQuery`, `handleError`) without re-deriving the rules.

### 3. Sandbox fixture dependencies live in `_demo/operations-fixtures.ts`

Following the existing pattern. The fixture module exposes `createSandboxSearchLexicalDependencies` which returns an operation-shaped dependency object backed by `DEMO_RECORDS` substring matching, an in-memory `Map` snapshot cache keyed by snapshot id, and the existing demo capability advertisement.

`buildLiveSearchResponse` is demoted to a fixture-only helper (or its matching logic is inlined into the fixture factory) and the public route SHALL NOT statically import it. A boundary test enforces this.

### 4. The operation module MUST NOT import host or storage concretes

Same boundary as the existing operations: no Fastify, Next, SQLite, Postgres, raw DB modules, sandbox UI, `server/search.js`, or `process` / `process.env`. The shared `operation-boundary.js` gate enumerates the operations directory and enforces the rule for every operation, including the new one.

### 5. Public response shape is preserved

The change is structural, not behavioral. Native `/v1/search` and sandbox `/sandbox/v1/search` JSON envelopes MUST remain byte-equivalent. Existing `lexical-retrieval.test.js` and sandbox `routes.test.ts` cases are the regression baseline.

### 6. Sandbox API obeys the canonical request contract; UI owns empty-state rendering

Owner decision (`tmp/workstreams/mount-rs-search-lexical-operation-owner-guidance-1.md`): `/sandbox/v1/search` is an API surface claiming to be the mock-backed RS, and it MUST mount the same `rs.search.lexical` operation and obey the same request contract as native `/v1/search`. Empty/missing `q` MUST return the canonical `invalid_request` error envelope, not an empty list. The previous route-level "empty `q` → empty list" short-circuit was exactly the kind of sandbox AS/RS fork this slice is meant to delete; reintroducing it as host policy would defeat the change.

The dashboard search UI / `_demo/data-source.ts` MAY render an empty result state without calling the API when the user has not typed a query — that is UI behavior, not API contract behavior — but it is out of scope for this change. The existing sandbox `routes.test.ts` case that asserted "empty `q` → empty list" is updated to assert the canonical `invalid_request` shape; if a UI-level empty-state needs coverage, it belongs in a separate dashboard/data-source test.

## Risks / Trade-offs

- **Operation grows too broad.** Mitigation: the boundary above is the cap. Storage, ranking, snapshot bytes, and FTS5 syntax stay in the dependency.
- **Native instrumentation regresses.** Mitigation: the host retains ownership of `query.received`, `disclosure.served`, and `rejectQuery`. The operation only populates the data block fields.
- **Sandbox response accidentally diverges.** Mitigation: existing `routes.test.ts` cases are the compatibility gate; the fixture dependency mirrors the previous builder behavior. The sandbox host adapter preserves the empty-`q` short-circuit.
- **Cursor semantics change.** Mitigation: the operation owns `encodeSearchCursor` / `decodeSearchCursor` (base64url JSON `{snap, off}`) by lifting them out of `server/search.js`. The native side calls the operation's encoder; the sandbox fixture uses the operation's encoder too. Cursor is not interchangeable with record-list cursors (existing `lexical-retrieval.test.js` test asserts this; preserved).
- **Score advertisement misfires.** Mitigation: the score gate is a pure function of `getLexicalAdvertisement()`. The native dependency returns the same advertisement helper that lived in `server/search.js`; the sandbox fixture returns the existing demo advertisement.
- **Worker invents architecture vocabulary.** Mitigation: names mirror existing operations (`executeSearchLexical`, `SearchLexicalDependencies`, `SearchLexicalRequestError`).

## Migration Plan

1. Add the operation module and reference-implementation `package.json` export.
2. Add native dependency wiring inside `server/search.js`'s `runLexicalSearch`. Keep the existing helper signature (`runLexicalSearch({req, opts, tokenInfo, ...})`) so the route does not change call shape; internally, `runLexicalSearch` builds a `SearchLexicalDependencies` object from the existing helpers and calls `executeSearchLexical`. The native route stays thin.
3. Add `createSandboxSearchLexicalDependencies` in `_demo/operations-fixtures.ts`. Switch `/sandbox/v1/search/route.ts` to call `executeSearchLexical` directly with these dependencies. Demote `buildLiveSearchResponse` to a fixture-only helper or inline its matching logic.
4. Add operation-level tests, boundary tests (shared gate plus per-operation builder-import demotion), and rerun targeted validation.

Rollback: the operation module is additive until the route adapters are switched. If a regression is found before merge, revert the route adapter changes and the builders demotion.

## Open Questions

- Whether the native `runLexicalSearch` shell should be deleted entirely once the route mounts the operation directly. Decision: keep `runLexicalSearch` as the native dependency-wiring helper inside `server/search.js`. It currently composes `resolveGrantManifest`, `buildOwnerReadGrantForManifest`, `resolveOwnerManifestFromScope`, the FTS5 `buildSnapshot`, and `persistSnapshot`/`loadSnapshot` against the live SQLite store; lifting that wiring up into the route handler would re-introduce the same drift surface this slice is removing. Inside `runLexicalSearch`, the public-contract slice now delegates to `executeSearchLexical`.
- Whether sandbox lexical search should also expose `record_count` / `mode` / `connector_count` disclosure data even though it does not emit spine events. Decision: the operation always populates the disclosure data block; the sandbox host discards it because no spine is wired. This keeps a single operation output shape across hosts.
