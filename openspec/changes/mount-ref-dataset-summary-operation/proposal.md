## Why

The `define-reference-operation-environments` proof sequence has landed `rs.streams.list`, `rs.streams.detail`, `rs.schema.get`, `rs.records.list`, `rs.records.get`, and `rs.search.lexical` as canonical operation capsules mounted from both the native Fastify host and the Next sandbox host. The reference-only `/_ref/dataset/summary` operator-console surface is still maintained as three parallel implementations: the native route calls `getDatasetSummary` in `server/records.js` (live SQLite aggregates), the sandbox route imports a website-local `buildLiveDatasetSummary` builder from `_demo/builders.ts` (in-memory aggregates over `DEMO_*` fixtures), and the sandbox dashboard data source (`apps/web/src/app/sandbox/_demo/data-source.ts#getDatasetSummary`) constructs its own live-shaped envelope by mapping the demo-shaped `buildDatasetSummary()` into the live shape. The dashboard mapping is already drifting in observable ways: `record_json_bytes` is sourced from the demo `blob_bytes`, and `earliest_ingested_at` / `latest_ingested_at` are sourced from real-world record-time fields rather than substrate ingest-time fields. That is the same drift class the architecture work is meant to remove — even though `/_ref/dataset/summary` is reference-operator surface and not PDPP protocol.

Mounting `ref.dataset.summary` as a canonical operation lets one capsule own the response envelope (`object`, byte fields, time bounds, `top_connectors` sorting and limit) while environment-specific dependencies provide the raw aggregate inputs. This narrows the sandbox builder surface, removes a parallel envelope writer, and keeps the operator-diagnostic semantics described in `define-reference-operation-environments` contract correction (4) — `record_json_bytes` remains adapter-native operator data, not a PDPP-stable metric — without promoting the surface into PDPP protocol.

## What Changes

- Introduce a canonical `ref.dataset.summary` operation implementation that owns the host-independent slice of dataset-summary behavior: envelope assembly (`object: 'dataset_summary'`), `total_retained_bytes` derivation, top-connector sorting and limit, conditional ingest-time bounds (returned only when `record_count > 0`), and the live JSON shape consumed today by the operator console hero band.
- Mount the operation from the native Fastify reference server (`GET /_ref/dataset/summary`) by splitting `getDatasetSummary` into the smaller capability functions the operation consumes (`getCounts`, `getRetainedBytes`, `getRecordTimeBounds`, `getIngestedTimeBounds`, `listTopConnectorCandidates`).
- Mount the same operation from the Next sandbox `/sandbox/_ref/dataset/summary` route with sandbox fixture dependencies, and stop the route from importing `buildLiveDatasetSummary`.
- Mount the same operation from the sandbox dashboard data source (`sandboxDashboardDataSource.getDatasetSummary` in `apps/web/src/app/sandbox/_demo/data-source.ts`) so the dashboard surface returns exactly the canonical envelope and stops mapping the demo-shaped `buildDatasetSummary()` into a parallel live shape. This removes the `record_json_bytes` and `*_ingested_at` drift the local mapping introduced.
- Add sandbox fixture dependencies to `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` so the sandbox route and dashboard data source resolve dataset-summary capabilities through the same dependency shape the operation requires.
- Delete `buildLiveDatasetSummary` (and its `LiveDatasetSummary` type) from `apps/web/src/app/sandbox/_demo/builders.ts` so the public sandbox route cannot import a parallel envelope writer.
- Extend boundary tests so the new operation module is gated by the shared operation boundary helper and the sandbox route cannot reimport the deleted builder.
- Do not promote `/_ref/dataset/summary` into PDPP protocol semantics. The operation remains reference/operator surface. `record_json_bytes` semantics remain adapter-native operator diagnostic data, consistent with `define-reference-operation-environments` contract correction (4).

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: `ref.dataset.summary` becomes operation-owned, joining the canonical operation set. The reference operator-console dataset-summary surface SHALL be served by the canonical operation rather than two host-local envelope writers.
- `reference-web-bridge-contract`: `/sandbox/_ref/dataset/summary` SHALL mount the canonical `ref.dataset.summary` operation through the sandbox fixture environment instead of constructing the live-shaped dataset summary through a website-local builder.

## Impact

- Affected code: `reference-implementation/operations/ref-dataset-summary/**`, `reference-implementation/server/records.js` (split `getDatasetSummary` into capability inputs; native helpers stay), `reference-implementation/server/index.js` (`GET /_ref/dataset/summary` route only), `apps/web/src/app/sandbox/ref/dataset/summary/route.ts`, `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`, `apps/web/src/app/sandbox/_demo/data-source.ts` (dashboard data source mounts the operation), `apps/web/src/app/sandbox/_demo/builders.ts`, `reference-implementation/package.json` (operation export), and tests.
- No public envelope shape change for the route: `/_ref/dataset/summary` and `/sandbox/_ref/dataset/summary` continue to return their existing JSON envelopes. `object`, `connector_count`, `stream_count`, `record_count`, `record_json_bytes`, `record_changes_json_bytes`, `blob_bytes`, `total_retained_bytes`, `earliest_record_time`, `latest_record_time`, `earliest_ingested_at`, `latest_ingested_at`, and `top_connectors` (each `dataset_connector_summary`) are preserved bit-for-bit.
- The sandbox dashboard data source surface DOES change in the drift-fix direction: previously the local mapping returned `record_json_bytes = built.blob_bytes` and `earliest_ingested_at / latest_ingested_at = built.earliest_record_time / latest_record_time`. After this change the dashboard surface returns the canonical envelope, so `record_json_bytes` is the actual record-JSON byte sum (`DEMO_RECORDS.reduce(...)` for sandbox; SQLite aggregate for native) and the `*_ingested_at` fields come from substrate ingest-time bounds rather than record-time bounds. This intentionally corrects the drift; views that relied on the previous mapping would have been reading wrong data.
- No production storage abstraction is extracted, no Postgres adapter is introduced, no new PDPP protocol surface is added, and no other `_ref/**` route is migrated in this slice.
