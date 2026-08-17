// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyDatasetSummaryRecordDelta,
  getDatasetSummaryProjection,
  rebuildDatasetSummaryProjection,
} from "../server/dataset-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-starvation-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * Reproduces the owner's live-instance shape: a continuously-collecting
 * dataset where every single rebuild attempt observes at least one
 * concurrent record delta before it can commit. A rebuild that only ever
 * makes one attempt per invocation can never converge under this load —
 * exactly what the owner's instance shows (`computed_at: null`,
 * `rebuild_status: "running"`, empty stream projection, >24h stale).
 *
 * This test drives deltas mid-rebuild on every attempt so a naive
 * single-shot rebuild starves forever; a rebuild that tolerates and
 * retries past sustained concurrent writes must still converge to a
 * fresh, non-empty projection.
 */
test("rebuild converges under sustained concurrent deltas instead of starving forever", async () =>
  withTempDb(async () => {
    let attempts = 0;
    const maxAttemptsToObserve = 5;

    const result = await rebuildDatasetSummaryProjection({
      getCounts: () => {
        attempts += 1;
        if (attempts <= maxAttemptsToObserve) {
          // A live delta lands mid-rebuild on every attempt, the way a
          // continuously-collecting instance would deliver one before
          // any single rebuild pass can finish.
          applyDatasetSummaryRecordDelta({
            connectorId: "gmail",
            consentTimeField: null,
            dirtyRecordTimeBounds: false,
            emittedAt: "2026-01-01T00:00:00.000Z",
            recordChangesJsonBytesDelta: 0,
            recordCountDelta: 1,
            recordJsonBytesDelta: 10,
            stream: "messages",
          });
        }
        return { connector_count: 1, record_count: 1, stream_count: 1 };
      },
      getIngestedTimeBounds: () => ({
        earliest: "2026-01-01T00:00:00.000Z",
        latest: "2026-01-01T00:00:00.000Z",
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 10,
      }),
      listStreamProjectionSeeds: () => [
        {
          connector_id: "gmail",
          record_count: 1,
          record_json_bytes: 10,
          stream: "messages",
        },
      ],
      listTopConnectorCandidates: () => [{ connector_id: "gmail", record_count: 1 }],
    });

    assert.ok(attempts > 1, "expected the rebuild to retry past a concurrent delta rather than give up after one shot");

    // The rebuild must have actually converged: fresh, computed, and not
    // stuck reporting rebuild_status "running" forever.
    assert.equal(result.metadata.state, "fresh");
    assert.equal(result.metadata.rebuild_status, "idle");
    assert.ok(result.metadata.computed_at, "expected computed_at to be set on convergence");

    const persisted = getDatasetSummaryProjection();
    assert.equal(persisted.metadata.state, "fresh");
    assert.equal(persisted.metadata.rebuild_status, "idle");
    assert.ok(persisted.metadata.computed_at);
    // The stream projection must not be left empty the way the owner's
    // live instance shows -- convergence means the seeds actually landed.
    const streamCount = getDb().prepare("SELECT COUNT(*) AS c FROM dataset_summary_stream_projection").get<{
      c: number;
    }>();
    assert.ok(Number(streamCount?.c || 0) > 0, "expected stream projection rows to be populated on convergence");
  }));

/**
 * Reproduces the "crashed rebuild holding a stale lock" alternative
 * explanation named in the task: rebuild_status is stamped "running" and
 * the process that stamped it never returns (crash, kill, hard restart)
 * before it can write terminal metadata. Nothing should honor that lease
 * forever -- a sufficiently old "running" stamp must not block a fresh
 * rebuild attempt from proceeding.
 */
test("a stale running lease past its timeout does not block a fresh rebuild", async () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 0, record_count: 0, stream_count: 0 }),
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 0,
      }),
      listStreamProjectionSeeds: () => [],
      listTopConnectorCandidates: () => [],
    });

    // Simulate a crashed rebuild: rebuild_status stamped "running" long
    // ago, with no process left alive to ever resolve it.
    const ancientStaleSince = "2020-01-01T00:00:00.000Z";
    getDb()
      .prepare(
        `UPDATE dataset_summary_projection
            SET metadata_json = json_set(metadata_json, '$.rebuild_status', 'running', '$.stale_since', ?)
          WHERE projection_key = 'global'`
      )
      .run(ancientStaleSince);

    const stuck = getDatasetSummaryProjection();
    assert.equal(stuck.metadata.rebuild_status, "running");

    // A delta arriving against this ancient lease must not be fenced
    // forever -- the lease is expired, so normal delta application must
    // proceed rather than perpetually deferring to a dead rebuild.
    applyDatasetSummaryRecordDelta({
      connectorId: "gmail",
      consentTimeField: null,
      dirtyRecordTimeBounds: false,
      emittedAt: "2026-01-01T00:00:00.000Z",
      recordChangesJsonBytesDelta: 0,
      recordCountDelta: 1,
      recordJsonBytesDelta: 10,
      stream: "messages",
    });

    const afterDelta = getDatasetSummaryProjection();
    assert.notEqual(
      afterDelta.metadata.rebuild_status,
      "running",
      "an expired rebuild lease must not persist as running forever"
    );
  }));
