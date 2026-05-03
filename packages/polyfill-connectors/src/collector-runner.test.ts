import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildCollectorStartMessage,
  drainCollectorQueue,
  runCollectorConnector,
  transformRecordsToCollectorEnvelopes,
} from "./collector-runner.ts";
import type { IngestBatchRequest } from "./local-device-client.ts";
import { LocalDeviceQueue } from "./local-device-queue.ts";
import { RuntimeCapabilityMismatchError } from "./runtime-capabilities.ts";

test("buildCollectorStartMessage emits a stream-only START with no owner credentials", () => {
  const start = buildCollectorStartMessage(["sessions", "messages"]);
  assert.deepEqual(start, {
    scope: { streams: [{ name: "sessions" }, { name: "messages" }] },
    type: "START",
  });
  assert.equal(JSON.stringify(start).includes("owner"), false);
  assert.equal(JSON.stringify(start).includes("token"), false);
});

test("transformRecordsToCollectorEnvelopes uses the given connector id", () => {
  const envelopes = transformRecordsToCollectorEnvelopes({
    batchId: "batch-1",
    batchSeq: 1,
    connectorId: "imessage",
    deviceId: "device-1",
    messages: [
      { message: "working", type: "PROGRESS" },
      {
        data: { id: "msg-1", text: "hi" },
        emitted_at: "2026-04-30T12:00:00.000Z",
        key: "msg-1",
        stream: "messages",
        type: "RECORD",
      },
      { records_emitted: 1, status: "succeeded", type: "DONE" },
    ],
    sourceInstanceId: "src-1",
  });

  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0]?.connector_id, "imessage");
  assert.equal(envelopes[0]?.device_id, "device-1");
  assert.equal(envelopes[0]?.source_instance_id, "src-1");
  assert.equal(envelopes[0]?.stream, "messages");
});

test("drainCollectorQueue marks sent and preserves retryable failures", async () => {
  const queue = new LocalDeviceQueue({
    path: await tempQueuePath(),
    retryBackoffMs: () => 60_000,
  });
  const records = transformRecordsToCollectorEnvelopes({
    batchId: "batch-1",
    batchSeq: 1,
    connectorId: "codex",
    deviceId: "device-1",
    messages: [
      {
        data: { id: "m-1" },
        emitted_at: "2026-04-30T12:00:00.000Z",
        key: "m-1",
        stream: "messages",
        type: "RECORD",
      },
    ],
    sourceInstanceId: "src-1",
  });
  await queue.enqueue({ batchId: "batch-1", batchSeq: 1, records, sourceInstanceId: "src-1" });
  await queue.enqueue({ batchId: "batch-2", batchSeq: 2, records, sourceInstanceId: "src-1" });

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

  assert.equal(await drainCollectorQueue({ client, queue }), 1);
  const items = await queue.list();
  assert.equal(items.find((i) => i.batch_id === "batch-1")?.status, "sent");
  assert.equal(items.find((i) => i.batch_id === "batch-2")?.status, "pending");
});

test("runCollectorConnector refuses a connector requiring a binding the collector lacks", async () => {
  // Negative: capability gating must fire before any HTTP heartbeat is
  // attempted. We pass a junk baseUrl/queue path; the gate must short
  // circuit before either is touched.
  const queuePath = await tempQueuePath();
  await assert.rejects(
    () =>
      runCollectorConnector({
        baseUrl: "http://127.0.0.1:1",
        connector: {
          connector_id: "fictional-quantum-runtime",
          runtime_requirements: {
            // `quantum` is not in the RuntimeBindingName set, but
            // assertPlacementOrThrow uses Object.entries on declared
            // bindings — so the check works for any string. Use a
            // declared name that is plausibly missing on every default
            // runtime profile.
            bindings: {
              local_device: { required: true },
              // @ts-expect-error — testing a binding the type system does not know
              quantum: { required: true },
            },
          },
          streams: ["events"],
          command: "tsx",
          args: ["does-not-matter.ts"],
        },
        deviceId: "device-1",
        deviceToken: "token-1",
        queuePath,
        sourceInstanceId: "src-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeCapabilityMismatchError);
      if (err instanceof RuntimeCapabilityMismatchError) {
        assert.equal(err.connectorId, "fictional-quantum-runtime");
        assert.equal(err.runtime, "collector");
        // The unknown binding is what's missing on the default collector
        // profile; verify it appears in the diagnostic.
        assert.ok(err.missing.includes("quantum" as never));
      }
      return true;
    }
  );
});

test("buildCollectorStartMessage produces no owner-token surface", () => {
  const message = buildCollectorStartMessage(["events"]);
  assert.equal(message.type, "START");
  assert.equal("owner_token" in message, false);
  assert.equal("authorization" in message, false);
});

async function tempQueuePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-collector-runner-")), "queue.json");
}
