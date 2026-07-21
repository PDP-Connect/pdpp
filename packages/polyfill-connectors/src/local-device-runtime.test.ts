// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IngestBatchRequest } from "./local-device-client.ts";
import { LocalDeviceQueue } from "./local-device-queue.ts";
import {
  AMAZON_CONNECTOR_ID,
  buildCodexStartMessage,
  buildLocalDeviceStartMessage,
  CLAUDE_CODE_CONNECTOR_ID,
  CODEX_CONNECTOR_ID,
  DEFAULT_AMAZON_STREAMS,
  drainLocalDeviceQueue,
  LOCAL_DEVICE_CONNECTOR_PROFILES,
  resolveLocalDeviceConnectorProfile,
  transformRecordsToLocalDeviceEnvelopes,
} from "./local-device-runtime.ts";

test("transformRecordsToLocalDeviceEnvelopes converts only RECORD messages", () => {
  const envelopes = transformRecordsToLocalDeviceEnvelopes({
    batchId: "batch-1",
    batchSeq: 1,
    deviceId: "device-1",
    messages: [
      { message: "working", type: "PROGRESS" },
      {
        data: { id: "message-1", text: "hello" },
        emitted_at: "2026-04-30T12:00:00.000Z",
        key: "message-1",
        stream: "messages",
        type: "RECORD",
      },
      { records_emitted: 1, status: "succeeded", type: "DONE" },
    ],
    sourceInstanceId: "source-1",
  });

  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]?.connector_id, CODEX_CONNECTOR_ID);
  assert.equal(envelopes[0]?.device_id, "device-1");
  assert.equal(envelopes[0]?.source_instance_id, "source-1");
  assert.equal(envelopes[0]?.stream, "messages");
});

test("drainLocalDeviceQueue marks sent batches and preserves retryable failures", async () => {
  const queue = new LocalDeviceQueue({
    path: await tempQueuePath(),
    retryBackoffMs: () => 60_000,
  });
  const record = transformRecordsToLocalDeviceEnvelopes({
    batchId: "batch-1",
    batchSeq: 1,
    deviceId: "device-1",
    messages: [
      {
        data: { id: "message-1" },
        emitted_at: "2026-04-30T12:00:00.000Z",
        key: "message-1",
        stream: "messages",
        type: "RECORD",
      },
    ],
    sourceInstanceId: "source-1",
  });
  await queue.enqueue({ batchId: "batch-1", batchSeq: 1, records: record, sourceInstanceId: "source-1" });
  await queue.enqueue({ batchId: "batch-2", batchSeq: 2, records: record, sourceInstanceId: "source-1" });

  const sent: IngestBatchRequest[] = [];
  const client = {
    async ingestBatch(request: IngestBatchRequest): Promise<{ ok: true }> {
      await Promise.resolve();
      sent.push(request);
      if (request.batch_id === "batch-2") {
        throw new Error("temporary 503");
      }
      return { ok: true };
    },
  };

  assert.equal(await drainLocalDeviceQueue({ client, queue }), 1);
  assert.deepEqual(
    sent.map((request) => request.batch_id),
    ["batch-1", "batch-2"]
  );
  assert.equal(typeof sent[0]?.body_hash, "string");
  assert.deepEqual(sent[0]?.records, [
    { data: { id: "message-1" }, emitted_at: "2026-04-30T12:00:00.000Z", record_key: "message-1", stream: "messages" },
  ]);
  const items = await queue.list();
  assert.equal(items.find((item) => item.batch_id === "batch-1")?.status, "sent");
  assert.equal(items.find((item) => item.batch_id === "batch-2")?.status, "pending");
  assert.equal(items.find((item) => item.batch_id === "batch-2")?.retry_count, 1);
});

test("buildCodexStartMessage does not require an owner token", () => {
  const start = buildCodexStartMessage(["messages"]);
  assert.deepEqual(start, { scope: { streams: [{ name: "messages" }] }, type: "START" });
  assert.equal(JSON.stringify(start).includes("owner"), false);
  assert.equal(JSON.stringify(start).includes("token"), false);
});

async function tempQueuePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-")), "queue.json");
}

// ─── Browser-collector connector profile (add-browser-collector-enrollment-
//     primitive proof harness) ──────────────────────────────────────────────
// The monorepo local-device runner resolves the connector entrypoint from
// LOCAL_DEVICE_CONNECTOR_PROFILES. Registering `amazon` is the deterministic
// wiring the owner-run live browser-collector proof needs; the live browser
// session itself stays owner-mediated. This registry is the MONOREPO runner's
// (development/owner-run) registry — distinct from the published
// `@pdpp/local-collector` BUNDLED_CONNECTORS, which stays filesystem-only so
// the publish never ships browser automation.

test("local-device runner resolves the amazon browser-collector connector profile", () => {
  const profile = resolveLocalDeviceConnectorProfile(AMAZON_CONNECTOR_ID);
  assert.equal(profile.connectorId, AMAZON_CONNECTOR_ID);
  assert.equal(profile.entrypoint, "connectors/amazon/index.ts");
  assert.deepEqual([...profile.defaultStreams], [...DEFAULT_AMAZON_STREAMS]);
  assert.deepEqual([...DEFAULT_AMAZON_STREAMS], ["orders", "order_items"]);
});

test("amazon profile START scope carries its declared streams without a token", () => {
  const profile = resolveLocalDeviceConnectorProfile(AMAZON_CONNECTOR_ID);
  const start = buildLocalDeviceStartMessage(profile.defaultStreams);
  assert.deepEqual(start, {
    scope: { streams: [{ name: "orders" }, { name: "order_items" }] },
    type: "START",
  });
  assert.equal(JSON.stringify(start).includes("token"), false);
});

test("local-device profile registry covers exactly codex, claude-code, and amazon", () => {
  assert.deepEqual(
    Object.keys(LOCAL_DEVICE_CONNECTOR_PROFILES).sort(),
    [AMAZON_CONNECTOR_ID, CLAUDE_CODE_CONNECTOR_ID, CODEX_CONNECTOR_ID].sort()
  );
});

test("resolveLocalDeviceConnectorProfile still rejects an unknown connector", () => {
  assert.throws(() => resolveLocalDeviceConnectorProfile("totally-unknown"), /unsupported local-device connector/);
});
