# Tasks: add local-device collection verdict

## 1. Classifier verdict input

- [x] 1.1 Add optional `localDeviceCollection: ConnectionLocalDeviceCollectionEvidence | null` to `ComputeConnectionHealthInput` in `reference-implementation/runtime/connection-health.ts`. The evidence carries a `verdict: "succeeded"` marker the caller emits only when the device-side gates hold.
- [x] 1.2 In `collectionSucceededCondition`, when there is no run verdict (`run` absent or `latestStatus === null`) and `localDeviceCollection?.verdict === "succeeded"`, return `CollectionSucceeded` with `status="true"`, origin `local_device`, a stable reason (`collection_succeeded_local_device`), and the observed timestamp. A run verdict always takes precedence (run path unchanged).

## 2. Rollup threading (caller builds the gated verdict)

- [x] 2.1 Add optional `localDeviceBacked` flag to `projectConnectorSummaryConnectionHealth` input; the projection derives the gated `localDeviceCollection` verdict internally and passes it to `computeConnectionHealth`. (The verdict is computed in the projection rather than by every caller, keeping the gate in one place.)
- [x] 2.2 In `projectConnectorSummaryConnectionHealth`, build the verdict only when `localDeviceBacked === true`, `outbox.axis === "idle"`, the resolved coverage axis is `complete`, and freshness is `fresh`. Otherwise pass `null`. Set `localDeviceBacked` at both call sites: `listConnectorSummaries` from `instance.sourceKind === "local_device"`; `getConnectorDetail` (connector-keyed, no instance row) from the presence of trusted device heartbeats.

## 3. Spec + tests

- [x] 3.1 Add the `reference-connection-health` requirement defining the local-device collection verdict and its gates (this change's spec delta).
- [x] 3.2 Add unit tests in `connection-health.test.js`: verdict → healthy with fresh; absent verdict (no run) is not healthy; freshness-unknown without verdict stays idle; verdict ignored when a run verdict exists; stalled outbox degrades even with a verdict.
- [x] 3.3 Extend `ref-connectors-local-coverage-green.test.js`: a trusted idle/drained local collector with complete coverage and a policy-backed fresh heartbeat projects `healthy`; without a refresh policy it stays `idle`; a stalled collector with a satisfied freshness policy stays `degraded`.

## Acceptance checks

- `node --test --import tsx reference-implementation/test/connection-health.test.js reference-implementation/test/connection-health-acceptance.test.js reference-implementation/test/ref-connectors-local-coverage-green.test.js` — all pass.
- `npx tsc --noEmit` (reference-implementation) — no errors.
- `openspec validate add-local-device-collection-verdict --strict` — passes.
- `git diff --check` — clean.
