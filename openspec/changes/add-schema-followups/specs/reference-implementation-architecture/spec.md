## ADDED Requirements

### Requirement: A reusable reconciliation primitive SHALL be available for manifest-vs-schema-vs-emit drift checks
The polyfill-connectors package SHALL provide a pure-function reconciler (`reconcile`, `parseManifestStreams`, `parseSchemaStreams`, `scanEmittedStreams`, and `reconcileFromDisk` in `src/manifest-reconcile.ts`) that compares declared streams (manifest), registered streams (schema registry keys), and emit-site stream-name literals (static-scanned from connector source).

The reconciler SHALL flag three drift classes:
1. `missing_manifest` — emitted but not declared in the manifest. Public-contract gap.
2. `missing_schema` — emitted but not registered in the connector's `SCHEMAS`. Runtime-validation gap.
3. `missing_emit` — declared in the manifest but neither registered in `SCHEMAS` nor literal-emitted. Public-contract overclaim with no fulfillment path.

A connector SHALL be considered aligned (`ok: true`) when all three drift arrays are empty. Declared and registered but not literal-emitted is acceptable: the schema registration is treated as the contract that the connector can populate the stream, and the emit-scan is a heuristic that may miss dynamic emits.

#### Scenario: A connector starts emitting a new stream
- **WHEN** an emit literal `emitRecord("new_stream", ...)` is added to a connector's source
- **THEN** running the reconciler SHALL flag `missing_manifest` and `missing_schema` until both are added
- **AND** the regression-test in `bin/reconcile-manifests.test.ts` SHALL fail

### Requirement: A regression test SHALL run reconciliation against every schema-bearing connector
A test under `bin/reconcile-manifests.test.ts` SHALL iterate every connector that ships a `schemas.ts` and assert the reconciler reports `ok: true`. The test SHALL fail with the drift detail (missing arrays + declared/registered/emitted snapshots) when any connector drifts.

#### Scenario: A schema edit removes a stream from the registry without removing it from the manifest
- **WHEN** the connector's `SCHEMAS` registry no longer includes a stream that the manifest still declares
- **THEN** the regression test SHALL fail with `missing_emit` listing that stream (or `missing_schema` if the connector still emits it)
