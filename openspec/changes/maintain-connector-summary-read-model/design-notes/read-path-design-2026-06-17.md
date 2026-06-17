# Connector Summary Read Path Design

Date: 2026-06-17
Status: decided design note for `maintain-connector-summary-read-model`

## Decision

Do not flip unscoped `GET /_ref/connectors` directly to the current
`connector_summary_evidence` table. The table is presently a safe storage
scaffold: identity, lifecycle, total record count, stream count, and dirty
metadata. The current list projection also synthesizes from run summaries,
terminal events, detail gaps, outbox/heartbeat state, attention records, local
coverage, acquisition coverage, schedules, rate evidence, and retained-size
stream detail.

The SLVP-ideal read-path swap is a staged construction:

1. Add the missing durable field needed for honest shallow-list freshness:
   `last_record_updated_at`, derived in the same grouped evidence extraction
   that already builds `total_records` and `stream_count`.
2. Split the current `projectConnectorSummaryForInstance` path into a pure
   `synthesizeConnectorSummary` tail and a reader/gatherer front half. The
   list path, scoped path, rebuild, and reconcile must converge on one synthesis
   function so the read model cannot drift from the existing projection.
3. Use maintained evidence for the non-singleton majority of unscoped list
   rows. Those rows already run under `includeRunSummaries: "singleton-active"`
   and do not hydrate deep run/gap evidence today.
4. Keep singleton-active rows and all scoped/detail/diagnostic reads on the
   deep evidence path until those deeper evidence classes are maintained
   durably. The optimization target is the O(N) majority list fan-out, not
   exact scoped diagnostics.
5. Gate the read-model path behind a flag until write hooks and query-count
   tests prove it is correct.

## Current Fan-Out

Unscoped `/_ref/connectors` calls `listConnectorSummaries(controller, {
includeRunSummaries: "singleton-active" })`; scoped reads call
`getConnectorSummaryForRoute`.

At the route boundary, this means:

- `GET /_ref/connectors` can take the optimized overview path once the read
  model is complete enough for shallow rows.
- `GET /_ref/connectors?connection=...`, connection detail pages,
  diagnostics, recovery panels, and owner actions must continue using deep
  evidence until every deeper evidence class has a maintained projection.

`projectConnectorSummaryForInstance` currently performs roughly 8-10
per-connection reads on a cold compute:

- schedule
- latest run
- latest successful run
- run terminal/rate evidence
- detail gaps and gap counts
- outbox and local-device heartbeats
- attention records
- local coverage
- acquisition coverage

Retained-size and browser-surface evidence are already batched once per
request. The read-model work should extend that batch/replay shape, not add a
second cache over stale synthesized output.

The performance target is specifically the unscoped overview's N-connection
deep fan-out. The scoped/detail path is not the target of this tranche.

## Evidence Gap

Current `connector_summary_evidence` is sufficient for identity/lifecycle and
basic counts, but not for deep state. Missing durable evidence includes:

- last run and last successful run evidence
- pending/recovered/terminal detail gaps
- outbox axis, cause, and local-device heartbeat rollup
- open attention records
- local coverage and acquisition coverage
- schedule/refresh inputs
- collection-rate snapshot
- per-stream record summaries and retained bytes

The smallest safe tranche does not persist all of these. It adds
`last_record_updated_at` and keeps deep evidence on the singleton/scoped path.

This deliberately avoids persisting rendered verdicts, freshness labels, or UI
copy. Those stay synthesized from durable facts at read time so the system does
not recreate stale-copy verdict failures.

## Query-Count Proof

Add a dependency-injection/query-count test before flipping the list path:

- Seed multiple connections where most rows are non-singleton/shallow.
- Enable the read-model flag.
- Assert the maintained evidence list is read once.
- Assert deep per-connection readers are not called for non-singleton shallow
  rows.
- Include a negative control under deep mode or scoped mode that proves the
  spies fire when deep evidence is legitimately requested.
- Assert scoped diagnostics still use deep evidence and are not served from a
  shallow overview row.

## Commit Sequence

1. Add `last_record_updated_at` to SQLite/Postgres schemas, evidence rows, rebuild,
   reconcile, and storage tests.
2. Extract pure `synthesizeConnectorSummary` without changing behavior.
3. Extend the maintained evidence envelope until it can honestly synthesize the
   existing `ConnectorSummary` contract for overview rows, or approve an
   explicit reduced overview contract in OpenSpec.
4. Add read-model list path behind a disabled flag.
5. Add query-count/DI tests and shallow-list parity tests.
6. Finish write hooks required by the flag.
7. Enable the flag only after tests and live benchmark prove correctness.
8. Remove or gate the short TTL cache once the maintained read model owns the
   hot path.

Before step 7, every route that currently calls
`invalidateConnectorSummariesCache` must either mark the exact connection dirty
or explain why an all-connection dirty mark is the only honest option. The
read-model flag must not depend on best-effort cache invalidation alone.

## Feasibility Checkpoint: 2026-06-17

After adding `last_record_updated_at` and extracting
`synthesizeConnectorSummary`, an isolated implementation lane attempted the
disabled read-model flag and stopped before code. The current
`connector_summary_evidence` row is still too small to construct the existing
`ConnectorSummary` contract for shallow overview rows without either:

- calling the same deep per-connection readers the read model is meant to avoid;
- fabricating or omitting owner-visible fields; or
- persisting rendered verdict/freshness/UI copy, which this design explicitly
  forbids.

Current durable evidence covers identity/lifecycle plus aggregate counts:
`connector_instance_id`, `connector_id`, `display_name`, `status`,
`source_kind`, `revoked_at`, `total_records`, `stream_count`, and
`last_record_updated_at`.

The existing owner summary contract still carries fields outside that envelope:
manifest stream names, per-stream record summaries, retained byte totals, run
and schedule facts, detail-gap/outbox/attention/browser/local/acquisition
evidence, `collection_report`, `connection_health`, `rendered_verdict`, and
`next_action`.

Therefore the next safe tranche is not the disabled flag itself. It is either:

- maintain additional non-rendered evidence sufficient for read-time synthesis
  of overview rows; or
- deliberately define a reduced overview row contract and migrate console
  consumers to it before any fast path uses partial evidence.

Until one of those two choices is implemented and tested, the full
`/_ref/connectors` list must remain on the deep projection path.

## Risks

- A shallow fast path that drops deep evidence would be fast but dishonest.
- Persisting rendered verdicts or freshness would recreate stale-copy failures.
- Existing diagnostics may accidentally reuse a shallow list row; scoped
  diagnostics must stay deep.
- Dirty hooks must be complete before the read-model path becomes default.
- The overview path can be optimized without making every deep evidence class
  durable in the first tranche; trying to persist all deep evidence before the
  first switch risks turning a focused performance fix into a broad rewrite.
