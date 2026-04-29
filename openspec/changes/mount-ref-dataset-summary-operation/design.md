## Context

`define-reference-operation-environments` established that AS/RS behavior should live behind canonical operation capsules and that hosts (Fastify, Next sandbox, tests) should adapt requests and supply environment dependencies. The proof sequence has now landed `rs.streams.list`, `rs.streams.detail`, `rs.schema.get`, `rs.records.list`, `rs.records.get`, and `rs.search.lexical`. The reference-only `/_ref/dataset/summary` operator-console surface is a smaller but structurally identical instance of the drift pattern: native and sandbox each maintain their own envelope assembly, and the sandbox imports a website-local builder.

The current state of the two routes:

- Native Fastify `GET /_ref/dataset/summary` (server/index.js around the route defined for `contract: 'refDatasetSummary'`) calls `getDatasetSummary()` from `server/records.js`. That helper runs three SQLite aggregates (records aggregate with counts and bytes, record_changes bytes, blob bytes), conditionally invokes `getRealWorldTimeBounds()`, calls `getTopConnectorsByRecordCount(3)`, and assembles the entire envelope inline.
- Sandbox `/sandbox/_ref/dataset/summary` imports `buildLiveDatasetSummary` from `apps/web/src/app/sandbox/_demo/builders.ts`, which builds the same envelope from `DEMO_RECORDS` / `DEMO_STREAMS` / `DEMO_CONNECTORS`.

This is exactly the drift class operation extraction is meant to remove. The semantics are reference/operator-only (not PDPP), but the architectural shape is identical to the rs.* mounts.

## Goals / Non-Goals

**Goals:**

- Define a canonical `ref.dataset.summary` operation whose semantics are independent of HTTP framework, sandbox UI, concrete database driver, sandbox modules, and `process` / `process.env`.
- Mount the operation from the native Fastify reference server and from the Next sandbox route.
- Add sandbox fixture dependencies under `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`.
- Delete `buildLiveDatasetSummary` (and its exported type) so the public sandbox route cannot import a parallel envelope writer.
- Preserve the existing public JSON envelope for both native and sandbox dataset-summary routes byte-for-byte.

**Non-Goals:**

- Do not promote `/_ref/dataset/summary` into PDPP protocol semantics. It remains reference/operator surface.
- Do not relabel `record_json_bytes` semantics in this slice. Per `define-reference-operation-environments` contract correction (4), the field stays a legacy SQLite-native operator diagnostic; relabeling waits for a future `_ref/dataset/summary` contract change. Operation prose explicitly preserves that constraint.
- Do not extract a production `RecordStore`, `BlobStore`, or any other storage abstraction. The operation accepts capability-shaped dependency functions that wrap existing native helpers.
- Do not migrate any other `_ref/**` route (connectors, approvals, runs, traces, grants, dashboard, semantic search, etc.) in this slice.
- Do not touch owner authentication. Owner auth and response writing remain on the native route.

## Decisions

### 1. Operation owns envelope assembly; capabilities own raw data

The operation owns the host-independent slice of behavior:

- envelope shape: `object: 'dataset_summary'`, every field name above, key ordering as currently emitted;
- `total_retained_bytes` derivation: `record_json_bytes + record_changes_json_bytes + blob_bytes`;
- top-connector sorting and limit (limit 3, sort by `record_count` descending, tiebreak by `connector_id` ascending) — preserving today's behavior;
- conditional emit rule: `earliest_ingested_at` / `latest_ingested_at` / `earliest_record_time` / `latest_record_time` are returned as `null` when `record_count === 0`. This matches the current native helper (which short-circuits both real-world and ingest bounds on `recordCount > 0`) and the current sandbox builder (which uses sorted record arrays). Empty-corpus collapse is operation-owned so both hosts cannot drift.
- `dataset_connector_summary` envelope wrapping for each top-connector entry. Dependencies return `{connector_id, record_count}` candidates; the operation adds `object: 'dataset_connector_summary'`.

Storage- and adapter-bound concerns stay behind dependencies:

- `getCounts(): {connector_count, stream_count, record_count}` — distinct `(connector_id, stream)` observations in live records (per current native semantics). Sandbox returns `DEMO_*.length`.
- `getRetainedBytes(): {record_json_bytes, record_changes_json_bytes, blob_bytes}` — three byte concepts kept separately labeled per the existing native docstring. Sandbox returns approximate-bytes for record JSON and `0` for the others (matching today's builder).
- `getRecordTimeBounds(): {earliest, latest}` — real-world record-time bounds computed from manifest-declared `consent_time_field`s on the native side; sorted-array min/max on the sandbox side. Operation never coerces shape.
- `getIngestedTimeBounds(): {earliest, latest}` — substrate ingest-time bounds (`emitted_at`). Native pulls these from the records aggregate; sandbox uses sorted-array min/max.
- `listTopConnectorCandidates(): Array<{connector_id, record_count}>` — connector candidates for the top-N envelope slot. Dependencies may return them already sorted (native) or unsorted (sandbox); the operation owns the sort and limit so both hosts agree.

The operation calls each dependency once per execution and assembles the envelope from the results. Dependencies are async-friendly (`Promise<T> | T`).

### 2. Hosts still own auth and response writing

The host adapters retain:

- owner session authentication (`ownerAuth.requireOwnerSession` on native; sandbox demo headers on sandbox);
- response writing (Fastify `res.json` / Next `Response`);
- error handling (`handleError`);
- whether to call the operation at all (route mounting).

The operation has no notion of HTTP, headers, sessions, or owner auth. It returns the envelope; hosts decide how to send it.

### 3. Native dependencies are extracted from `getDatasetSummary`

The native `getDatasetSummary` helper currently bundles capability calls and envelope assembly in one function. Per the task packet's "Suggested implementation" guidance, a pure pass-through to `getDatasetSummary()` is not enough — the operation must own the envelope semantics, which means the native side must split the helper.

The split:

- `getRecordsAggregate()`: returns the raw `recordCount`, `connectorCount`, `streamCount`, `recordJsonBytes`, `earliestIngestedAt`, `latestIngestedAt` from the existing `recordsDatasetGetRecordsAggregate` query.
- `getRecordChangesBytes()`: returns `record_changes_json_bytes` from the existing `recordsDatasetGetRecordChangesBytes` query.
- `getBlobBytes()`: returns `blob_bytes` from the existing `recordsDatasetGetBlobBytes` query.
- `getRealWorldTimeBounds()`: stays as today, called only when `recordCount > 0` (the operation owns the gate).
- `getTopConnectorsByRecordCount(limit)`: stays a small SQL helper; the operation owns the `dataset_connector_summary` envelope wrapping. To preserve today's exact native byte output, the helper is split into a candidate-listing query that returns `{connector_id, record_count}` records (already sorted by the underlying query); the operation owns the limit and the envelope.

`getDatasetSummary` is removed once the native route mounts the operation. The split helpers stay private to `server/records.js` and are imported by the route handler that wires them into the operation dependencies.

### 4. Sandbox fixture dependencies live in `_demo/operations-fixtures.ts`

Following the existing `rs.*` operation pattern. The sandbox fixture module exposes `createSandboxRefDatasetSummaryDependencies()` which reads `DEMO_CONNECTORS`, `DEMO_STREAMS`, and `DEMO_RECORDS` directly. The route handler is thin: call the operation with fixture deps, write the live-shaped response.

The sandbox fixture preserves today's `buildLiveDatasetSummary` semantics:

- counts come from `DEMO_*.length` (the previous sandbox semantics — they over-count vs. the native distinct `(connector_id, stream)` definition for streams, but the sandbox fixtures populate one stream per connector per fixture, so the values match today's emitted output exactly);
- record JSON bytes come from `DEMO_RECORDS.reduce((sum, r) => sum + JSON.stringify(r.fields).length, 0)`;
- `record_changes_json_bytes` and `blob_bytes` are `0` (sandbox has no record-changes table or blob storage);
- record-time bounds and ingested-time bounds come from sorted record arrays;
- top connectors come from `countConnectorRecords` Map → `[{connector_id, record_count}]` candidates; the operation does the sort and limit.

### 5. Operation module MUST NOT import host or storage concretes

Same boundary as the existing operations: no Fastify, Next, SQLite, Postgres, raw DB modules, sandbox UI, `server/records.js`, `server/index.js`, or `process` / `process.env`. The shared `operation-boundary.js` gate enumerates the operations directory and enforces the rule for every operation, including the new one.

### 6. Public envelope shape is preserved

The change is structural, not behavioral. Native and sandbox responses MUST remain byte-equivalent to today. Existing native server tests and the sandbox `routes.test.ts` dataset-summary case are the regression baselines.

### 7. `record_json_bytes` semantics remain adapter-native operator data

The operation's documentation and code comments preserve the constraint from `define-reference-operation-environments` contract correction (4): `record_json_bytes` is adapter-native storage bytes, not a PDPP-stable metric. The operation MUST NOT make the field look protocol-stable — it stays an operator-diagnostic field that happens to be exposed because the operator console hero band consumes it. Relabeling or namespacing waits for a future `_ref/dataset/summary` contract change.

## Risks / Trade-offs

- Operation grows too broad → keep the operation to envelope assembly, total derivation, and top-connector sort/limit. Reject any storage extraction in this slice.
- Native helpers double-up after the split → delete `getDatasetSummary` once the route mounts the operation, so there is exactly one envelope writer (the operation) and three thin SQL helpers (the dependencies).
- Sandbox output accidentally changes → the existing `routes.test.ts` dataset-summary case pins envelope keys and `dataset_connector_summary` shape. The fixture mirrors today's `buildLiveDatasetSummary` arithmetic.
- Native output accidentally changes → operation-level tests pin envelope assembly against fixture inputs that mirror today's native arithmetic; per-field equivalence is tested at the operation level.
- Worker invents architecture vocabulary → names mirror existing operations (`executeRefDatasetSummary`, `RefDatasetSummaryDependencies`, no visibility-error class because there is no host-independent rejection path on this surface).
- Operation accidentally promotes `/_ref/**` into PDPP protocol surface → operation prose, comments, and OpenSpec spec deltas explicitly call out that this is reference/operator surface and that `record_json_bytes` stays adapter-native operator data.

## Migration Plan

1. Add the operation module under `reference-implementation/operations/ref-dataset-summary/index.ts` and export from `reference-implementation/package.json`.
2. Split `getDatasetSummary` in `server/records.js` into `getRecordsAggregate` / `getRecordChangesBytes` / `getBlobBytes` / (existing) `getRealWorldTimeBounds` / new candidate-listing helper for top connectors, exporting the helpers the native route needs to wire dependencies.
3. Add sandbox fixture dependency factory to `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`.
4. Switch the native `GET /_ref/dataset/summary` route to mount the operation, preserving owner auth and response writing.
5. Switch the sandbox `/sandbox/_ref/dataset/summary` route to mount the operation with fixture deps.
6. Delete `buildLiveDatasetSummary` and its `LiveDatasetSummary` type from `_demo/builders.ts`.
7. Add operation tests, boundary tests, and run validation.

Rollback: the operation module is additive until routes are switched. If a regression is found before merge, revert the route handlers and the builders deletion.

## Open Questions

- Whether the operation should also own `record_json_bytes` relabeling (e.g. into `adapter_native_record_bytes`). Decision: out of scope for this slice; relabeling is a contract change, not an operation-mount change.
- Whether the operation should validate `top_connectors` `limit` as an input parameter. Decision: keep limit a fixed `3` to match today's hard-coded behavior; operations gain configurability when an actual caller needs it.
