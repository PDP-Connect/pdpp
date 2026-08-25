// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL parity proof for `updateSourceBindingPatch`. The SQLite
 * backend is exercised in `acknowledged-loss-store.test.ts`; this file
 * proves the same stamp-without-status-change, merge-not-clobber contract
 * against the real Postgres path (`createPostgresConnectorInstanceStore`),
 * whose write uses the jsonb `||` merge operator rather than SQLite's
 * `json_patch` — the two backends must agree on observable behavior even
 * though the SQL dialect differs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { acknowledgedLossStatement, readAcknowledgedLoss } from "../runtime/acknowledged-loss.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset";

const NOW = "2026-08-23T20:00:00.000Z";
const CONNECTOR_ID = "heb_ackloss_pg";
const CONNECTOR_INSTANCE_ID = "cin_ackloss_pg";

const HEB_PURGE = {
  acknowledgedAt: "2026-08-21T00:00:00.000Z",
  acknowledgedBy: "Tim Nunamaker",
  cause: "provider_deleted_upstream",
  note: "H-E-B purged the order history; heb.com no longer shows those orders.",
  scope: "total",
} as const;

function storageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

async function cleanup(): Promise<void> {
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function seedConnection(): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({ connector_id: CONNECTOR_ID }),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at
     ) VALUES ($1, 'owner_local', $2, 'HEB - tnunamak@gmail.com', 'active',
       'account', 'acknowledged-loss-test-pg', $3::jsonb, $4, $4)`,
    [CONNECTOR_INSTANCE_ID, CONNECTOR_ID, JSON.stringify({ kind: "account", local_binding_name: "primary" }), NOW]
  );
}

test("real PostgreSQL: stamping an acknowledgement merges the key without clobbering sibling keys or changing status", {
  skip: POSTGRES_SKIP,
}, async () => {
  await initPostgresStorage(storageConfig());
  try {
    await cleanup();
    await seedConnection();
    const store = createPostgresConnectorInstanceStore();

    // Before stamping there is nothing to read -- and nothing is inferred.
    assert.equal(readAcknowledgedLoss((await store.get(CONNECTOR_INSTANCE_ID))?.sourceBinding), null);

    const updated = await store.updateSourceBindingPatch(CONNECTOR_INSTANCE_ID, {
      sourceBindingPatch: { acknowledged_loss: HEB_PURGE },
      updatedAt: NOW,
    });
    assert.ok(updated);

    const row = await store.get(CONNECTOR_INSTANCE_ID);
    assert.ok(row);

    // An acknowledged permanent loss is NOT a revocation: the source keeps
    // whatever it holds and keeps collecting anything still reachable.
    assert.equal(row.status, "active");

    // The jsonb `||` merge preserved the pre-existing binding identity keys
    // instead of clobbering them.
    const binding = row.sourceBinding as Record<string, unknown>;
    assert.equal(binding.kind, "account");
    assert.equal(binding.local_binding_name, "primary");

    const reread = readAcknowledgedLoss(binding);
    assert.ok(reread, "the acknowledgement must round-trip through real Postgres jsonb");
    assert.equal(reread.acknowledgedBy, "Tim Nunamaker");
    assert.equal(reread.acknowledgedAt, "2026-08-21T00:00:00.000Z");
    assert.equal(reread.cause, "provider_deleted_upstream");
    assert.equal(
      acknowledgedLossStatement(reread),
      "Provider deleted this data upstream — owner-confirmed 2026-08-21. H-E-B purged the order history; heb.com no longer shows those orders."
    );

    // The write is durable in the real table, not just process-local state.
    const { rows } = await postgresQuery<{ source_binding_json: Record<string, unknown>; status: string }>(
      "SELECT source_binding_json, status FROM connector_instances WHERE connector_instance_id = $1",
      [CONNECTOR_INSTANCE_ID]
    );
    const [dbRow] = rows;
    assert.ok(dbRow);
    assert.equal(dbRow.status, "active");
    assert.equal(dbRow.source_binding_json.kind, "account");
    assert.equal(dbRow.source_binding_json.local_binding_name, "primary");
    assert.ok(dbRow.source_binding_json.acknowledged_loss);
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});
