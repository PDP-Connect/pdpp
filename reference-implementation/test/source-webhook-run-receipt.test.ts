// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __resetControllerInteractionStateForTests,
  ControllerError,
  createController,
  type SourceWebhookRunEvent,
} from "../runtime/controller.ts";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresSchedulerStore,
  createSqliteSchedulerStore,
  type SchedulerStore,
} from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "source-webhook-receipt-test";
const CONNECTOR_ALIAS = "source-webhook-receipt-test-legacy-alias";
const CONNECTOR_INSTANCE_ID = "cin_source_webhook_receipt_test";
const OWNER_SUBJECT_ID = "owner_source_webhook_receipt_test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Source Webhook Receipt Test",
  streams: [],
  version: "1.0.0",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sourceEvent(prefix: string, overrides: Partial<SourceWebhookRunEvent> = {}): SourceWebhookRunEvent {
  return {
    action: "schedule_run",
    bodyHash: `${prefix}_body_hash`,
    eventId: `${prefix}_event`,
    receivedAt: "2026-08-11T00:00:00.000Z",
    sourceId: `${prefix}_source`,
    ...overrides,
  };
}

function runOptions(
  event: SourceWebhookRunEvent,
  runId: string,
  overrides: { readonly connectorInstanceId?: string; readonly ownerSubjectId?: string } = {}
) {
  return {
    connectorInstanceId: overrides.connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
    manifest: MANIFEST,
    ownerSubjectId: overrides.ownerSubjectId ?? OWNER_SUBJECT_ID,
    ownerToken: "owner-token",
    runId,
    sourceWebhookEvent: event,
    triggerKind: "webhook" as const,
  };
}

async function eventually(assertion: () => void | Promise<void>, message: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Poll each asynchronous durable-state observation in order.
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function assertSourceWebhookReceiptOracle(input: {
  countActiveRuns: () => Promise<number>;
  countReceipts: () => Promise<number>;
  schedulerStore: SchedulerStore;
  sourcePrefix: string;
}): Promise<void> {
  const runCompletion = deferred<RuntimeRunConnectorResult>();
  const runStarted = deferred<void>();
  let runCalls = 0;
  const createReceiptController = () =>
    createController({
      admitRunConnection: ({ connectorId, connectorInstanceId }) => {
        assert.equal(connectorId, CONNECTOR_ALIAS, "admission must receive the caller's legacy connector alias");
        return Promise.resolve({
          connectorId: CONNECTOR_ID,
          connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
        });
      },
      connectorPathResolver: () => "/tmp/source-webhook-receipt-test-connector.mjs",
      logger: { error: () => undefined, warn: () => undefined },
      maxRunWallClockMs: Number.POSITIVE_INFINITY,
      runConnectorImpl: () => {
        runCalls += 1;
        runStarted.resolve();
        return runCompletion.promise;
      },
      schedulerStore: input.schedulerStore,
    });
  const controller = createReceiptController();

  const event = sourceEvent(input.sourcePrefix);
  const first = await controller.runNow(CONNECTOR_ALIAS, runOptions(event, `${input.sourcePrefix}_run_original`));
  await runStarted.promise;
  assert.equal(first.status, "started");
  assert.equal(await input.countReceipts(), 1, "the first request must leave one durable dispatch receipt");
  assert.equal(await input.countActiveRuns(), 1, "the first request must leave one durable active-run admission");
  const getReceipt = input.schedulerStore.getSourceWebhookRunReceipt;
  assert.ok(getReceipt, "real scheduler store exposes the durable source-webhook receipt");
  const receipt = await getReceipt(event.sourceId, event.eventId);
  assert.ok(receipt);

  const replay = await controller.runNow(CONNECTOR_ALIAS, runOptions(event, `${input.sourcePrefix}_run_retry`));
  assert.equal(replay.run_id, first.run_id, "ambiguous response retry must return the original run handle");
  assert.equal(replay.trace_id, first.trace_id, "ambiguous response retry must return the original trace handle");
  assert.deepEqual(
    {
      action: receipt.action,
      body_hash: receipt.body_hash,
      connector_id: receipt.connector_id,
      connector_instance_id: receipt.connector_instance_id,
      owner_subject_id: receipt.owner_subject_id,
    },
    {
      action: "schedule_run",
      body_hash: event.bodyHash,
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      owner_subject_id: OWNER_SUBJECT_ID,
    },
    "receipt must bind the authenticated body and resolved dispatch identity"
  );
  assert.equal(runCalls, 1, "same source event must not invoke a second connector run");
  assert.equal(await input.countReceipts(), 1, "same source event must not create a second receipt");
  assert.equal(await input.countActiveRuns(), 1, "same source event must not create a second durable admission row");

  await assert.rejects(
    () =>
      controller.runNow(
        CONNECTOR_ALIAS,
        runOptions(
          sourceEvent(input.sourcePrefix, { bodyHash: `${input.sourcePrefix}_different_body_hash` }),
          "run_conflict"
        )
      ),
    (err: unknown) => {
      assert.ok(err instanceof ControllerError);
      assert.equal(err.code, "source_webhook_event_conflict");
      return true;
    }
  );
  assert.equal(await input.countReceipts(), 1, "body-hash conflict must not create another receipt");
  assert.equal(await input.countActiveRuns(), 1, "body-hash conflict must not create another admission row");

  await assert.rejects(
    () =>
      controller.runNow(
        CONNECTOR_ALIAS,
        runOptions(event, "run_owner_conflict", { ownerSubjectId: "owner_source_webhook_receipt_other" })
      ),
    (err: unknown) => {
      assert.ok(err instanceof ControllerError);
      assert.equal(err.code, "source_webhook_event_conflict");
      return true;
    }
  );
  await assert.rejects(
    () =>
      controller.runNow(
        CONNECTOR_ALIAS,
        runOptions(event, "run_instance_conflict", { connectorInstanceId: "cin_source_webhook_receipt_other" })
      ),
    (err: unknown) => {
      assert.ok(err instanceof ControllerError);
      assert.equal(err.code, "source_webhook_event_conflict");
      return true;
    }
  );
  assert.equal(await input.countReceipts(), 1, "resolved identity conflicts must not create another receipt");
  assert.equal(await input.countActiveRuns(), 1, "resolved identity conflicts must not create another admission row");

  await assert.rejects(
    () => controller.runNow(CONNECTOR_ALIAS, runOptions(sourceEvent(`${input.sourcePrefix}_other`), "run_other_event")),
    (err: unknown) => {
      assert.ok(err instanceof ControllerError);
      assert.equal(err.code, "run_already_active");
      return true;
    }
  );
  assert.equal(
    await input.countReceipts(),
    1,
    "active-run collision must roll back its fresh receipt rather than leaving an orphan dispatch result"
  );
  assert.equal(
    await input.countActiveRuns(),
    1,
    "active-run collision must preserve the incumbent durable admission row"
  );

  runCompletion.resolve({ records_emitted: 0, status: "succeeded" });
  await controller.drainActiveRuns(1000);
  await eventually(
    async () => assert.equal(await input.countActiveRuns(), 0),
    "terminal run did not clear active-run row"
  );

  // A new controller proves the replay comes from the durable receipt, not
  // from activeRuns or another in-process test seam.
  __resetControllerInteractionStateForTests();
  const restartedController = createReceiptController();
  const terminalReplay = await restartedController.runNow(
    CONNECTOR_ALIAS,
    runOptions(event, `${input.sourcePrefix}_run_after_terminal`)
  );
  assert.equal(terminalReplay.run_id, first.run_id, "post-terminal retry must recover the original run handle");
  assert.equal(terminalReplay.trace_id, first.trace_id, "post-terminal retry must recover the original trace handle");
  assert.equal(runCalls, 1, "post-terminal retry must not invoke a second connector run");
  assert.equal(await input.countReceipts(), 1, "post-terminal retry must retain exactly one dispatch receipt");
  assert.equal(await input.countActiveRuns(), 0, "post-terminal retry must not recreate an active-run admission row");
}

test("SQLite source-webhook controller receipt canonicalizes an alias across response loss and terminal cleanup", async (t) => {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-source-webhook-run-receipt-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  await assertSourceWebhookReceiptOracle({
    countActiveRuns: async () =>
      Number(
        getDb().prepare("SELECT COUNT(*) AS count FROM controller_active_runs").get<{ count: number }>()?.count ?? 0
      ),
    countReceipts: async () =>
      Number(
        getDb().prepare("SELECT COUNT(*) AS count FROM source_webhook_run_receipts").get<{ count: number }>()?.count ??
          0
      ),
    schedulerStore: createSqliteSchedulerStore(),
    sourcePrefix: "sqlite_source_webhook_receipt",
  });
});

test("Postgres source-webhook controller receipt canonicalizes an alias across response loss and terminal cleanup", {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async (t) => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  const sourceIdPrefix = "pg_source_webhook_receipt";
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  __resetControllerInteractionStateForTests();
  t.after(async () => {
    __resetControllerInteractionStateForTests();
    await postgresQuery("DELETE FROM source_webhook_run_receipts WHERE source_id LIKE $1", [`${sourceIdPrefix}%`]);
    await postgresQuery("DELETE FROM source_webhook_events WHERE source_id LIKE $1", [`${sourceIdPrefix}%`]);
    await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
    await closePostgresStorage();
  });

  await postgresQuery("DELETE FROM source_webhook_run_receipts WHERE source_id LIKE $1", [`${sourceIdPrefix}%`]);
  await postgresQuery("DELETE FROM source_webhook_events WHERE source_id LIKE $1", [`${sourceIdPrefix}%`]);
  await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
  await assertSourceWebhookReceiptOracle({
    countActiveRuns: async () => {
      const result = await postgresQuery(
        "SELECT COUNT(*)::integer AS count FROM controller_active_runs WHERE connector_instance_id = $1",
        [CONNECTOR_INSTANCE_ID]
      );
      return Number((result.rows[0] as { count: number }).count);
    },
    countReceipts: async () => {
      const result = await postgresQuery(
        "SELECT COUNT(*)::integer AS count FROM source_webhook_run_receipts WHERE source_id LIKE $1",
        [`${sourceIdPrefix}%`]
      );
      return Number((result.rows[0] as { count: number }).count);
    },
    schedulerStore: createPostgresSchedulerStore(),
    sourcePrefix: sourceIdPrefix,
  });
});
