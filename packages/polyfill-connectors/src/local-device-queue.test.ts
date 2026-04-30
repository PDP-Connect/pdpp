import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.ts";
import { LocalDeviceQueue } from "./local-device-queue.ts";

test("LocalDeviceQueue persists batches and dequeues in source-instance batch order", async () => {
  let nowMs = Date.parse("2026-04-30T12:00:00.000Z");
  const queuePath = await tempQueuePath();
  const queue = new LocalDeviceQueue({ clock: () => new Date(nowMs), path: queuePath });

  await queue.enqueue({
    batchId: "source-b-2",
    batchSeq: 2,
    records: [record("source-b", 2)],
    sourceInstanceId: "source-b",
  });
  await queue.enqueue({
    batchId: "source-a-2",
    batchSeq: 2,
    records: [record("source-a", 2)],
    sourceInstanceId: "source-a",
  });
  await queue.enqueue({
    batchId: "source-a-1",
    batchSeq: 1,
    records: [record("source-a", 1)],
    sourceInstanceId: "source-a",
  });

  const reloaded = new LocalDeviceQueue({ clock: () => new Date(nowMs), path: queuePath });
  assert.equal((await reloaded.dequeueReady())?.batch_id, "source-a-1");
  assert.equal((await reloaded.dequeueReady())?.batch_id, "source-b-2");
  await reloaded.markSent("source-a-1");
  assert.equal((await reloaded.dequeueReady())?.batch_id, "source-a-2");
  nowMs += 1;
  assert.equal(await reloaded.dequeueReady(), null);
});

test("LocalDeviceQueue records retry metadata and waits for backoff before redelivery", async () => {
  let nowMs = Date.parse("2026-04-30T12:00:00.000Z");
  const queue = new LocalDeviceQueue({
    clock: () => new Date(nowMs),
    path: await tempQueuePath(),
    retryBackoffMs: () => 5000,
  });
  await queue.enqueue({
    batchId: "batch-1",
    batchSeq: 1,
    records: [record("source-1", 1)],
    sourceInstanceId: "source-1",
  });
  await queue.enqueue({
    batchId: "batch-2",
    batchSeq: 2,
    records: [record("source-1", 2)],
    sourceInstanceId: "source-1",
  });
  assert.equal((await queue.dequeueReady())?.batch_id, "batch-1");

  await queue.markRetry("batch-1", "temporary 503");
  assert.equal(await queue.dequeueReady(), null);

  nowMs += 5000;
  const retry = await queue.dequeueReady();
  assert.equal(retry?.batch_id, "batch-1");
  assert.equal(retry?.retry_count, 1);
  assert.equal(retry?.last_error, "temporary 503");
  await queue.markSent("batch-1");
  assert.equal((await queue.dequeueReady())?.batch_id, "batch-2");
});

test("LocalDeviceQueue records permanent failures and excludes them from dequeue", async () => {
  const queue = new LocalDeviceQueue({ path: await tempQueuePath() });
  await queue.enqueue({
    batchId: "bad-batch",
    batchSeq: 1,
    records: [record("source-1", 1)],
    sourceInstanceId: "source-1",
  });
  await queue.markPermanentFailure("bad-batch", "validation failed");

  assert.equal(await queue.dequeueReady(), null);
  const [item] = await queue.list();
  assert.equal(item?.status, "permanent_failure");
  assert.equal(item?.last_error, "validation failed");
});

async function tempQueuePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-local-device-queue-")), "queue.json");
}

function record(sourceInstanceId: string, batchSeq: number): LocalDeviceRecordEnvelope {
  return {
    batch_id: `${sourceInstanceId}-${batchSeq}`,
    batch_seq: batchSeq,
    body_hash: `hash-${sourceInstanceId}-${batchSeq}`,
    connector_id: "codex",
    data: { id: batchSeq },
    device_id: "device-1",
    emitted_at: "2026-04-30T12:00:00.000Z",
    key: String(batchSeq),
    source_instance_id: sourceInstanceId,
    stream: "messages",
  };
}
