## Why

A local-device collector that has run, fully drained its outbox, checked in with a fresh healthy heartbeat, and emitted complete `coverage_diagnostics` still cannot project `healthy`. The connection-health classifier reaches `CollectionSucceeded=true` only from a terminal spine run (`run.latestStatus === "succeeded"`), and local-device collectors push records from a device outbox and never write spine run history. So `CollectionSucceeded` stays `unknown`, and the connection lands on `idle` (no terminal verdict) or `unknown` (no verdict + fresh evidence) no matter how green the device-side evidence is.

This is the owner-gated residual the `derive-local-collector-coverage-from-diagnostics` change deferred: that change made the *coverage* axis honest (`complete` instead of `unknown`) but explicitly left the headline at `idle` because promoting it to `healthy` "would require an ingest-as-collection-success signal, which is a separate contract decision." This change defines that signal.

A local-device collector's terminal collection evidence is not a spine run — it is the device's own report that it ran and finished cleanly: a trusted, drained, non-degraded outbox plus complete durable coverage diagnostics. That combination is the device-side analog of a succeeded run, and treating it as a collection-succeeded verdict is evidence-based, not fabricated. It is gated so that absence, untrusted evidence, backlog, dead letters, stale leases, coverage gaps, or missing coverage can never reach the verdict.

## What Changes

- The connection-health classifier SHALL accept a typed `local-device collection verdict` evidence input: for a local-device-backed connection, when (a) the outbox axis is `idle` from trusted heartbeat evidence (not `unknown`/`active`/`stalled`), (b) durable coverage diagnostics prove `complete` coverage, and (c) freshness is `fresh`, the verdict SHALL set the `CollectionSucceeded` condition to `true`, equivalent to a recent terminal succeeded run.
- The verdict SHALL apply ONLY to local-device-backed connections. The caller (`listConnectorSummaries` / `getConnectorDetail`) SHALL populate it only when the connection is local-device-backed; a run-derived `CollectionSucceeded` verdict SHALL always take precedence so a scheduler-managed connection's outcome is never overridden by device evidence.
- The change SHALL be purely additive to the headline. Gating the verdict on freshness `fresh` means a drained collector with complete coverage but no satisfied freshness policy keeps `CollectionSucceeded` unknown and stays `idle` exactly as today (it does not become `unknown`); only the fully-green case is upgraded to `healthy`. Stale heartbeat, dead letters, retryable backlog, stale lease, coverage gaps, missing/unknown coverage, untrusted device evidence, and an empty outbox with no coverage diagnostics SHALL all keep the connection out of `healthy`, exactly as today.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: The connection-health projection SHALL recognize a local-device collection-succeeded verdict — a trusted idle/drained outbox plus complete durable coverage diagnostics on a local-device-backed connection — as terminal collection evidence equivalent to a succeeded run, so such a connection can project `healthy` when freshness is also satisfied, while preserving every honest non-green state.

### Removed Capabilities

## Impact

- Affected runtime: `reference-implementation/runtime/connection-health.ts` (new optional `localDeviceCollection` evidence on `ComputeConnectionHealthInput` plus a `collection_succeeded_local_device` reason; `collectionSucceededCondition` honors the verdict when no run verdict exists). `reference-implementation/server/ref-control.ts` (`projectConnectorSummaryConnectionHealth` accepts a `localDeviceBacked` flag and derives the gated verdict from `outbox.axis`, the resolved coverage axis, and freshness; `listConnectorSummaries` sets the flag from `instance.sourceKind`, `getConnectorDetail` from the presence of trusted device heartbeats).
- No change to the heartbeat wire contract, the outbox axis taxonomy, the coverage diagnostics shape, or the headline-state set. Reuses evidence the rollup already reads (`getConnectorOutboxAxis`, `getConnectorLocalCoverageAxis`).
- Affected tests: `reference-implementation/test/connection-health.test.js` (verdict unit cases), `reference-implementation/test/ref-connectors-local-coverage-green.test.js` (server-rollup healthy/idle cases).
