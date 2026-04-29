## Why

The reference operation-boundary program has moved public records, streams, schema, search, dataset-summary, connector catalog, and approvals reads behind canonical operation modules. The disclosure-spine operator-console reads (`/_ref/traces`, `/_ref/grants`, `/_ref/runs`, the per-correlation timelines, and `/_ref/search`) are still route-local even though the spine library already exposes a clean read surface (`listSpineCorrelations`, `listSpineEventsPage`, `searchSpine`) and existing conformance and security tests pin the response and redaction shapes.

## What Changes

- Add canonical operation modules for `ref.spine.correlations.list`, `ref.spine.events.page`, and `ref.spine.search`.
- Mount the existing `/_ref/traces`, `/_ref/grants`, `/_ref/runs`, `/_ref/traces/:traceId`, `/_ref/grants/:grantId/timeline`, `/_ref/runs/:runId/timeline`, and `/_ref/search` routes through those operations.
- Move correlation- and timeline-envelope assembly (the `trace_summary` / `grant_summary` / `run_summary` / `trace` / `grant_timeline` / `run_timeline` / `search_result` discriminators, list `data` arrays, pagination fields, and live-bearer redaction) into the operation modules.
- Add operation-boundary and behavior tests without changing response contracts.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: reference operation modules and Fastify host adapters in `reference-implementation/server/index.js`.
- Tests: per-operation boundary and behavior tests; existing `event-spine`, `disclosure-spine-conformance-*`, and `security-auth-surfaces` tests remain authoritative for route-level shapes.
- Out of scope: `lib/spine.ts` semantics, cursor encoding, event ordering, summarizer behavior, sandbox `apps/web/src/app/sandbox/ref/{traces,grants,runs}/**` handlers, RS `/v1/**`, records/search/blob code, auth/device/consent surfaces, and storage interfaces.
