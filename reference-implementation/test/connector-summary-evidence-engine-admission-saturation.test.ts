// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live symptom (2026-07-31): a connection with fully current canonical
 * records/facts gets its `connector_summary_evidence` permanently stuck
 * dirty=1, state=failed, reason `repair_lock_unavailable`, purely because
 * ordinary connector-instance ingest writers have saturated the bounded
 * ingest writer-admission gate (`connector-instance-write-coordinator.ts`'s
 * `activeLimit()`/`queueLimit()`). The periodic maintenance sweep
 * (`runBoundedSummaryEvidenceSweep` / `reconcileConnectorSummaryEvidence`)
 * re-attempts the SAME admission-gated write every ~60s tick forever,
 * because `repairCandidate` routes summary-evidence repair through
 * `withConnectorInstanceWrite` — the exact same scarce ingest slot ordinary
 * writers are holding — rather than through the control-plane path
 * (`withConnectorInstanceControlPlaneWrite`) the coordinator already
 * exposes for maintenance-class work that must not starve behind bulk
 * ingest (see its own doc comment: "without consuming an ingest writer-
 * admission slot ... allowing enrollment to proceed when unrelated bulk
 * ingest has saturated the bounded data-plane admission gate").
 *
 * This never converges on its own: nothing ever releases the ingest slot
 * from the repair side, and ordinary ingest volume is exactly the kind of
 * thing that can stay saturated indefinitely under real fleet load.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const NOW = "2026-07-17T00:00:00.000Z";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-admission-saturation-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

async function withCoordinatorEnvironment<T>(
  values: Record<string, string | number>,
  operation: () => Promise<T>
): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = String(value);
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function seedConnection(connectorInstanceId: string): void {
  getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('c1', '{}', ?)").run(NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', 'c1', 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, connectorInstanceId, NOW, NOW);
}

test("summary-evidence repair does not starve permanently while ordinary ingest saturates the writer-admission gate", () =>
  withTempDb(() =>
    withCoordinatorEnvironment(
      { PDPP_INGEST_ACTIVE_BATCH_LIMIT: 1, PDPP_INGEST_ADMISSION_QUEUE_LIMIT: 0, PDPP_INGEST_LOCK_WAIT_MS: 20 },
      async () => {
        seedConnection("cin_saturated");

        // Occupy the one ingest admission slot with an unrelated in-flight
        // ordinary writer for the whole test — exactly the live symptom's
        // "connector-instance writer admission is saturated" condition,
        // sustained across every maintenance tick, not a one-shot race.
        const heldWriter = deferred();
        const occupyingWrite = withConnectorInstanceWrite("cin_other_ingest", () => heldWriter.promise);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          assert.equal(connectorInstanceWriteCoordinatorStatsForTests().activeWriters, 1, "the gate is now saturated");

          // Three consecutive maintenance ticks, matching the live ~60s
          // periodic reconcile: candidates_inspected > 0, but genuinely
          // healthy evidence must repair despite the sustained saturation.
          for (let tick = 0; tick < 3; tick += 1) {
            // biome-ignore lint/performance/noAwaitInLoops: Ticks must run sequentially to prove convergence across successive maintenance cycles.
            const result = await reconcileConnectorSummaryEvidence(null);
            assert.equal(result.candidatesInspected, 1, `tick ${tick}: discovery still sees the one candidate`);
          }

          const row = getDb()
            .prepare("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = ?")
            .get("cin_saturated") as Record<string, unknown> | undefined;
          assert.ok(row, "an evidence row exists after three ticks");
          assert.notEqual(
            row.state,
            "failed",
            "a genuinely healthy connection's evidence must not stay permanently failed " +
              "solely because unrelated ordinary ingest occupies the ingest writer-admission gate"
          );
          assert.notEqual(
            row.last_error,
            "connector-instance writer admission is saturated",
            "repair must not surface unrelated ingest saturation as its own failure reason"
          );
          assert.notEqual(
            row.record_snapshot_reason_code,
            "repair_lock_unavailable",
            "repair must not be starved behind ordinary ingest's writer-admission slot"
          );
        } finally {
          heldWriter.resolve();
          await occupyingWrite;
        }
      }
    )
  ));
