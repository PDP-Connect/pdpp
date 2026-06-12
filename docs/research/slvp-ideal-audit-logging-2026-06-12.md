# SLVP-ideal: spine audit logging (gap-record over-emission)

**Date:** 2026-06-12
**Status:** DECIDED — 95% confidence (red-teamed). Implemented (runtime/index.js DETAIL_GAP case).
**Trigger:** `spine_events` grew to 1.9GB / 466K rows; ~6000 `run.detail_gap_recorded` rows/day (40% of spine growth). Every collection run re-logged a `recorded` event for nearly every unchanged, already-pending gap it re-deferred (a backlog of N gaps over K runs ≈ N×K events). The durable `connector_detail_gaps` table is correctly small (2527 rows) — the bloat is purely in the audit log.

## The principle (transition-only, not per-re-touch)

The spine is an **append-only AUDIT LOG of typed lifecycle FACTS-THAT-CHANGED** (Kafka delete-retention/audit class), **NOT a current-state mirror** — that role belongs to the durable `connector_detail_gaps` row (the compaction / latest-per-key class). Therefore `run.detail_gap_recorded` must fire **exactly once per gap identity — at first sighting** (the run that first records it) — and must NOT fire when a later run merely re-observes an already-pending, unchanged gap.

This matches:
- **The project's own scheduler contract** (`scheduler.ts:184-193`): "emits at most one record per attention identity; an unchanged identity is suppressed… re-emitting the same fact is noise."
- **The spine's own implementation rules** (`event-spine-implementation-plan.md:254-269`): "typed protocol/runtime facts, not arbitrary log lines"; "do not emit events for trivial reads." A re-defer that finds the gap unchanged is precisely a trivial re-read.
- **Temporal** — withholds retry attempts from Event History "to avoid filling the Event History with noise"; the attempt count lives in mutable Describe state.
- **Stripe** — `*.updated` only on an actual change.
- **Kafka delete-vs-compaction split / DDD no-op suppression.**

## The honesty verdict (why this is a PROTOCOL-HONESTY fix, not just disk)

Re-emitting an unchanged gap makes the run's event stream **LESS honest, not more**. The current payload omits `attempt_count` / `discovered_run_id` / `last_run_id`, so N re-emitted rows are **indistinguishable** — an auditor reading the timeline cannot tell "gap newly discovered" from "gap re-observed unchanged for the 7th time." Appending a fresh `recorded` event for a re-defer manufactures the appearance of new activity when nothing happened to the gap. That is dishonesty-by-volume: the SLVP verifiable bar is "a reviewer can tell from the log what actually happened," and N indistinguishable rows for one unchanging fact defeats it.

Honest stream: **one `recorded` at first sighting + one `recovered`/`terminal` at exit.** The "we kept trying across N runs" story lives in the durable row's monotonic `attempt_count` / `last_run_id` — the honest, bounded record of "we kept trying."

## The exact behavior

Gate the existing emit on the already-persisted, no-schema-change discriminator: in `runtime/index.js` DETAIL_GAP case, wrap the `run.detail_gap_recorded` emit in `if (storedGap.discovered_run_id === runId)`. The store's `ON CONFLICT DO UPDATE` clauses update `last_run_id` but **never touch `discovered_run_id`** (set only by the INSERT path) — so `discovered_run_id === runId` is true iff this run first recorded the gap.

Matrix:
1. Gap created brand-new this run → `discovered_run_id === runId` → **EMIT recorded.**
2. Gap re-deferred, already-pending, unchanged, first-seen a prior run → `discovered_run_id !== runId` → **DO NOT EMIT** (durable row's `last_run_id`/`updated_at` still advance via the upsert; `attempt_count` advances via `markGapStatus('in_progress')` when served).
3. `attempt_count`/`last_error` change → **no extra recorded event** (attempt history is the durable row's job); the meaningful escalation is already captured by `run.detail_gap_terminal` (§10-A, gated on `outcome.terminated`, unchanged).
4. Recovered → `run.detail_gap_recovered` (distinct pending→recovered transition, unchanged).
5. Terminal → `run.detail_gap_terminal` (gated, unchanged).

**Payload enrichment:** the single first-sighting event now carries `attempt_count` + `discovered_run_id` so it is self-describing (the discriminating fields an auditor needs).

**Idempotency (the red-team mandate, done via the in-house in-memory pattern):** an in-memory per-run `Set<gap_id>` (`detailGapRecordedThisRun`) ensures at-most-one first-sighting emit per gap per run, closing the resumed-run-stdout-replay edge where a brand-new gap's DETAIL_GAP could be re-processed. This mirrors the attention-writer's `open`/`byRequestId` Maps — **no schema change on the hot spine append path** (a `(run_id, gap_id, event_type)` DB unique constraint was rejected as disproportionate: `gap_id` lives in `data_json`, so it would require a generated column + ON CONFLICT migration on the live 466K-row append path to close a merely-cosmetic duplicate-row edge).

Net: emission volume drops from O(pending_backlog × runs) to O(new_gaps + recoveries + terminalizations).

## Auditability preserved (no capability lost)

"This gap existed and was worked across runs" is fully reconstructable from: (a) the single first-sighting `recorded` event (immutable discovery proof: run_id + timestamp + locator); (b) the durable `connector_detail_gaps` row — `attempt_count` (monotonic, +1 per `in_progress` lease), `discovered_run_id` (INSERT-only), `last_run_id`, `last_attempt_at`, `last_error`, `recovered_run_id`, `updated_at`; (c) the `recovered`/`terminal` exit event. The ONLY thing lost is the per-run breadcrumb of each individual re-observation — correctly classified as noise (matches Temporal: attempt count in mutable state, withheld from history).

## Red-team verdict (final confidence 95%)

SOUND. Verified against the **canonical** `reference-implementation/` tree:
- **No consumer breaks.** Exhaustive grep of non-test `*.ts/*.js/*.mjs/*.sql`: only the emit sites in `runtime/index.js` reference these gap events. Spine SQL queries filter only `run.started`/terminal/`progress_reported`. The commit-coverage gate (`assertDetailCoverageSatisfiedBeforeCommit`) reads the in-memory `durableDetailGaps` array (left untouched — `push`/`appendKnownGap`/`onProgress` stay OUTSIDE the gate), not the spine. Operator `known_gaps`/`pending_detail_gaps` come from the durable store + terminal-event `collection_facts`. External clients never receive gap events. No reconciliation/boot path replays them.
- **The two timeline tests** (`ref-spine-events-page-operation.test.js:250`, `ref-run-timeline-terminal-status.test.js`) emit `detail_gap_recorded` as arbitrary non-terminal filler via direct `emitSpineEvent`/`makeEvent` that BYPASS the runtime gate — so they need **zero** changes.
- **No risk of suppressing a NEW gap:** a brand-new gap always has `discovered_run_id === runId` (the INSERT-only invariant). Recovered/terminal paths unchanged.

## Files

- `reference-implementation/runtime/index.js` — DETAIL_GAP case: gate + `detailGapRecordedThisRun` Set + payload enrichment.
