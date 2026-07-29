// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresSourceWebhookEventStore,
  createSqliteSourceWebhookEventStore,
  type SourceWebhookEventStore,
} from "../server/stores/source-webhook-event-store.ts";

const CLAIM = {
  bodyHash: "hash_1",
  eventId: "evt_1",
  receivedAt: "2026-05-15T12:00:00.000Z",
  sourceId: "spotify",
};

async function assertClaimDedupe(store: SourceWebhookEventStore): Promise<void> {
  assert.equal(await store.claimEvent(CLAIM), true);
  assert.equal(
    await store.claimEvent({
      ...CLAIM,
      bodyHash: "hash_2",
      receivedAt: "2026-05-15T12:01:00.000Z",
    }),
    false
  );
  assert.equal(await store.claimEvent({ ...CLAIM, eventId: "evt_2" }), true);
}

test("SQLite SourceWebhookEventStore claims each source event once", async () => {
  initDb();
  try {
    await assertClaimDedupe(createSqliteSourceWebhookEventStore());
  } finally {
    closeDb();
  }
});

test("Postgres SourceWebhookEventStore claims each source event once when PDPP_TEST_POSTGRES_URL is set", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await postgresQuery("DELETE FROM source_webhook_events WHERE source_id = $1", [CLAIM.sourceId]);
    await assertClaimDedupe(createPostgresSourceWebhookEventStore());
  } finally {
    await postgresQuery("DELETE FROM source_webhook_events WHERE source_id = $1", [CLAIM.sourceId]);
    await closePostgresStorage();
  }
});
