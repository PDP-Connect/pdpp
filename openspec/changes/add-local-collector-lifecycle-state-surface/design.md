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

Coverage rides on the `coverage_diagnostics` records stream. Local-device collectors push records from the durable outbox and write no spine run, so the only durable local evidence is the outbox rows themselves. Succeeded `record_batch` rows are retained (only gap rows are deleted on recovery), so two read-only SQLite queries answer it:

- `hasObservedStream({ sourceInstanceId, stream })` — `json_each` over `$.records[*].stream` of non-dead-letter `record_batch` rows. A coverage record that only ever dead-lettered was never durably observed, so dead-letter rows are excluded.
- `countRecordBatches({ sourceInstanceId })` — non-dead-letter record-batch count, to tell an empty lane (nothing to miss) from a collected-but-no-coverage lane.

Both read only stream names / counts — never record bodies, paths, or tokens.

When the caller cannot scope the scan (an unscoped `status` with no connection id), `coverageObserved` is `null` and `coverage_missing` is suppressed rather than guessed.

## Alternatives considered

- **Put the state on the heartbeat wire contract** so the dashboard reads it. Rejected: that is a durable contract change requiring server acceptance and is already covered, from the server side, by `classify-stalled-outbox-cause` (which derives a stalled `cause` from heartbeat evidence). This change is deliberately the *device-local CLI* counterpart and touches no wire contract.
- **Compute coverage from the server rollup.** Rejected: the CLI must work offline against the local outbox; the server rollup is the dashboard's path (`derive-local-collector-coverage-from-diagnostics`).

## Scope

In scope: the local `status`/`doctor` JSON surface, the derivation, the two read-only outbox queries, doc updates, tests. Out of scope: heartbeat/wire changes, server rollup changes, outbox schema changes.

## Acceptance checks

- Each of the six states resolves correctly from a constructed outbox (unit tests over the CLI surface).
- `hasObservedStream`/`countRecordBatches` survive a clean drain and ignore dead-letter rows (outbox unit test).
- `status`/`doctor` JSON leaks no payloads, ids, or tokens.
- `npx tsc -p packages/local-collector/tsconfig.build.json --noEmit` and the runner-slice typecheck pass.
