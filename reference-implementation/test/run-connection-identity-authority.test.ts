// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import Database from "better-sqlite3";
import { emitSpineEvent, listSpineCorrelations, listSpineEventsPage } from "../lib/spine.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const RUN_START_WRITERS = [
  { eventType: "run.started", name: "manual", stamp: { boot_epoch: "boot-manual", seq: 1 } },
  { eventType: "run.started", name: "scheduler", stamp: { boot_epoch: "boot-scheduler", seq: 1 } },
] as const;
const RE_UNBOUND_RUN_START_WRITER = /new run\.started events require data\.connector_instance_id/;
const RE_ADMITTED_RUN_CONNECTION_REQUIRED = /admitted run connection is required/;

function eventFor(writer: (typeof RUN_START_WRITERS)[number], connectorInstanceId?: string) {
  return {
    actor_id: "test_connector",
    actor_type: "runtime",
    data: {
      ...writer.stamp,
      ...(connectorInstanceId
        ? { connection_id: connectorInstanceId, connector_instance_id: connectorInstanceId }
        : {}),
      source: { id: "test_connector", kind: "connector" },
    },
    event_id: `evt_${writer.name}_${connectorInstanceId ? "bound" : "unbound"}`,
    event_type: writer.eventType,
    object_id: `run_${writer.name}`,
    object_type: "run",
    run_id: `run_${writer.name}`,
  };
}

test("run identity authority rejects every named run starter without an immutable connector instance", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-identity-authority-");
  initDb(dbPath);
  try {
    for (const writer of RUN_START_WRITERS) {
      // biome-ignore lint/performance/noAwaitInLoops: Each writer must prove its own failed-closed boundary.
      await assert.rejects(
        () => emitSpineEvent(eventFor(writer)),
        RE_UNBOUND_RUN_START_WRITER,
        `${writer.name} must not create an unbound run`
      );
    }

    for (const writer of RUN_START_WRITERS) {
      const connectorInstanceId = `cin_${writer.name.replaceAll("-", "_")}`;
      // biome-ignore lint/performance/noAwaitInLoops: Each writer must prove its own persisted identity.
      const event = await emitSpineEvent(eventFor(writer, connectorInstanceId));
      assert.ok(event, `${writer.name} event must persist once explicitly bound`);
    }
  } finally {
    closeDb();
  }
});

test("non-start run events remain compatible when they have no connection identity", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-identity-non-start-");
  initDb(dbPath);
  try {
    const event = await emitSpineEvent({
      event_type: "run.stream_session_resolved",
      object_id: "stream_session_legacy",
      object_type: "stream_session",
      run_id: "run_legacy_stream_session",
      status: "completed",
    });
    assert.equal(event?.event_type, "run.stream_session_resolved");
  } finally {
    closeDb();
  }
});

test("direct runtime rejects arbitrary and connector-type claims before any spine fact", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-identity-direct-admission-");
  initDb(dbPath);
  try {
    for (const connectorInstanceId of ["cin_arbitrary_missing", "reddit"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each hostile claim independently proves the pre-spine boundary.
      await assert.rejects(
        () =>
          runConnector({
            collectionMode: "full_refresh",
            connectorId: "reddit",
            connectorInstanceId,
            connectorPath: "/does/not/run.ts",
            manifest: { connector_id: "reddit", streams: [] },
            ownerSubjectId: "owner_alice",
            ownerToken: "test-token",
            rsUrl: "http://127.0.0.1:1",
            state: null,
          }),
        RE_ADMITTED_RUN_CONNECTION_REQUIRED
      );
    }
    const count = getDb().prepare("SELECT COUNT(*) AS count FROM spine_events").get() as {
      count: number;
    };
    assert.equal(count.count, 0, "rejected direct claims create no spine facts");
  } finally {
    closeDb();
  }
});

test("historical null spine identity remains readable and unknown", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-identity-history-");
  initDb(dbPath);
  closeDb();
  const raw = new Database(dbPath);
  let rawClosed = false;
  try {
    raw
      .prepare(
        `INSERT INTO spine_events(
        event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
        actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
    const row = raw
      .prepare("SELECT connector_instance_id FROM spine_events WHERE event_id = ?")
      .get("evt_historical_unknown") as {
      connector_instance_id: string | null;
    };
    assert.equal(row.connector_instance_id, null, "historical identity remains explicitly unknown");
    raw.close();
    rawClosed = true;
    initDb(dbPath);

    const timeline = listSpineEventsPage("run", "run_historical", { limit: 10 });
    assert.equal(timeline.events.length, 1, "historical row remains visible through the public run timeline");
    const projection = (await listSpineCorrelations("run", { limit: 10 })).summaries.find(
      (summary) => summary.run_id === "run_historical"
    );
    assert.ok(projection, "historical row remains visible through the public run projection");
    assert.equal(projection.connection_id, undefined, "run projection must not invent a connection identity");
    assert.equal(projection.connector_instance_id, undefined, "run projection keeps historical identity unknown");
  } finally {
    if (!rawClosed) {
      raw.close();
    }
    closeDb();
  }
});
