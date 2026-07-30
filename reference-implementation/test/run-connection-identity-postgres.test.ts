// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent, listSpineCorrelations, listSpineEventsPage } from "../lib/spine.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const EVENT_ID = "evt_run_connection_identity_postgres";
const HISTORICAL_EVENT_ID = "evt_run_connection_identity_historical_postgres";
const CONNECTOR_INSTANCE_ID = "cin_run_connection_identity_postgres";
const RE_UNBOUND_RUN_START_WRITER = /new run\.started events require data\.connector_instance_id/;

test("Postgres preserves new run identity and rejects an unbound writer", { skip: !POSTGRES_URL }, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await postgresQuery("DELETE FROM spine_events WHERE event_id = $1", [EVENT_ID]);
    await assert.rejects(
      () =>
        emitSpineEvent({
          actor_id: "test_connector",
          actor_type: "runtime",
          data: {},
          event_type: "run.started",
          object_id: "run_unbound_postgres",
          object_type: "run",
          run_id: "run_unbound_postgres",
        }),
      RE_UNBOUND_RUN_START_WRITER
    );

    await emitSpineEvent({
      actor_id: "test_connector",
      actor_type: "runtime",
      data: {
        boot_epoch: "00000000-0000-4000-8000-000000000005",
        connection_id: CONNECTOR_INSTANCE_ID,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
        controller_id: "ctrl_run_connection_identity_postgres",
        seq: 1,
      },
      event_id: EVENT_ID,
      event_type: "run.started",
      object_id: "run_bound_postgres",
      object_type: "run",
      run_id: "run_bound_postgres",
    });
    const row = await postgresQuery<{ connector_instance_id: string | null }>(
      "SELECT connector_instance_id FROM spine_events WHERE event_id = $1",
      [EVENT_ID]
    );
    assert.equal(row.rows[0]?.connector_instance_id, CONNECTOR_INSTANCE_ID);

    await postgresQuery(
      `INSERT INTO spine_events(
        event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
        actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
      [
        HISTORICAL_EVENT_ID,
        "run.completed",
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
        "scn_historical",
        "trc_historical",
        "runtime",
        "legacy_connector",
        "run",
        "run_historical_postgres",
        "succeeded",
        "run_historical_postgres",
        "{}",
        "reference.spine.v1",
      ]
    );
    const timeline = await listSpineEventsPage("run", "run_historical_postgres", { limit: 10 });
    assert.equal(timeline.events.length, 1, "historical Postgres row remains visible through the public run timeline");
    const projection = (await listSpineCorrelations("run", { limit: 10, q: "run_historical_postgres" })).summaries.find(
      (summary) => summary.run_id === "run_historical_postgres"
    );
    assert.ok(projection, "historical Postgres row remains visible through the public run projection");
    assert.equal(projection.connection_id, undefined, "Postgres projection must not invent a connection identity");
    assert.equal(projection.connector_instance_id, undefined, "Postgres projection keeps historical identity unknown");
  } finally {
    await postgresQuery("DELETE FROM spine_events WHERE event_id IN ($1, $2)", [EVENT_ID, HISTORICAL_EVENT_ID]).catch(
      () => undefined
    );
    await closePostgresStorage();
  }
});
