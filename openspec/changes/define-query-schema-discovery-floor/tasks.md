## 1. OpenSpec

- [x] Create proposal, design, tasks, and spec delta for `define-query-schema-discovery-floor`.
- [x] Validate with `openspec validate define-query-schema-discovery-floor --strict`.

## 2. Reference Implementation

- [x] Add public RS `GET /v1/connectors` route.
- [x] Return owner-token polyfill connector summaries from registered manifests without requiring `connector_id`.
- [x] Return client-token summaries scoped to the active grant only.
- [x] Keep capability hints coarse and defer full schema to existing per-stream metadata.

## 3. Tests And Docs

- [x] Add targeted tests for owner polyfill discovery.
- [x] Add targeted tests for client-token scoping and no grant leakage.
- [x] Update generated public route docs/OpenAPI artifacts.

## Acceptance Checks

- [x] `openspec validate define-query-schema-discovery-floor --strict`
- [x] Targeted reference/query tests
- [x] Reference contract generated artifacts are current
- [x] Reference typecheck/check
