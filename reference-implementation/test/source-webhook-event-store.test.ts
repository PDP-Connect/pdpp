// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresSchedulerStore,
  createSqliteSchedulerStore,
  type SchedulerStore,
  type SourceWebhookRunAdmissionInput,
} from "../server/stores/scheduler-store.ts";
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

const RACE = {
  eventId: "evt_generic_claim_vs_receipt",
  sourceId: "source_generic_claim_vs_receipt",
};

function raceAdmission(): SourceWebhookRunAdmissionInput {
  return {
    active_run: {
      connector_id: "source-webhook-race",
      connector_instance_id: "cin_source_webhook_race",
      run_generation: 1,
      run_id: "run_source_webhook_race",
      scenario_id: "scn_source_webhook_race",
      started_at: "2026-08-11T00:00:00.000Z",
      trace_id: "trc_source_webhook_race",
    },
    source_event: {
      action: "schedule_run",
      automation_mode: "unattended",
      automation_summary: null,
      body_hash: "hash_source_webhook_race",
      event_id: RACE.eventId,
      owner_subject_id: "owner_source_webhook_race",
      received_at: "2026-08-11T00:00:00.000Z",
      source_id: RACE.sourceId,
    },
  };
}

async function assertGenericClaimAndReceiptAreMutuallyExclusive(input: {
  countReceipts: () => Promise<number>;
  eventStore: SourceWebhookEventStore;
  schedulerStore: SchedulerStore;
}): Promise<void> {
  const admission = input.schedulerStore.admitSourceWebhookRun;
  assert.ok(admission, "real scheduler store exposes atomic source-webhook admission");
  const [claimWon, receiptOutcome] = await Promise.all([
    input.eventStore.claimEvent({
      bodyHash: raceAdmission().source_event.body_hash,
      eventId: RACE.eventId,
      receivedAt: "2026-08-11T00:00:00.000Z",
      sourceId: RACE.sourceId,
    }),
    admission(raceAdmission()),
  ]);
  assert.equal((await input.countReceipts()) > 0, receiptOutcome.kind === "admitted");
  assert.equal(claimWon, receiptOutcome.kind === "generic_claim_exists");
  assert.ok(
    receiptOutcome.kind === "admitted" || receiptOutcome.kind === "generic_claim_exists",
    "one durable namespace must choose exactly generic claim or receipt admission"
  );
}

test("SQLite SourceWebhookEventStore claims each source event once", async () => {
  initDb();
  try {
    await assertClaimDedupe(createSqliteSourceWebhookEventStore());
  } finally {
    closeDb();
  }
});

test("SQLite source-webhook generic claim and receipt admission share one atomic identity", async () => {
  initDb();
  try {
    await assertGenericClaimAndReceiptAreMutuallyExclusive({
      countReceipts: async () =>
        Number(
          (
            getDb()
              .prepare("SELECT COUNT(*) AS count FROM source_webhook_run_receipts WHERE source_id = ?")
              .get(RACE.sourceId) as { count: number }
          ).count
        ),
      eventStore: createSqliteSourceWebhookEventStore(),
      schedulerStore: createSqliteSchedulerStore(),
    });
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

test("Postgres source-webhook generic claim and receipt admission share one atomic identity", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await postgresQuery("DELETE FROM source_webhook_run_receipts WHERE source_id = $1", [RACE.sourceId]);
    await postgresQuery("DELETE FROM source_webhook_events WHERE source_id = $1", [RACE.sourceId]);
    await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1", [
      "cin_source_webhook_race",
    ]);
    await assertGenericClaimAndReceiptAreMutuallyExclusive({
      countReceipts: async () => {
        const result = await postgresQuery<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM source_webhook_run_receipts WHERE source_id = $1",
          [RACE.sourceId]
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      eventStore: createPostgresSourceWebhookEventStore(),
      schedulerStore: createPostgresSchedulerStore(),
    });
  } finally {
    await postgresQuery("DELETE FROM source_webhook_run_receipts WHERE source_id = $1", [RACE.sourceId]);
    await postgresQuery("DELETE FROM source_webhook_events WHERE source_id = $1", [RACE.sourceId]);
    await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1", [
      "cin_source_webhook_race",
    ]);
    await closePostgresStorage();
  }
});
