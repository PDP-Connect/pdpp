# Connector Summary Synthesis Extraction Plan

Date: 2026-06-17
Status: implementation plan for step 2 of `maintain-connector-summary-read-model`

## Scope

Extract a pure `synthesizeConnectorSummary` tail from
`projectConnectorSummaryForInstance` without changing behavior.

This step SHALL NOT switch `/_ref/connectors` to the maintained read model,
change `ListConnectorSummariesOptions`, alter cache behavior, persist
freshness/health/verdict/copy, or route scoped diagnostics through shallow
overview evidence.

## Current Boundary

`reference-implementation/server/ref-control.ts` currently has the relevant
boundaries:

- `projectConnectorSummaryForInstance` performs eligibility checks, async
  evidence reads, schedule/run/detail/outbox/attention/local/acquisition
  gathering, collection-rate read, and final summary synthesis.
- `computeConnectorSummaries` maps dashboard connection rows through
  `projectConnectorSummaryForInstance`.
- `getConnectorSummaryForRoute` resolves exactly one connection, loads deep
  deps with `includeRunSummaries: true`, and then calls
  `projectConnectorSummaryForInstance`.
- `getOwnerConnectionDiagnostics` depends on `getConnectorSummaryForRoute`.

The extraction must leave the first three bullets true. It is a construction
refactor, not a read-path switch.

## Extraction Shape

Add a local pure helper in `ref-control.ts`:

```ts
function synthesizeConnectorSummary(input: ConnectorSummarySynthesisInput): ConnectorSummary
```

`projectConnectorSummaryForInstance` keeps all IO and time capture:

- manifest/public-connector eligibility
- `connectorId` / `connectorInstanceId` derivation
- `hydrateRunSummaries` decision
- record projection reads
- schedule, run, successful-run, detail-gap, outbox, attention, browser-surface,
  local-coverage, acquisition-coverage reads
- refresh-policy derivation
- `nowIso` capture
- collection-rate read

Only the deterministic tail moves:

- local-device progress projection
- local-device heartbeat freshness eligibility
- `buildConnectorFreshness`
- `projectConnectorSummaryConnectionHealth`
- `projectCollectionReport`
- display-name fallback
- recovered-detail-gap count
- `buildRenderedVerdictForSummary`
- final `ConnectorSummary` object construction

The pure helper must not call storage/controller methods, cache invalidation,
dirty markers, telemetry/audit functions, or `new Date()`.

## High-Risk Fields

Preserve these exactly:

- `freshness`: same `nowIso`, run, record, refresh-policy, and local-device
  heartbeat rules. Do not move time capture into the helper.
- `connection_health`: same detail-gap counts, outbox cause, attention,
  remote-surface, local/acquisition coverage, collection-rate, refresh-policy,
  schedule, and unreliable-source aggregation.
- `collection_report`: same `lastRun`, `connectionHealth`, manifest streams,
  pending detail gaps, and refresh-policy inputs.
- `rendered_verdict`: same collection report, health, freshness,
  recovered-detail-gap, local-device-backed, manifest, observed-time,
  refresh-policy, retained-count, runtime, and schedule inputs.
- Identity: `connection_id` and `connector_instance_id` remain the selected
  `connectorInstanceId`; `connector_id` remains the canonical connector id.
- Record fields: `live` still comes from the current record projection path;
  retained bytes and stream summaries remain derived from that `live` object.

## Characterization Test

Before or in the extraction commit, add a scoped deep-path characterization
test, preferably near existing tests in
`reference-implementation/test/ref-connectors-connection-projection.test.js`.

The test should seed sibling connections for the same connector, give the target
connection run/detail/outbox/local-device/record evidence, call
`getConnectorSummaryForRoute`, and assert:

- `connection_id` and `connector_instance_id` equal the target connection id.
- `last_run` and `last_successful_run` are hydrated on the scoped path.
- `connection_health` carries target-only detail/outbox evidence.
- `collection_report` and `rendered_verdict` are present.
- Sibling run/detail evidence does not leak.

If `synthesizeConnectorSummary` is exported for reuse in the same commit, add a
direct fixed-`nowIso` unit. Do not export solely for testing.

## Validation

Run at minimum:

```bash
node --test --test-timeout=30000 --import tsx \
  reference-implementation/test/ref-connectors-connection-projection.test.js \
  reference-implementation/test/ref-connectors-list-connection-scope.test.js \
  reference-implementation/test/owner-connection-diagnostics.test.js \
  reference-implementation/test/ref-connectors-list-operation.test.js
pnpm --dir reference-implementation run typecheck
openspec validate maintain-connector-summary-read-model --strict
git diff --check
```

Then grep/read back the changed `ref-control.ts` hunk for:

- `synthesizeConnectorSummary`
- `projectConnectorSummaryForInstance`
- `includeRunSummaries`
- `getOwnerConnectionDiagnostics`
- `getConnectorSummaryForRoute`

Confirm scoped/detail diagnostics still use the deep route path.
