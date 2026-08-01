// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live symptom (2026-07-31, live 22a6f182a, AFTER both the admission-gate
 * fix and the cross-page cursor round-robin fix were deployed): connection
 * `cin_2de5ede05c8cc8d45935c414` sat on a page whose terminal fold read the
 * SAME 10 terminal-fold events every round, took 3-6s, and left this
 * connection's `record_checkpoint_mismatch`/`dirty` generic-repair
 * candidate reporting `skipped=1, repaired=0` forever — even though the
 * cross-page cursor was, by then, genuinely advancing past OTHER pages.
 * The fold's own checkpoint crept forward (proving it was live, not
 * deadlocked) while the SAME connection's generic repair never got a
 * single unit of the shared per-page deadline, because
 * `runBoundedObservationPhases` (connector-summary-read-model.ts) always
 * ran the fold phase first, unconditionally, every call, sharing ONE
 * absolute deadline with generic repair.
 *
 * Fold and generic repair operate on disjoint evidence columns (fold only
 * ever writes `terminal_facts_state`/`stream_facts_event_seq`/
 * `stream_latest_facts_json`; generic repair only ever writes
 * `record_snapshot`/`manifest_declaration`/`retained_bytes`/etc — see
 * `classifyCandidate`/`repairCandidateSqlite` in
 * connector-summary-evidence-engine.ts), so there is no correctness reason
 * fold must always go first — the ONE genuine ordering dependency is
 * `missing` repair before fold (a nonexistent row has nothing to fold).
 *
 * The fix alternates which phase — the first fold attempt, or generic
 * repair — gets first claim on the shared deadline, keyed off the
 * caller's durable `ConnectorMaintenanceCursorLease.generation` (already
 * atomically incremented per lease acquisition for stale-owner fencing —
 * no new column, no new query, no in-process-only counter that would
 * reset to the same starting parity on every restart).
 *
 * This file proves, directly against the real production primitive
 * (`runBoundedSummaryEvidenceSweep`, the exact function both the periodic
 * timer and the startup walk call every round):
 *
 *   1. With a permanently-slow fold sharing a page with one dirty
 *      connection, and turn parity pinned to fold-always-first
 *      (`phaseTurnGeneration` even, matching the pre-fix default), the
 *      dirty connection's generic repair is skipped every round — an
 *      exact, deterministic reproduction of the live symptom.
 *   2. Feeding alternating turn parity (as the real lease's
 *      `generation`, incremented once per round, genuinely would) lets
 *      the dirty connection converge within a small, bounded number of
 *      rounds, because it gets first claim on the deadline every OTHER
 *      round regardless of how slow fold is.
 *   3. Adversarial case: a repair unit itself slower than any fixed
 *      time-slice could reserve (proving a naive fixed-fraction split
 *      would not have been sufficient) still converges under the
 *      alternating-turn-order fix, because the phase that goes first gets
 *      the FULL remaining deadline, not a capped fraction of it.
 *   4. The fix does not regress the cold-start dependency: a page with a
 *      brand-new (never-before-seen) connection still creates its
 *      evidence row and folds its terminal history in one convergent
 *      pass, regardless of which phase's turn it is.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { __testOnlySetFoldPauseHook, runBoundedSummaryEvidenceSweep } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-07-31T00:00:00.000Z";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-phase-fairness-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      __testOnlySetFoldPauseHook(null);
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number, { connectorId = "c1" }: { connectorId?: string } = {}): string[] {
  const existing = getDb().prepare("SELECT 1 FROM connectors WHERE connector_id = ?").get(connectorId);
  if (!existing) {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
      .run(connectorId, NOW);
  }
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${connectorId}_cin_${String(i).padStart(4, "0")}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(id, connectorId, id, NOW, NOW);
    ids.push(id);
  }
  return ids;
}

function seedTerminalEvents(connectorInstanceId: string, count: number): void {
  for (let eventSeq = 1; eventSeq <= count; eventSeq += 1) {
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
      )
      .run(
        `evt_fairness_${connectorInstanceId}_${eventSeq}`,
        eventSeq,
        NOW,
        NOW,
        `trace_fairness_${connectorInstanceId}_${eventSeq}`,
        `run_fairness_${connectorInstanceId}_${eventSeq}`,
        `run_fairness_${connectorInstanceId}_${eventSeq}`,
        connectorInstanceId,
        JSON.stringify({
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ record_count: eventSeq, resolved: true, stream: "messages" }],
          },
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
        })
      );
  }
}

let nextGlobalEventSeq = 1;

/** Inserts exactly one NEW terminal event at the next global event_seq. */
function seedOneTerminalEvent(connectorInstanceId: string): void {
  const eventSeq = nextGlobalEventSeq;
  nextGlobalEventSeq += 1;
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
    )
    .run(
      `evt_fairness_one_${eventSeq}`,
      eventSeq,
      NOW,
      NOW,
      `trace_fairness_one_${eventSeq}`,
      `run_fairness_one_${eventSeq}`,
      `run_fairness_one_${eventSeq}`,
      connectorInstanceId,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ record_count: eventSeq, resolved: true, stream: "messages" }],
        },
        connection_id: connectorInstanceId,
        connector_instance_id: connectorInstanceId,
      })
    );
}

function markDirty(connectorInstanceId: string): void {
  getDb()
    .prepare("UPDATE connector_summary_evidence SET dirty = 1 WHERE connector_instance_id = ?")
    .run(connectorInstanceId);
}

function evidenceRow(connectorInstanceId: string): Record<string, unknown> | undefined {
  return getDb()
    .prepare("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as Record<string, unknown> | undefined;
}

/**
 * Installs a deterministic ASYNC fold delay (unlike the sync
 * `Atomics.wait`-based `PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS` repair
 * knob, which cannot model a slow fold): every fold pass pauses for
 * `delayMs` at `after_seed_before_read`, sustained for the whole test —
 * modeling the live symptom's few-events-but-high-write-latency terminal
 * fold, which reads only ~10 events yet takes 3-6s wall clock.
 */
function withSlowFold<T>(delayMs: number, fn: () => Promise<T>): Promise<T> {
  __testOnlySetFoldPauseHook(async (point) => {
    if (point === "after_seed_before_read") {
      await sleep(delayMs);
    }
  });
  return fn().finally(() => __testOnlySetFoldPauseHook(null));
}

test(
  "reproduction: a permanently-slow fold starves a dirty connection's generic repair forever when fold always goes first (pre-fix default parity)",
  withTempDb(() =>
    withSlowFold(60, async () => {
      const ids = seedConnections(5);
      // Establish evidence + a real terminal checkpoint baseline so every
      // subsequent round's fold has genuine (small) work to do, matching
      // the live symptom's "same 10 events every round" shape rather than
      // a one-shot cold bootstrap.
      await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 5 });
      seedTerminalEvents(ids[0] as string, 10);
      const target = ids[2] as string;
      markDirty(target);

      // Sanity: the fold genuinely never converges within any round's tiny
      // budget (matching the live symptom's "same events every round").
      let anyFoldIncomplete = false;
      const maxRounds = 8;
      let converged = false;
      for (let round = 0; round < maxRounds; round += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the previous round's durable state before deciding the next.
        const result = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 40, pageSize: 5 });
        anyFoldIncomplete ||= result.incomplete;
        if (Number(evidenceRow(target)?.dirty ?? 0) === 0) {
          converged = true;
          break;
        }
      }
      assert.equal(
        anyFoldIncomplete,
        true,
        "sanity: the permanently-slow fold genuinely never converges within a round's budget"
      );

      assert.equal(
        converged,
        false,
        "fold-always-first starves the dirty connection's generic repair for every round of a permanently-slow fold — the exact live symptom"
      );
    })
  )
);

test(
  "fix: alternating turn parity (the real lease generation) converges the same dirty connection within a small bounded number of rounds",
  withTempDb(() =>
    withSlowFold(60, async () => {
      const ids = seedConnections(5);
      await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 5, phaseTurnGeneration: 0 });
      seedTerminalEvents(ids[0] as string, 10);
      const target = ids[2] as string;
      markDirty(target);

      const maxRounds = 8;
      let converged = false;
      for (let round = 1; round <= maxRounds; round += 1) {
        // A real ConnectorMaintenanceCursorLease.generation increments by
        // exactly 1 on every acquisition — this loop feeds it in exactly
        // like `createResumableConnectorMaintenanceSweep` genuinely would.
        // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the previous round's durable state before deciding the next.
        await runBoundedSummaryEvidenceSweep({
          maxDurationMs: 40,
          pageSize: 5,
          phaseTurnGeneration: round,
        });
        if (Number(evidenceRow(target)?.dirty ?? 0) === 0) {
          converged = true;
          break;
        }
      }

      assert.equal(
        converged,
        true,
        `alternating phase-turn parity must converge the dirty connection within ${maxRounds} rounds even while fold is permanently slow`
      );
    })
  )
);

test(
  "adversarial: fold AND repair are both slower than any fixed time-slice could reserve for either — turn alternation still converges, discriminating this fix from a fixed-fraction split",
  withTempDb(() =>
    withSlowFold(60, async () => {
      const ids = seedConnections(5);
      // Evidence rows already exist (not a cold/`missing` page) before the
      // fold delay and repair delay are both installed below — otherwise
      // `missing` repair (which always runs before either phase's turn,
      // the one preserved ordering dependency) would converge this page
      // on its own regardless of turn order, masking the effect under
      // test.
      await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: 5 });
      const target = ids[2] as string;
      markDirty(target);
      // Every round's fresh terminal event lands on `target` itself, not a
      // different row: `classifyCandidate` checks `dirty` BEFORE
      // `record_checkpoint_mismatch` (connector-summary-evidence-engine.ts),
      // so a row already `dirty=1` is classified `"dirty"` regardless of
      // its checkpoint drift — this keeps exactly ONE generic-repair
      // candidate on the page for the whole test, isolating the
      // fold-vs-repair turn effect from an unrelated second candidate that
      // would otherwise also compete for repair's own slice.

      // A repair unit (150ms) SLOWER than the round's own total budget
      // (60ms) AND slower than any fraction of it a naive time-slice
      // policy could reserve — e.g. a 50% reservation would cap repair's
      // slice at 30ms, well under 150ms, so a fixed-fraction split could
      // never let this repair unit finish inside its slice. Convergence
      // here can only come from repair getting the FULL remaining
      // deadline on its turn (this fix's actual mechanism), proving a
      // fixed-fraction reservation would not have been sufficient even if
      // it had also solved the fold-always-first ordering problem.
      process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS = "150";
      try {
        let converged = false;
        for (let round = 1; round <= 10; round += 1) {
          seedOneTerminalEvent(target);
          // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the previous round's durable state before deciding the next.
          await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60, pageSize: 5, phaseTurnGeneration: round });
          if (Number(evidenceRow(target)?.dirty ?? 0) === 0) {
            converged = true;
            break;
          }
        }
        assert.equal(
          converged,
          true,
          "turn alternation converges even when BOTH phases are individually slower than the round budget, because the phase whose turn it is gets the full remaining deadline, never a capped fraction"
        );
      } finally {
        delete process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
      }
    })
  )
);

test(
  "no regression: a brand-new connection still gets created and its terminal history folded in one convergent pass, on either phase-turn parity",
  withTempDb(async () => {
    for (const phaseTurnGeneration of [0, 1]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each parity value is an independent, sequential scenario sharing no state.
      await (async () => {
        const dir = mkdtempSync(join(tmpdir(), "pdpp-phase-fairness-cold-"));
        try {
          initDb(join(dir, "pdpp.sqlite"));
          const ids = seedConnections(3, { connectorId: `cold_${phaseTurnGeneration}` });
          seedTerminalEvents(ids[0] as string, 3);
          const result = await runBoundedSummaryEvidenceSweep({
            maxDurationMs: 60_000,
            pageSize: 3,
            phaseTurnGeneration,
          });
          assert.equal(
            result.incomplete,
            false,
            `parity ${phaseTurnGeneration}: a cold page with ample budget converges`
          );
          const row = evidenceRow(ids[0] as string);
          assert.ok(row, `parity ${phaseTurnGeneration}: the brand-new connection's evidence row was created`);
          assert.equal(
            Number(row?.stream_facts_event_seq),
            3,
            `parity ${phaseTurnGeneration}: the new row's terminal history was folded in the same convergent pass`
          );
        } finally {
          closeDb();
          rmSync(dir, { force: true, recursive: true });
        }
      })();
    }
  })
);
