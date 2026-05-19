import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import {
  buildCollectorStartMessage,
  COLLECTOR_STDERR_MAX_BYTES,
  CollectorStateReadError,
  drainCollectorQueue,
  recoverAndSummarizeOutbox,
  runCollectorConnector,
  transformRecordsToCollectorEnvelopes,
} from "./collector-runner.ts";
import type { IngestBatchRequest } from "./local-device-client.ts";
import { buildLocalDeviceOutboxId, LocalDeviceOutbox } from "./local-device-outbox.ts";
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

test("buildCollectorStartMessage can request explicit stream backfills", () => {
  const start = buildCollectorStartMessage(["messages"], ["attachments"]);
  assert.deepEqual(start, {
    scope: { streams: [{ name: "messages" }] },
    streamsToBackfill: ["attachments"],
    type: "START",
  });
});

test("buildCollectorStartMessage populates START.state only when prior state is non-empty", () => {
  const empty = buildCollectorStartMessage(["messages"], [], {});
  assert.equal("state" in empty, false);

  const noPriorState = buildCollectorStartMessage(["messages"]);
  assert.equal("state" in noPriorState, false);

  const withState = buildCollectorStartMessage(["messages"], [], {
    messages: { cursor: "m-1" },
  });
  assert.deepEqual(withState.state, { messages: { cursor: "m-1" } });
  assert.equal(withState.type, "START");
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

test("runCollectorConnector spawns connectors from the package root with workspace tools on PATH", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const packageRoot = join(import.meta.dirname, "..");
    const packageBin = join(packageRoot, "node_modules", ".bin");
    const repoBin = join(packageRoot, "..", "..", "node_modules", ".bin");
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "messages",
          key: "spawn-context",
          data: { cwd: process.cwd(), path: process.env.PATH ?? "" },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });

    await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: process.execPath,
        connector_id: "fixture-spawn-context",
        env: { PATH: "operator-bin" },
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    const data = harness.ingestedBatches[0]?.records?.[0]?.data;
    assert.equal(data?.cwd, packageRoot);
    const pathParts = String(data?.path).split(delimiter);
    assert.equal(pathParts[0], packageBin);
    assert.equal(pathParts[1], repoBin);
    assert.ok(pathParts.includes("operator-bin"));
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector rejects promptly when the connector command is missing", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: ["connectors/claude_code/index.ts"],
            command: "__pdpp_missing_connector_command__",
            connector_id: "fixture-missing-command",
            env: { PATH: "operator-bin" },
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /fixture-missing-command connector failed to start or stream output:.*ENOENT/
    );
  } finally {
    await harness.close();
  }
});

async function tempQueuePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-collector-runner-")), "queue.json");
}

test("runCollectorConnector replays prior STATE into the connector's START.state and flushes emitted STATE after records drain", async () => {
  const harness = await startCollectorHarness({
    priorState: { messages: { cursor: "m-prior" } },
  });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      // The connector should see prior state via STATE_IN_PRIOR env, echo
      // one record, advance the cursor, and exit.
      script: `
        const line = await new Promise((r) => {
          let buf = "";
          process.stdin.on("data", (c) => {
            buf += c;
            if (buf.includes("\\n")) r(buf.split("\\n")[0]);
          });
        });
        const start = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "messages",
          key: "m-1",
          data: { id: "m-1", prior_cursor: start.state?.messages?.cursor ?? null },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-next",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });
    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-replay",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    // priorState is whatever the server returns under `state` — the test
    // server stored it as { messages: { cursor: "m-prior" } } so that the
    // connector's `START.state.messages.cursor` round-trips with a nested
    // cursor field. The STATE the fixture emits, however, is a flat string
    // ("m-next") because the STATE message's `cursor` field IS the value
    // for that stream (see EmittedMessage). The runner projects per stream:
    // `state[stream] = msg.cursor`.
    assert.deepEqual(result.priorState, { messages: { cursor: "m-prior" } });
    assert.deepEqual(result.flushedState, { messages: "m-next" });
    assert.equal(result.statePutFailed, false);
    assert.equal(result.recordsQueued, 1);
    assert.equal(result.sentBatches, 1);

    // Connector saw the replayed cursor.
    const ingest = harness.ingestedBatches[0];
    assert.equal(ingest?.records?.[0]?.data?.prior_cursor, "m-prior");

    // State was GET before ingest and PUT after.
    const stateOps = harness.stateOps;
    assert.equal(stateOps[0]?.method, "GET");
    const lastOp = stateOps.at(-1);
    assert.equal(lastOp?.method, "PUT");
    assert.deepEqual(lastOp?.body, {
      state: { messages: "m-next" },
    });
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector skips state PUT when the queue still has retrying items, preserving prior state", async () => {
  const harness = await startCollectorHarness({
    priorState: {},
    ingestFailureMode: "always-503",
  });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "messages",
          key: "m-1",
          data: { id: "m-1" },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-next",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-retrying",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    // Ingest never succeeded → state must NOT have been advanced.
    assert.equal(result.flushedState, null);
    assert.equal(result.statePutFailed, false);
    const putOps = harness.stateOps.filter((op) => op.method === "PUT");
    assert.equal(putOps.length, 0);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector does not checkpoint when record work dead-letters", async () => {
  const harness = await startCollectorHarness({
    priorState: {},
    ingestFailureMode: "always-503",
  });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "messages",
          key: "m-dead",
          data: { id: "m-dead" },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-dead-cursor",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-dead-letter-no-checkpoint",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { maxAttempts: 1 },
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.flushedState, null);
    assert.equal(result.outboxSummary.deadLetter, 1);
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);
    assert.equal(harness.heartbeats.at(-1)?.status, "blocked");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector drops out-of-scope STATE messages with a warning and does not persist them", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-1",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "not_in_scope",
          cursor: "rogue",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 0,
        }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-scope",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.deepEqual(result.flushedState, { messages: "m-1" });
    const putOps = harness.stateOps.filter((op) => op.method === "PUT");
    assert.equal(putOps.length, 1);
    // The persisted body must not include the rogue stream.
    assert.deepEqual(putOps[0]?.body, { state: { messages: "m-1" } });
  } finally {
    await harness.close();
  }
});

test("two-pass replay regression: a second runCollectorConnector call receives the cursor persisted by the first pass", async () => {
  // Models the Gmail-style "resume after restart" invariant without
  // requiring live IMAP creds: pass 1 emits a cursor; pass 2 should
  // see that cursor as priorState. The runner is the only state
  // authority — the fixture child just echoes whatever cursor it sees
  // in START.state.attachments and bumps it on the way out.
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        const start = JSON.parse(buf.split("\\n")[0]);
        const priorCursor = start.state?.attachments ?? "uid:0";
        const nextCursor = "uid:" + (parseInt(priorCursor.split(":")[1], 10) + 1);
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "attachments",
          key: nextCursor,
          data: { id: nextCursor, observed_prior: priorCursor },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "attachments",
          cursor: nextCursor,
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });

    const baseConfig = {
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "gmail-fixture-resume",
        runtime_requirements: { bindings: {} },
        streams: ["attachments"],
      } as const,
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    };

    const pass1 = await runCollectorConnector(baseConfig);
    assert.deepEqual(pass1.priorState, {});
    assert.deepEqual(pass1.flushedState, { attachments: "uid:1" });
    assert.equal(pass1 && harness.ingestedBatches[0]?.records?.[0]?.data?.observed_prior, "uid:0");

    const pass2 = await runCollectorConnector(baseConfig);
    // Pass 2 must see the cursor persisted by pass 1 — proving the runner
    // is replaying state across invocations rather than starting fresh.
    assert.deepEqual(pass2.priorState, { attachments: "uid:1" });
    assert.deepEqual(pass2.flushedState, { attachments: "uid:2" });
    assert.equal(harness.ingestedBatches[1]?.records?.[0]?.data?.observed_prior, "uid:1");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector drains durable checkpoint work before reading prior state", async () => {
  const harness = await startCollectorHarness({
    priorState: { messages: { cursor: "m-prior" } },
  });
  try {
    const queuePath = await tempQueuePath();
    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      outbox.enqueue({
        id: buildLocalDeviceOutboxId({
          kind: "checkpoint",
          parts: ["fixture-checkpoint-before-state", { messages: { cursor: "m-checkpoint" } }],
          sourceInstanceId: "src-1",
        }),
        kind: "checkpoint",
        payload: {
          connectorId: "fixture-checkpoint-before-state",
          sourceInstanceId: "src-1",
          state: { messages: { cursor: "m-checkpoint" } },
        },
        sourceInstanceId: "src-1",
      });
    } finally {
      outbox.close();
    }

    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        const start = JSON.parse(buf.split("\\n")[0]);
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "messages",
          key: "m-after-checkpoint",
          data: { prior_cursor: start.state?.messages?.cursor ?? null },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-checkpoint-before-state",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.sentBatches, 1);
    assert.equal(result.outboxSummary.ready, 0);
    assert.equal(result.outboxSummary.leased, 0);
    assert.equal(harness.stateOps[0]?.method, "PUT");
    assert.equal(harness.stateOps[1]?.method, "GET");
    assert.equal(harness.ingestedBatches[0]?.records?.[0]?.data?.prior_cursor, "m-checkpoint");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector skips source scan when pre-existing durable work cannot drain", async () => {
  const harness = await startCollectorHarness({
    ingestFailureMode: "always-503",
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const records = transformRecordsToCollectorEnvelopes({
        batchId: "existing-batch",
        batchSeq: 1,
        connectorId: "fixture-backlog-skip",
        deviceId: "device-1",
        messages: [
          {
            data: { id: "m-existing" },
            emitted_at: "2026-05-19T12:00:00.000Z",
            key: "m-existing",
            stream: "messages",
            type: "RECORD",
          },
        ],
        sourceInstanceId: "src-1",
      });
      outbox.enqueue({
        id: buildLocalDeviceOutboxId({
          kind: "record_batch",
          parts: ["existing-batch"],
          sourceInstanceId: "src-1",
        }),
        kind: "record_batch",
        payload: {
          batchId: "existing-batch",
          batchSeq: 1,
          connectorId: "fixture-backlog-skip",
          deviceId: "device-1",
          records,
          sourceInstanceId: "src-1",
        },
        sourceInstanceId: "src-1",
      });
    } finally {
      outbox.close();
    }

    const fixture = await writeFixtureConnector({
      script: `
        process.stderr.write("fixture should not spawn while backlog is pending\\n");
        process.exit(13);
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-backlog-skip",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { retryBackoffMs: 60_000 },
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.skippedScanForBacklog, true);
    assert.equal(result.recordsQueued, 0);
    assert.equal(result.sentBatches, 0);
    assert.equal(result.outboxSummary.ready, 1);
    assert.equal(result.outboxSummary.retrying, 1);
    assert.equal(harness.stateOps.length, 0);
    assert.equal(harness.heartbeats.at(-1)?.status, "retrying");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector surfaces state-read failure as a blocked heartbeat and refuses to spawn the connector", async () => {
  const harness = await startCollectorHarness({
    priorState: null,
    stateReadStatus: 503,
  });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        // This connector would fail loudly if spawned. The runner must not
        // reach this code path because the state read failed first.
        process.stderr.write("FIXTURE SHOULD NOT RUN\\n");
        process.exit(11);
      `,
    });

    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-state-read-fail",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-1",
        }),
      (err: unknown) => {
        assert.ok(
          err instanceof CollectorStateReadError,
          `expected CollectorStateReadError, got ${(err as Error)?.constructor?.name}`
        );
        return true;
      }
    );

    const blockedHeartbeats = harness.heartbeats.filter((h) => h.status === "blocked");
    assert.ok(
      blockedHeartbeats.length >= 1,
      `expected at least one blocked heartbeat, saw ${harness.heartbeats.map((h) => h.status).join(",")}`
    );
  } finally {
    await harness.close();
  }
});

interface CollectorHarnessOptions {
  ingestFailureMode?: "always-503";
  priorState?: Record<string, unknown> | null;
  /** When set, the GET state endpoint returns this status instead of 200. */
  stateReadStatus?: number;
}

interface CollectorHarness {
  close: () => Promise<void>;
  heartbeats: Array<{ status: string; [k: string]: unknown }>;
  ingestedBatches: Array<{ records?: Array<{ data?: Record<string, unknown> }>; [k: string]: unknown }>;
  stateOps: Array<{ body: unknown; method: string }>;
  url: string;
}

async function startCollectorHarness(options: CollectorHarnessOptions): Promise<CollectorHarness> {
  const stateOps: CollectorHarness["stateOps"] = [];
  const heartbeats: CollectorHarness["heartbeats"] = [];
  const ingestedBatches: CollectorHarness["ingestedBatches"] = [];
  let persistedState: Record<string, unknown> = options.priorState ? { ...options.priorState } : {};

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "";
    const body = await readBody(req);
    const parsed = body ? safeJsonParse(body) : null;

    if (url.endsWith("/state") && (method === "GET" || method === "PUT")) {
      stateOps.push({ body: parsed, method });
      if (method === "GET") {
        if (options.stateReadStatus && options.stateReadStatus >= 400) {
          res.writeHead(options.stateReadStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "synthetic" } }));
          return;
        }
        sendJson(res, 200, {
          object: "device_source_instance_state",
          device_id: "device-1",
          source_instance_id: "src-1",
          state: persistedState,
          updated_at: null,
        });
        return;
      }
      // PUT
      if (parsed && typeof parsed === "object" && "state" in parsed) {
        const next = (parsed as { state: Record<string, unknown> }).state;
        persistedState = { ...persistedState, ...next };
      }
      sendJson(res, 200, {
        object: "device_source_instance_state",
        device_id: "device-1",
        source_instance_id: "src-1",
        state: persistedState,
        updated_at: new Date().toISOString(),
      });
      return;
    }
    if (url.includes("/heartbeat")) {
      heartbeats.push(parsed as { status: string });
      sendJson(res, 200, { object: "device_exporter_heartbeat", status: "accepted" });
      return;
    }
    if (url.includes("/ingest-batches")) {
      if (options.ingestFailureMode === "always-503") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "synthetic_unavailable" } }));
        return;
      }
      ingestedBatches.push(parsed as { records?: Array<{ data?: Record<string, unknown> }> });
      sendJson(res, 201, {
        object: "device_ingest_batch_result",
        status: "accepted",
        accepted_record_count: (parsed as { records?: unknown[] }).records?.length ?? 0,
        rejected_record_count: 0,
      });
      return;
    }
    sendJson(res, 404, { error: { code: "not_found", path: url } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("collector harness failed to start");
  }
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    heartbeats,
    ingestedBatches,
    stateOps,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("runCollectorConnector bounds child stderr buffering so verbose connectors cannot pin memory", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    // Emit ~2 MiB of stderr — well past COLLECTOR_STDERR_MAX_BYTES — then
    // exit non-zero so the runner surfaces the bounded tail.
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        const chunk = "x".repeat(64 * 1024);
        for (let i = 0; i < 32; i++) {
          process.stderr.write(chunk);
        }
        // Flush before exit so the marker is observable even when
        // stderr is a pipe that defers writes.
        await new Promise((r) => process.stderr.write("\\nFINAL_ERROR_MARKER\\n", () => r(undefined)));
        process.exit(7);
      `,
    });

    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-noisy-stderr",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-1",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const message = err instanceof Error ? err.message : String(err);
        // Tail of stderr (the final error marker) MUST survive truncation.
        assert.ok(/FINAL_ERROR_MARKER/.test(message), `missing final marker: ${message}`);
        // The runner must report truncation so operators can tell that
        // earlier stderr was dropped.
        assert.ok(/truncated \d+ stderr bytes/.test(message), `missing truncation note: ${message}`);
        // The retained slice plus the truncation note must stay near
        // the configured cap — never near the 2 MiB the child emitted.
        assert.ok(
          message.length < COLLECTOR_STDERR_MAX_BYTES + 1024,
          `bounded stderr leaked: ${message.length} bytes (cap ${COLLECTOR_STDERR_MAX_BYTES})`
        );
        return true;
      }
    );
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector honors AbortSignal at the pre-spawn gate", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled run"));

    await assert.rejects(
      () =>
        runCollectorConnector({
          abortSignal: controller.signal,
          baseUrl: harness.url,
          connector: {
            args: ["unused.ts"],
            command: "node",
            connector_id: "fixture-aborted",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /operator cancelled run/
    );
    // No spawn happened, so no ingest occurred either.
    assert.equal(harness.ingestedBatches.length, 0);
  } finally {
    await harness.close();
  }
});

test("recoverAndSummarizeOutbox recovers expired leases and returns a fast summary", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const dir = await mkdtemp(join(tmpdir(), "pdpp-recover-summary-"));
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: join(dir, "outbox.sqlite") });
  try {
    outbox.enqueue({
      id: "src-1:record_batch:1",
      kind: "record_batch",
      payload: { x: 1 },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "src-1:record_batch:2",
      kind: "record_batch",
      payload: { x: 2 },
      sourceInstanceId: "src-1",
    });
    // Lease both briefly so they expire when the clock advances.
    outbox.claimReady({ holder: "worker-old", leaseMs: 1000, limit: 2, sourceInstanceId: "src-1" });
    now = new Date("2026-05-19T12:00:05.000Z");

    const { recovered, summary } = recoverAndSummarizeOutbox(outbox, { sourceInstanceId: "src-1" });
    assert.equal(recovered, 2);
    assert.equal(summary.ready, 2);
    assert.equal(summary.leased, 0);
    assert.equal(summary.staleLeases, 0);
  } finally {
    outbox.close();
  }
});

test("runCollectorConnector streams RECORDs into bounded durable batches without retaining the whole child output", async () => {
  // Emit 250 records with a streaming batchSize of 50. The runner must
  // produce 5 durable record_batch rows AND prove the in-memory buffer
  // never held more than `batchSize` records at once.
  const recordCount = 250;
  const batchSize = 50;
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        for (let i = 0; i < ${recordCount}; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "m-" + i,
            data: { id: "m-" + i },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-final",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: ${recordCount},
        }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      batchSize,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-streaming-bounded",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.recordsQueued, recordCount);
    assert.equal(result.enqueuedBatches, recordCount / batchSize);
    // The streaming buffer must never have held more than one batch's
    // worth of records at any moment — that is the memory bound.
    assert.ok(
      result.streamingBufferHighWaterMark <= batchSize,
      `streaming buffer leaked: high-water ${result.streamingBufferHighWaterMark} > batchSize ${batchSize}`
    );
    assert.equal(result.sentBatches, recordCount / batchSize);
    // Server received every record split into individual ingest calls.
    const totalIngested = harness.ingestedBatches.reduce((sum, batch) => sum + (batch.records?.length ?? 0), 0);
    assert.equal(totalIngested, recordCount);
    assert.deepEqual(result.flushedState, { messages: "m-final" });
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector defers checkpoint until every streamed record batch is acknowledged", async () => {
  // Emit 60 records (3 batches of 20) and STATE. Ingest fails for every
  // batch this pass, so even though some batches stream successfully to
  // the outbox before the child exits, the checkpoint must NOT advance.
  const harness = await startCollectorHarness({
    ingestFailureMode: "always-503",
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        for (let i = 0; i < 60; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "m-" + i,
            data: { id: "m-" + i },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-60",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 60,
        }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      batchSize: 20,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-streaming-defer-checkpoint",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { retryBackoffMs: 60_000 },
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.enqueuedBatches, 3);
    assert.equal(result.sentBatches, 0);
    assert.equal(result.flushedState, null);
    assert.equal(result.statePutFailed, false);
    // Three durable record_batch rows must remain in the outbox; with the
    // backoff override every row is in ready+retrying after the failed
    // drain (ready counts all unleased rows; retrying counts the subset
    // with a future next_attempt_at).
    assert.equal(result.outboxSummary.ready, 3);
    assert.equal(result.outboxSummary.retrying, 3);
    assert.equal(result.outboxSummary.deadLetter, 0);
    // Server saw no checkpoint PUT — the checkpoint outbox row must not
    // have been enqueued (let alone drained) while record work is pending.
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector leaves streamed batches durable when the child fails mid-stream and does not advance the checkpoint", async () => {
  // Emit two full batches' worth of records, then exit non-zero before
  // emitting STATE or DONE. The runner must throw, but the already-
  // streamed batches must remain in the outbox as retryable work, and
  // no checkpoint may have been enqueued.
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        for (let i = 0; i < 40; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "m-" + i,
            data: { id: "m-" + i },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        // Flush stdout so the runner observes the batches before we exit.
        await new Promise((r) => process.stdout.write("", () => r(undefined)));
        process.stderr.write("synthetic mid-stream failure\\n");
        process.exit(9);
      `,
    });

    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          batchSize: 20,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-streaming-mid-failure",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          outboxPolicy: { retryBackoffMs: 60_000 },
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /fixture-streaming-mid-failure connector exited 9/
    );

    // Reopen the outbox after the runner closed it — the two streamed
    // batches must still be there, available for the next runner pass.
    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const summary = outbox.summary({ sourceInstanceId: "src-1" });
      assert.equal(summary.ready, 2, `expected 2 retryable record batches, got ${JSON.stringify(summary)}`);
      const items = outbox.list({ sourceInstanceId: "src-1" });
      // No checkpoint row was enqueued because STATE never reached the runner.
      assert.equal(
        items.filter((item) => item.kind === "checkpoint").length,
        0,
        "checkpoint must not be enqueued when child fails mid-stream"
      );
      assert.equal(items.filter((item) => item.kind === "record_batch").length, 2);
    } finally {
      outbox.close();
    }
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);
  } finally {
    await harness.close();
  }
});

async function writeFixtureConnector(input: { script: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-fixture-connector-"));
  const path = join(dir, "fixture.mjs");
  await writeFile(
    path,
    `(async () => {\n${input.script}\n})().catch((err) => { process.stderr.write(String(err)); process.exit(1); });\n`
  );
  return path;
}
