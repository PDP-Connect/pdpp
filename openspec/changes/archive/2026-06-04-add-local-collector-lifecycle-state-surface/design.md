# Design — Local collector lifecycle-state surface

## Context

`pdpp-local-collector status` / `doctor` read the per-connection durable SQLite outbox and emit JSON. They already expose `outbox.counts` (pending/retrying/leased/dead_letter/sent), `expired_leases`, `oldest_pending_at`, and a `doctor` severity (`ok`/`warning`/`critical`) computed from three checks (db-missing, expired-leases, dead-letter). The spec requirement "Local collector health is connection-scoped and inspectable" already says the surface "SHALL show whether durable work is pending, retrying, leased, stale, dead-lettered, or fully drained" — but the implementation left that as a count tuple the reader had to interpret, and had no signal at all for the coverage gap.

## Decision

Introduce one derived axis, `lifecycle_state`, with six mutually-exclusive values resolved in a fixed priority order (most-actionable first):

`dead_letter` > `stale_lease` > `retryable_backlog` > `draining` > `coverage_missing` > `healthy_idle`

- `dead_letter`: `deadLetter > 0`. Needs operator recovery (`retry-dead-letters`).
- `stale_lease`: `staleLeases > 0`. A prior run crashed mid-drain; the next run auto-recovers.
- `draining`: claimable-now (`ready - retrying > 0`) or `leased > 0` — actively moving records.
- `retryable_backlog`: ready work remains but all of it is waiting on retry backoff (`ready > 0 && ready - retrying == 0 && leased == 0`). Self-heals on the next scheduled run.
- `coverage_missing`: fully drained, the lane has collected `record_batch` rows, but none carried a `coverage_diagnostics` record. This is the device-local shape behind the dashboard's `coverage_unknown`.
- `healthy_idle`: fully drained with coverage accounted for, or nothing collected yet (no coverage to miss).

The derivation, `deriveLocalCollectorLifecycleState`, is a pure function in `collector-runner.ts` (the runner source of truth) re-exported through the no-Playwright runner slice so both the CLI and any future caller read one taxonomy.

### Detecting "coverage missing" locally

Coverage rides on the `coverage_diagnostics` records stream. Local-device collectors push records from the durable outbox and write no spine run, so the only durable local evidence is the outbox rows themselves. Succeeded `record_batch` rows are retained (only gap rows are deleted on recovery), so two read-only outbox queries answer it:

- `hasObservedStream({ sourceInstanceId, stream })` — returns `boolean | null`. A coverage record that only ever dead-lettered was never durably observed, so dead-letter rows are excluded.
- `countRecordBatches({ sourceInstanceId })` — non-dead-letter record-batch count (reads only the indexed `status`/`kind` columns), to tell an empty lane (nothing to miss) from a collected-but-no-coverage lane.

Both read only stream names / counts — never record bodies, paths, or tokens.

#### Payload-light, bounded coverage observation (perf construction)

The first implementation answered `hasObservedStream` with `json_each` over `$.records[*].stream` of **every** retained `record_batch` payload. That is O(retained payload bytes) and made `doctor` hang against a real ~35 GB Codex outbox. The corrected construction never reparses payloads on the hot path:

- A schema-v2 payload-light index, `local_device_observed_stream (outbox_id, source_instance_id, stream)`, is maintained on every `record_batch` `enqueue()` from the in-memory payload already in hand (one row per distinct stream; a sentinel row for empty-records batches). The probe reads indexed stream names joined to the row's *live* status, so the dead-letter exclusion needs no index update on a later transition.
- A pre-index (v1) outbox has `record_batch` rows with no index entry. The probe backfills those **lazily and per-lane-scoped**, bounded by a fixed scan budget: opening the DB does no payload work, and the first coverage probe for a lane reparses at most `budget` of that lane's unindexed rows (indexing each). If the lane's unindexed backlog exceeds the budget, the probe returns `null` (unknown) rather than launch an unbounded scan. Running the collector once more indexes the lane, after which the answer is exact.

When the caller cannot scope the scan (an unscoped `status` with no connection id) **or** a legacy unindexed backlog exceeds the budget, `coverageObserved` is `null` and `coverage_missing` is suppressed rather than guessed.

## Alternatives considered

- **Put the state on the heartbeat wire contract** so the dashboard reads it. Rejected: that is a durable contract change requiring server acceptance and is already covered, from the server side, by `classify-stalled-outbox-cause` (which derives a stalled `cause` from heartbeat evidence). This change is deliberately the *device-local CLI* counterpart and touches no wire contract.
- **Compute coverage from the server rollup.** Rejected: the CLI must work offline against the local outbox; the server rollup is the dashboard's path (`derive-local-collector-coverage-from-diagnostics`).

## Scope

In scope: the local `status`/`doctor` JSON surface, the derivation, the two read-only outbox queries, the payload-light observed-stream index (schema v2) that backs them, doc updates including the published-vs-dev deployment posture, tests. Out of scope: heartbeat/wire changes, server rollup changes, the `local_device_outbox` row schema itself (the index is an additive sidecar table, not a row-shape change).

## Acceptance checks

- Each of the six states resolves correctly from a constructed outbox (unit tests over the CLI surface).
- `hasObservedStream`/`countRecordBatches` survive a clean drain and ignore dead-letter rows (outbox unit test).
- New enqueues populate the observed-stream index; the probe answers from the index without reparsing payloads (proven by blanking `payload_json` out-of-band and still answering correctly).
- A pre-index (v1) outbox is backfilled within budget and answered exactly; an over-budget legacy backlog returns `observed: null` (bounded, no unbounded scan) and is never labeled `coverage_missing`.
- `status`/`doctor` JSON leaks no payloads, ids, or tokens.
- `npx tsc -p packages/local-collector/tsconfig.build.json --noEmit` and the runner-slice typecheck pass.
