// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const EVENT_ID = "evt_run_connection_identity_postgres";
const CONNECTOR_INSTANCE_ID = "cin_run_connection_identity_postgres";

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
          event_type: "run.completed",
          object_id: "run_unbound_postgres",
          object_type: "run",
          run_id: "run_unbound_postgres",
        }),
      /new run\.\* events require data\.connector_instance_id/
    );

    await emitSpineEvent({
      actor_id: "test_connector",
      actor_type: "runtime",
      data: {
        connection_id: CONNECTOR_INSTANCE_ID,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
      },
      event_id: EVENT_ID,
      event_type: "run.completed",
      object_id: "run_bound_postgres",
      object_type: "run",
      run_id: "run_bound_postgres",
    });
    const row = await postgresQuery<{ connector_instance_id: string | null }>(
      "SELECT connector_instance_id FROM spine_events WHERE event_id = $1",
      [EVENT_ID]
    );
    assert.equal(row.rows[0]?.connector_instance_id, CONNECTOR_INSTANCE_ID);
  } finally {
    await postgresQuery("DELETE FROM spine_events WHERE event_id = $1", [EVENT_ID]).catch(() => undefined);
    await closePostgresStorage();
  }
});
