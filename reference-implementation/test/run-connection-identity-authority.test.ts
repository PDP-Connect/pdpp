// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import Database from "better-sqlite3";
import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const RUN_WRITERS = [
  { eventType: "run.started", name: "manual", stamp: { boot_epoch: "boot-manual", seq: 1 } },
  { eventType: "run.started", name: "scheduler", stamp: { boot_epoch: "boot-scheduler", seq: 1 } },
  { eventType: "run.browser_surface_leased", name: "browser-surface", stamp: {} },
  { eventType: "run.completed", name: "local-device", stamp: {} },
  { eventType: "run.failed", name: "recovery", stamp: {} },
] as const;

function eventFor(writer: (typeof RUN_WRITERS)[number], connectorInstanceId?: string) {
  return {
    actor_id: "test_connector",
    actor_type: "runtime",
    data: {
      ...writer.stamp,
      ...(connectorInstanceId ? { connection_id: connectorInstanceId, connector_instance_id: connectorInstanceId } : {}),
      source: { id: "test_connector", kind: "connector" },
    },
    event_id: `evt_${writer.name}_${connectorInstanceId ? "bound" : "unbound"}`,
    event_type: writer.eventType,
    object_id: `run_${writer.name}`,
    object_type: "run",
    run_id: `run_${writer.name}`,
  };
}

test("run identity authority rejects every named new-run writer without an immutable connector instance", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-identity-authority-");
  initDb(dbPath);
  try {
    for (const writer of RUN_WRITERS) {
      // biome-ignore lint/performance/noAwaitInLoops: Each writer must prove its own failed-closed boundary.
      await assert.rejects(
        () => emitSpineEvent(eventFor(writer)),
        /new run\.\* events require data\.connector_instance_id/,
        `${writer.name} must not create an unbound run event`
      );
    }

    for (const writer of RUN_WRITERS) {
      const connectorInstanceId = `cin_${writer.name.replaceAll("-", "_")}`;
      // biome-ignore lint/performance/noAwaitInLoops: Each writer must prove its own persisted identity.
      const event = await emitSpineEvent(eventFor(writer, connectorInstanceId));
      assert.ok(event, `${writer.name} event must persist once explicitly bound`);
    }
  } finally {
    closeDb();
  }
});

test("historical null spine identity remains readable and unknown", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-identity-history-");
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  try {
    raw.prepare(
      `INSERT INTO spine_events(
        event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
        actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "evt_historical_unknown",
      "run.completed",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "scn_historical",
      "trc_historical",
      "runtime",
      "legacy_connector",
      "run",
      "run_historical",
      "succeeded",
      "run_historical",
      "{}",
      "reference.spine.v1"
    );
    const row = raw.prepare("SELECT connector_instance_id FROM spine_events WHERE event_id = ?").get("evt_historical_unknown") as {
      connector_instance_id: string | null;
    };
    assert.equal(row.connector_instance_id, null, "historical identity remains explicitly unknown");
  } finally {
    raw.close();
  }
});
