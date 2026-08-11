import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { executeSourceWebhook, type SourceWebhookDependencies } from "../operations/ref-source-webhook-ingest/index.ts";
import { createSqliteSourceWebhookEventStore } from "../server/stores/source-webhook-event-store.ts";

const NOW_MS = Date.parse("2026-08-11T18:00:00.000Z");
const SECRET = "repro_secret";
const EVENT_ID = "evt_claim_then_fail";

function signature(body: string): string {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  return `sha256=${createHmac("sha256", SECRET).update(`${EVENT_ID}.${timestamp}.${body}`).digest("hex")}`;
}

function input(body: string) {
  return {
    body,
    eventId: EVENT_ID,
    signature: signature(body),
    sourceId: "spotify",
    timestamp: String(Math.floor(NOW_MS / 1000)),
  };
}

async function assertFailureConsumesRetry(
  body: string,
  configure: (deps: SourceWebhookDependencies) => SourceWebhookDependencies,
  actionCalls: () => number
): Promise<void> {
  initDb();
  try {
    const store = createSqliteSourceWebhookEventStore();
    const defaults: SourceWebhookDependencies = {
      claimEvent: (event) => store.claimEvent(event),
      ingestRecords: async () => ({ errors: [], records_accepted: 1, records_rejected: 0, stream: "messages" }),
      nowMs: () => NOW_MS,
      resolveSecret: () => SECRET,
      signalScheduler: () => undefined,
    };
    const deps = configure(defaults);

    await assert.rejects(() => executeSourceWebhook(input(body), deps), /injected downstream failure/);
    assert.equal(actionCalls(), 1, "the failing downstream action ran once");

    const retry = await executeSourceWebhook(input(body), deps);
    assert.deepEqual(retry, {
      accepted: true,
      duplicate: true,
      event_id: EVENT_ID,
      source_id: "spotify",
    });
    assert.equal(actionCalls(), 1, "the accepted retry never invokes the downstream action");
  } finally {
    closeDb();
  }
}

test("repro: a failed ingest permanently consumes the source webhook event id", async () => {
  let ingestCalls = 0;
  await assertFailureConsumesRetry(
    JSON.stringify({ action: "ingest_records", records: [{ id: "r1" }], stream: "messages" }),
    (defaults) => ({
      ...defaults,
      ingestRecords: async () => {
        ingestCalls += 1;
        throw new Error("injected downstream failure");
      },
    }),
    () => ingestCalls
  );
});

test("repro: a failed run request permanently consumes the source webhook event id", async () => {
  let runCalls = 0;
  await assertFailureConsumesRetry(
    JSON.stringify({ action: "schedule_run" }),
    (defaults) => ({
      ...defaults,
      requestRun: async () => {
        runCalls += 1;
        throw new Error("injected downstream failure");
      },
    }),
    () => runCalls
  );
});
