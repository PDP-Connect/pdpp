// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration proof (design reviewer finding P2-4) that `eligibleBacklog` on
 * `runBoundedSummaryEvidenceSweep`'s `BoundedSweepResult` is wired to the
 * REAL `connector_summary_evidence.dirty` count — not just correct in the
 * mocked unit tests in `connector-maintenance-sweep-no-progress.test.ts`.
 *
 * Also proves the real-incident shape end to end: a dirty backlog can sit
 * pinned across several bounded rounds while individual repairs succeed
 * (`onPageConverged` fires, rows get folded), because those same rows (or
 * others) keep getting re-dirtied between rounds — `eligibleBacklog` must
 * report the CURRENT count each round, not a monotonically-decreasing
 * cache, so the no-progress counter built on top of it (see
 * `connector-maintenance-sweep.ts`) can see the fleet is stuck.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markConnectorSummaryEvidenceDirty,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const PRODUCTION_PAGE_SIZE = 25;
const NOW = "2026-08-18T00:00:00.000Z";

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-eligible-backlog-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnections(n: number, connectorId = "c1"): string[] {
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

function readDirtyCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM connector_summary_evidence WHERE dirty <> 0").get() as {
    n: number;
  };
  return row.n;
}

test(
  "eligibleBacklog reports the REAL dirty COUNT(*) from the store, read once before either tranche runs",
  withTempDb(async () => {
    const ids = seedConnections(10);
    // Establish baseline evidence rows (clean).
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });
    assert.equal(readDirtyCount(), 0, "precondition: nothing dirty after the baseline sweep");

    for (const id of ids.slice(0, 4)) {
      // biome-ignore lint/performance/noAwaitInLoops: Deterministic seeding order.
      await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "test" });
    }
    assert.equal(readDirtyCount(), 4, "precondition: exactly 4 rows marked dirty via the real store");

    const round = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      maxDurationMs: 60_000,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });

    // The round observed the backlog BEFORE repairing it — 4 is the honest
    // count taken at round entry, matching what the DB held at that moment.
    assert.equal(round.eligibleBacklog, 4, "eligibleBacklog reflects the real store's dirty count at round entry");
    assert.equal(readDirtyCount(), 0, "the round's own repair converged all 4 rows (sanity: repair actually ran)");
  })
);

test(
  "REAL INCIDENT SHAPE: eligibleBacklog stays flat across rounds when rows are repaired but immediately re-dirtied",
  withTempDb(async () => {
    const ids = seedConnections(20);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });

    const stuck = ids.slice(0, 8);
    const observedBacklogs: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      // Re-dirty the SAME 8 rows every round, simulating a source that keeps
      // invalidating them faster than the sweep's cadence converges them —
      // the real production shape (backlog pinned at 8 rows for many
      // minutes while individual repairs succeeded).
      for (const id of stuck) {
        // biome-ignore lint/performance/noAwaitInLoops: Deterministic re-dirtying between rounds.
        await markConnectorSummaryEvidenceDirty({ connectorInstanceId: id, reason: "sustained re-dirty" });
      }
      const result = await runBoundedSummaryEvidenceSweep({
        afterId: null,
        maxDurationMs: 60_000,
        maxPages: 1,
        pageSize: PRODUCTION_PAGE_SIZE,
      });
      observedBacklogs.push(result.eligibleBacklog);
    }

    // Every round observed the SAME 8-row backlog at entry, even though each
    // round's own repair phase genuinely converged those rows (proven by the
    // next round needing to re-dirty them again to reproduce the shape) —
    // exactly the real incident: `eligibleBacklog` alone cannot tell "stuck"
    // from "actively repairing," which is why the no-progress counter
    // requires several CONSECUTIVE flat observations, not a single one.
    assert.deepEqual(observedBacklogs, [8, 8, 8, 8], "the backlog is flat every round despite real repair work");
  })
);

test(
  "eligibleBacklog is read via the same store method regardless of firstTranche order (walk-first vs acceleration-first)",
  withTempDb(async () => {
    const [target] = seedConnections(5);
    await runBoundedSummaryEvidenceSweep({ maxDurationMs: 60_000, pageSize: PRODUCTION_PAGE_SIZE });
    assert.ok(target);
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "test" });

    const walkFirst = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      firstTranche: "walk",
      maxDurationMs: 60_000,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });
    assert.equal(walkFirst.eligibleBacklog, 1, "walk-first round reports the same real backlog count");

    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: target, reason: "test again" });
    const accelerationFirst = await runBoundedSummaryEvidenceSweep({
      afterId: null,
      firstTranche: "acceleration",
      maxDurationMs: 60_000,
      maxPages: 1,
      pageSize: PRODUCTION_PAGE_SIZE,
    });
    assert.equal(
      accelerationFirst.eligibleBacklog,
      1,
      "acceleration-first round also reports the real backlog count — the read happens once, before either tranche"
    );
  })
);
