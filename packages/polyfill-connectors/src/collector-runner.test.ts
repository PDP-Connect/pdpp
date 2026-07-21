import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { buildAgentVersion } from "./collector-build-info.ts";
import {
  buildCollectorStartMessage,
  COLLECTOR_STDERR_MAX_BYTES,
  CollectorStateReadError,
  drainCollectorOutbox,
  drainCollectorQueue,
  recoverAndSummarizeOutbox,
  runCollectorConnector,
  transformRecordsToCollectorEnvelopes,
} from "./collector-runner.ts";
import { type IngestBatchRequest, type LocalDeviceClient, LocalDeviceHttpError } from "./local-device-client.ts";
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

test("buildCollectorStartMessage can scope a stream to explicit resources", () => {
  const start = buildCollectorStartMessage(["messages", "users"], [], null, {
    messages: ["C07JYF0U8BY"],
  });
  assert.deepEqual(start, {
    scope: { streams: [{ name: "messages", resources: ["C07JYF0U8BY"] }, { name: "users" }] },
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

test("runCollectorConnector gives changed emitted_at records a distinct local batch identity", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  const runOnce = async (emittedAt: string): Promise<{ batchId: string; bodyHash: string }> => {
    const batchOffset = harness.ingestedBatches.length;
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
          key: "same-record",
          data: { id: "same-record", value: 1 },
          emitted_at: ${JSON.stringify(emittedAt)},
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
      batchSize: 1,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-batch-identity",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath: await tempQueuePath(),
      sourceInstanceId: "src-batch-identity",
    });

    const batch = harness.ingestedBatches.at(batchOffset);
    assert.ok(batch, "expected one ingested batch");
    assert.equal(typeof batch.batch_id, "string");
    assert.equal(typeof batch.body_hash, "string");
    return { batchId: batch.batch_id as string, bodyHash: batch.body_hash as string };
  };

  try {
    const first = await runOnce("2026-05-20T00:00:00.000Z");
    const second = await runOnce("2026-05-20T00:00:01.000Z");

    assert.notEqual(first.bodyHash, second.bodyHash, "server idempotency hash changes when emitted_at changes");
    assert.notEqual(first.batchId, second.batchId, "batch id must change with the body hash to avoid false conflicts");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector summarizes coverage completeness distinct from declared-stream success", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    // The connector reports a clean DONE for its declared stream while the
    // coverage diagnostic shows a mix of accounted statuses — collected,
    // excluded, deferred, and missing. Declared-stream success must not
    // flatten that completeness picture (Section 5.2).
    const fixture = await writeFixtureConnector({
      script: `
        await new Promise((r) => {
          let buf = "";
          process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); });
        });
        const coverage = [
          { store: "sessions", stream: "sessions", status: "collected", reason: "declared stream" },
          { store: "auth", stream: null, status: "excluded", reason: "auth-adjacent" },
          { store: "logs", stream: "logs", status: "deferred", reason: "redaction pending" },
          { store: "downloads", stream: "downloads", status: "missing", reason: "not present" },
        ];
        process.stdout.write(JSON.stringify({
          type: "RECORD", stream: "sessions", key: "s-1",
          data: { id: "s-1" }, emitted_at: new Date().toISOString(),
        }) + "\\n");
        for (const c of coverage) {
          process.stdout.write(JSON.stringify({
            type: "RECORD", stream: "coverage_diagnostics", key: "coverage:" + c.store,
            data: { id: "coverage:" + c.store, ...c }, emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 5 }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-coverage",
        runtime_requirements: { bindings: {} },
        streams: ["sessions", "coverage_diagnostics"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath: await tempQueuePath(),
      sourceInstanceId: "src-coverage",
    });

    // Declared-stream success is reported on `done`.
    assert.equal(result.done?.status, "succeeded");

    // Completeness is a separate, non-failing signal.
    assert.ok(result.completeness, "expected a completeness summary");
    assert.equal(result.completeness?.storeCount, 4);
    assert.equal(result.completeness?.fullyAccounted, true);
    assert.deepEqual(result.completeness?.unaccountedStores, []);
    assert.equal(result.completeness?.countsByStatus.collected, 1);
    assert.equal(result.completeness?.countsByStatus.excluded, 1);
    assert.equal(result.completeness?.countsByStatus.deferred, 1);
    assert.equal(result.completeness?.countsByStatus.missing, 1);
    assert.equal(result.completeness?.byStore.auth, "excluded");
    assert.equal(result.completeness?.byStore.downloads, "missing");

    // The summary must not carry paths, payloads, or the reason free-text.
    const json = JSON.stringify(result.completeness);
    assert.equal(json.includes("reason"), false);
    assert.equal(json.includes("redaction pending"), false);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector reports null completeness when no coverage diagnostic is observed", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const fixture = await writeFixtureConnector({
      script: `
        await new Promise((r) => {
          let buf = "";
          process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); });
        });
        process.stdout.write(JSON.stringify({
          type: "RECORD", stream: "messages", key: "m-1",
          data: { id: "m-1" }, emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-no-coverage",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath: await tempQueuePath(),
      sourceInstanceId: "src-no-coverage",
    });

    // A run that does not request coverage reports absence as absence, not
    // as "complete".
    assert.equal(result.done?.status, "succeeded");
    assert.equal(result.completeness, null);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector rejects failed terminal DONE, preserves records, and leaves a durable recovery gap", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({
      script: `
        await new Promise((r) => { let b = ""; process.stdin.on("data", (c) => { b += c; if (b.includes("\\n")) r(); }); });
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", key: "m-1", data: { id: "m-1" }, emitted_at: new Date().toISOString() }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "STATE", stream: "messages", cursor: { fetched_at: new Date().toISOString() } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "DONE", status: "failed", records_emitted: 1 }) + "\\n");
      `,
    });
    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-failed-done",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-failed-done",
        }),
      /terminal DONE reported failed/
    );
    assert.equal(
      harness.stateOps.filter((op) => op.method === "PUT").length,
      0,
      "failed DONE must not checkpoint STATE"
    );
    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const items = outbox.list({ sourceInstanceId: "src-failed-done" });
      assert.equal(items.filter((item) => item.kind === "record_batch").length, 1);
      assert.equal(items.filter((item) => item.kind === "checkpoint").length, 0);
      assert.equal(items.filter((item) => item.kind === "gap").length, 1);
    } finally {
      outbox.close();
    }
  } finally {
    await harness.close();
  }
});

const ONE_RECORD_CONNECTOR_SCRIPT = `
  await new Promise((r) => {
    let buf = "";
    process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); });
  });
  process.stdout.write(JSON.stringify({
    type: "RECORD", stream: "messages", key: "m-1",
    data: { id: "m-1" }, emitted_at: new Date().toISOString(),
  }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");
`;

test("runCollectorConnector auto-prunes over-retention succeeded rows after a clean drain and reports the count", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({ script: ONE_RECORD_CONNECTOR_SCRIPT });
    const baseConfig = {
      // Keep only the single most-recent succeeded row. The bound is count-only
      // — no age floor — so even the second pass's freshly-acknowledged batch
      // makes pass 1's batch eligible the instant it falls outside the recent
      // set. (v1 needed a `keepWithinDays: 0` age trick here; the corrected
      // count-only bound does not.)
      autoPrune: { keepRecentCount: 1 },
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-auto-prune",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-auto-prune",
    } as const;

    const pass1 = await runCollectorConnector(baseConfig);
    assert.equal(pass1.done?.status, "succeeded");
    assert.equal(pass1.prunedSent.enabled, true);
    // Pass 1 left exactly one acknowledged batch, which is inside keepRecentCount.
    assert.equal(pass1.prunedSent.pruned, 0);
    // The returned summary reflects the post-prune state.
    assert.equal(pass1.outboxSummary.succeeded, 1);

    const pass2 = await runCollectorConnector(baseConfig);
    assert.equal(pass2.done?.status, "succeeded");
    assert.equal(pass2.prunedSent.enabled, true);
    // Pass 2 acknowledges a second batch; keepRecentCount=1 keeps it and prunes
    // pass 1's batch — regardless of how recently pass 1 was acknowledged.
    assert.equal(pass2.prunedSent.pruned, 1);
    // The returned summary is post-prune: one row retained, not two.
    assert.equal(pass2.outboxSummary.succeeded, 1);

    // The final heartbeat the server received must also carry the post-prune
    // succeeded count, not the stale pre-prune tail.
    const lastHeartbeat = harness.heartbeats.at(-1);
    assert.equal((lastHeartbeat?.outbox as { succeeded?: number } | undefined)?.succeeded, 1);

    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      assert.equal(
        outbox.summary({ sourceInstanceId: "src-auto-prune" }).succeeded,
        1,
        "exactly the most-recent succeeded row is retained"
      );
    } finally {
      outbox.close();
    }
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector reports the build-derived agent version on every heartbeat", async () => {
  // Stale-build drift was invisible because the collector reported an empty
  // `agent_version`. Every heartbeat must now carry the build-derived version so
  // the reference can persist it to `device_exporters.agent_version` and surface
  // which build a host is running. In an unbuilt test run this is `…+source`.
  const harness = await startCollectorHarness({});
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({ script: ONE_RECORD_CONNECTOR_SCRIPT });
    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-agent-version",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-agent-version",
    });
    assert.equal(result.done?.status, "succeeded");

    const expected = buildAgentVersion();
    assert.match(expected, /^[^+]+\+source$/, "an unbuilt test run reports the source sentinel");
    assert.ok(harness.heartbeats.length >= 2, "expected at least the starting and final heartbeats");
    for (const heartbeat of harness.heartbeats) {
      assert.equal(
        heartbeat.agent_version,
        expected,
        `every heartbeat must carry the build-derived agent version; saw ${String(heartbeat.agent_version)}`
      );
    }
    // Redaction: the reported version carries no path, home dir, or token.
    const starting = harness.heartbeats.find((h) => h.status === "starting");
    const startingVersion = String(starting?.agent_version ?? "");
    assert.ok(!startingVersion.includes("/"), "agent version must not carry a path separator");
    assert.ok(!startingVersion.includes(process.env.HOME ?? " never"), "must not carry a home path");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector leaves succeeded rows intact when auto-prune is disabled", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({ script: ONE_RECORD_CONNECTOR_SCRIPT });
    const baseConfig = {
      // Disabled despite an aggressive count bound that would otherwise prune.
      autoPrune: { enabled: false, keepRecentCount: 0 },
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-prune-disabled",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-prune-disabled",
    } as const;

    const pass1 = await runCollectorConnector(baseConfig);
    const pass2 = await runCollectorConnector(baseConfig);
    assert.equal(pass1.prunedSent.enabled, false);
    assert.equal(pass2.prunedSent.enabled, false);
    assert.equal(pass2.prunedSent.pruned, 0);

    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      assert.equal(
        outbox.summary({ sourceInstanceId: "src-prune-disabled" }).succeeded,
        2,
        "both acknowledged batches are retained when prune is disabled"
      );
    } finally {
      outbox.close();
    }
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector under the default policy retains a clean run's acknowledged rows", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const fixture = await writeFixtureConnector({ script: ONE_RECORD_CONNECTOR_SCRIPT });
    // No autoPrune override → default policy (keep the most-recent 10,000).
    // A single clean run's one acknowledged batch is well inside the cap.
    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-default-prune",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-default-prune",
    });
    assert.equal(result.prunedSent.enabled, true);
    assert.equal(result.prunedSent.pruned, 0, "a clean run within bounds prunes nothing");

    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      assert.equal(outbox.summary({ sourceInstanceId: "src-default-prune" }).succeeded, 1);
    } finally {
      outbox.close();
    }
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector flags an unrecognized coverage status as unaccounted", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const fixture = await writeFixtureConnector({
      script: `
        await new Promise((r) => {
          let buf = "";
          process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); });
        });
        process.stdout.write(JSON.stringify({
          type: "RECORD", stream: "coverage_diagnostics", key: "mystery:weird",
          data: { id: "mystery:weird", store: "mystery", stream: null, status: "weird-new-status" },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-unaccounted",
        runtime_requirements: { bindings: {} },
        streams: ["coverage_diagnostics"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath: await tempQueuePath(),
      sourceInstanceId: "src-unaccounted",
    });

    // An unknown status from a future tool release surfaces as unaccounted,
    // so declared-stream success cannot read as complete.
    assert.equal(result.done?.status, "succeeded");
    assert.equal(result.completeness?.fullyAccounted, false);
    assert.deepEqual(result.completeness?.unaccountedStores, ["mystery"]);
    assert.equal(result.completeness?.countsByStatus.unaccounted, 1);
  } finally {
    await harness.close();
  }
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

function seedDeadLetteredRecordBatch(input: {
  connectorId: string;
  deviceId?: string;
  error: string;
  queuePath: string;
  sourceInstanceId: string;
}): string {
  const batchId = `${input.sourceInstanceId}:seeded-batch`;
  const records = transformRecordsToCollectorEnvelopes({
    batchId,
    batchSeq: 1,
    connectorId: input.connectorId,
    deviceId: input.deviceId ?? "device-1",
    messages: [
      {
        data: { id: `${input.sourceInstanceId}:m-1` },
        emitted_at: "2026-05-19T12:00:00.000Z",
        key: `${input.sourceInstanceId}:m-1`,
        stream: "messages",
        type: "RECORD",
      },
    ],
    sourceInstanceId: input.sourceInstanceId,
  });
  const rowId = buildLocalDeviceOutboxId({
    kind: "record_batch",
    parts: [batchId],
    sourceInstanceId: input.sourceInstanceId,
  });
  const outbox = new LocalDeviceOutbox({ path: input.queuePath });
  try {
    outbox.enqueue({
      id: rowId,
      kind: "record_batch",
      payload: {
        batchId,
        batchSeq: 1,
        connectorId: input.connectorId,
        deviceId: input.deviceId ?? "device-1",
        records,
        sourceInstanceId: input.sourceInstanceId,
      },
      sourceInstanceId: input.sourceInstanceId,
    });
    const [claim] = outbox.claimReady({ holder: "seed", leaseMs: 60_000, sourceInstanceId: input.sourceInstanceId });
    assert.ok(claim, "seeded batch must be claimable");
    outbox.deadLetter({
      error: input.error,
      holder: "seed",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });
  } finally {
    outbox.close();
  }
  return rowId;
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
    const blockedHeartbeat = harness.heartbeats.at(-1);
    assert.equal(blockedHeartbeat?.status, "blocked");
    // The blocked-on-backlog heartbeat now carries the redacted cause so the
    // dashboard can answer "why did these dead-letter?" without host access.
    const lastError = heartbeatLastError(blockedHeartbeat?.last_error);
    assert.equal(lastError?.kind, "dead_letter_backlog");
    assert.ok((lastError?.top_dead_letter_classes?.length ?? 0) >= 1, "expected at least one error class");
    assert.equal(lastError?.top_dead_letter_classes?.[0]?.count, 1);
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

test("Gmail attachment backfill cursor replays from durable STATE after restart", async () => {
  // Models the historical Gmail attachment backfill cursor specifically:
  // the connector stores attachments.all_mail.backfilled_through_uid after
  // a bounded UID window drains. On restart, the next START.state must carry
  // that nested cursor so Gmail resumes at the next window instead of
  // rescanning from zero or skipping unpersisted UIDs.
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
        const prior = start.state?.attachments?.all_mail?.backfilled_through_uid ?? 0;
        const next = prior + 50;
        process.stdout.write(JSON.stringify({
          type: "RECORD",
          stream: "attachments",
          key: "uid-window-" + next,
          data: { id: "uid-window-" + next, observed_prior_uid: prior },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "attachments",
          cursor: {
            all_mail: {
              uidvalidity: 123,
              backfilled_through_uid: next,
              completed_at: null,
            },
          },
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
        connector_id: "gmail-fixture-attachment-backfill",
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
    assert.deepEqual(pass1.flushedState, {
      attachments: {
        all_mail: {
          backfilled_through_uid: 50,
          completed_at: null,
          uidvalidity: 123,
        },
      },
    });
    assert.equal(harness.ingestedBatches[0]?.records?.[0]?.data?.observed_prior_uid, 0);

    const pass2 = await runCollectorConnector(baseConfig);
    assert.deepEqual(pass2.priorState, {
      attachments: {
        all_mail: {
          backfilled_through_uid: 50,
          completed_at: null,
          uidvalidity: 123,
        },
      },
    });
    assert.deepEqual(pass2.flushedState, {
      attachments: {
        all_mail: {
          backfilled_through_uid: 100,
          completed_at: null,
          uidvalidity: 123,
        },
      },
    });
    assert.equal(harness.ingestedBatches[1]?.records?.[0]?.data?.observed_prior_uid, 50);
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

test("runCollectorConnector validates the reference route before mutating durable outbox work", async () => {
  const harness = await startCollectorHarness({
    heartbeatStatus: 502,
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    seedBacklogRecordBatch({ connectorId: "fixture-route-preflight", queuePath });

    const fixture = await writeFixtureConnector({
      script: `
        process.stderr.write("fixture must not spawn when reference route fails\\n");
        process.exit(13);
      `,
    });

    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-route-preflight",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-1",
        }),
      (error: unknown) => {
        assert.ok(error instanceof LocalDeviceHttpError);
        if (error instanceof LocalDeviceHttpError) {
          assert.equal(error.status, 502);
        }
        return true;
      }
    );

    assert.equal(harness.ingestedBatches.length, 0, "preflight failure must not drain pending batches");
    assert.equal(harness.stateOps.length, 0, "preflight failure must not read or write source state");
    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const summary = outbox.summary({ sourceInstanceId: "src-1" });
      assert.equal(summary.ready, 1, "pending work must remain ready");
      assert.equal(summary.leased, 0, "pending work must not be leased");
      assert.equal(summary.retrying, 0, "pending work must not be marked retryable");
      assert.equal(summary.deadLetter, 0, "pending work must not be dead-lettered");
    } finally {
      outbox.close();
    }
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
    seedBacklogRecordBatch({ connectorId: "fixture-backlog-skip", queuePath });

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
    assert.equal(harness.heartbeats.at(-1)?.records_pending, 1);
    assert.equal((harness.heartbeats.at(-1)?.outbox as { retrying?: number } | undefined)?.retrying, 1);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector fails backlog-skip pass when terminal heartbeat is rejected", async () => {
  const harness = await startCollectorHarness({
    heartbeatStatuses: [200, 503],
    ingestFailureMode: "always-503",
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    seedBacklogRecordBatch({ connectorId: "fixture-backlog-heartbeat-fail", queuePath });

    const fixture = await writeFixtureConnector({
      script: `
        process.stderr.write("fixture should not spawn while backlog is pending\\n");
        process.exit(13);
      `,
    });

    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-backlog-heartbeat-fail",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          outboxPolicy: { retryBackoffMs: 60_000 },
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /local device request failed: 503/
    );
    assert.equal(harness.heartbeats.at(-1)?.status, "retrying");
    assert.equal(harness.heartbeats.at(-1)?.records_pending, 1);
  } finally {
    await harness.close();
  }
});

function seedBacklogRecordBatch(input: { connectorId: string; queuePath: string; sourceInstanceId?: string }): void {
  const sourceInstanceId = input.sourceInstanceId ?? "src-1";
  const outbox = new LocalDeviceOutbox({ path: input.queuePath });
  try {
    const records = transformRecordsToCollectorEnvelopes({
      batchId: "existing-batch",
      batchSeq: 1,
      connectorId: input.connectorId,
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
      sourceInstanceId,
    });
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({
        kind: "record_batch",
        parts: ["existing-batch"],
        sourceInstanceId,
      }),
      kind: "record_batch",
      payload: {
        batchId: "existing-batch",
        batchSeq: 1,
        connectorId: input.connectorId,
        deviceId: "device-1",
        records,
        sourceInstanceId,
      },
      sourceInstanceId,
    });
  } finally {
    outbox.close();
  }
}

test("a backlog-open second pass re-enqueues nothing: the durable rows are byte-identical before and after", async () => {
  // Target: a scheduled run must not rescan/re-enqueue the same tranche while
  // local backlog is open. The sharpest proof is row identity — the prior
  // pass's durable rows (id, body_hash, insert_order) must be unchanged after
  // a second pass whose connector child, if it ran, would emit new records.
  const harness = await startCollectorHarness({ ingestFailureMode: "always-503", priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const sourceInstanceId = "src-no-reenqueue";

    // Pass 1: ingest fails, so the child's records stay durably queued.
    const pass1Fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); }));
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", key: "m-1", data: { id: "m-1" }, emitted_at: "2026-05-19T12:00:00.000Z" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "STATE", stream: "messages", cursor: "m-1" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");
      `,
    });
    const pass1 = await runCollectorConnector({
      baseUrl: harness.url,
      batchSize: 1,
      connector: {
        args: [pass1Fixture],
        command: "node",
        connector_id: "fixture-no-reenqueue",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { retryBackoffMs: 60_000 },
      queuePath,
      sourceInstanceId,
    });
    assert.equal(pass1.recordsQueued, 1, "pass 1 must durably queue the record");

    // Snapshot the durable rows after pass 1.
    const snapshot = () => {
      const outbox = new LocalDeviceOutbox({ path: queuePath });
      try {
        return outbox
          .list({ sourceInstanceId })
          .map((row) => ({ body_hash: row.body_hash, id: row.id, insert_order: row.insert_order, kind: row.kind }));
      } finally {
        outbox.close();
      }
    };
    const before = snapshot();
    assert.ok(before.length >= 1, "expected at least the pass-1 record batch row");

    // Pass 2: ingest still fails (backlog stays open). This fixture would
    // emit a DISTINCT record if it ever spawned, so any re-scan would change
    // the row set. The backlog guard must skip the spawn entirely.
    const pass2Fixture = await writeFixtureConnector({
      script: `
        process.stderr.write("fixture must not spawn while backlog is open\\n");
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", key: "m-2", data: { id: "m-2" }, emitted_at: "2026-05-19T12:05:00.000Z" }) + "\\n");
        process.exit(0);
      `,
    });
    const pass2 = await runCollectorConnector({
      baseUrl: harness.url,
      batchSize: 1,
      connector: {
        args: [pass2Fixture],
        command: "node",
        connector_id: "fixture-no-reenqueue",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { retryBackoffMs: 60_000 },
      queuePath,
      sourceInstanceId,
    });

    assert.equal(pass2.skippedScanForBacklog, true, "pass 2 must skip scanning while backlog is open");
    assert.equal(pass2.recordsQueued, 0, "pass 2 must not enqueue any new records");
    const after = snapshot();
    assert.deepEqual(after, before, "the durable rows must be byte-identical: no re-enqueue of the same tranche");
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
    // The blocked-on-state-read heartbeat discriminates the stall shape so the
    // dashboard distinguishes a state-read block (re-run to clear) from a
    // dead-letter backlog — without leaking the raw state-read error text.
    const stateBlocked = heartbeatLastError(blockedHeartbeats.at(-1)?.last_error);
    assert.equal(stateBlocked?.kind, "state_read_failed");
    assert.equal(
      harness.heartbeats.at(-1)?.status,
      "blocked",
      "a definitive state-read block must be the final heartbeat"
    );
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector accepts exactly one terminal DONE and checkpoints nothing after it", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((resolve) => process.stdin.on("data", (chunk) => {
          buf += chunk;
          if (buf.includes("\\n")) resolve();
        }));
        process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "STATE", stream: "messages", cursor: "must-not-checkpoint" }) + "\\n");
      `,
    });
    const queuePath = await tempQueuePath();
    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-after-done",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-after-done",
        }),
      /emitted STATE after terminal DONE/
    );
    assert.equal(harness.stateOps.filter((operation) => operation.method === "PUT").length, 0);
  } finally {
    await harness.close();
  }
});

interface CollectorHarnessOptions {
  /** When set, the heartbeat endpoint returns this status instead of 200. */
  heartbeatStatus?: number;
  /** Per-heartbeat status overrides. Entries are consumed in request order. */
  heartbeatStatuses?: number[];
  ingestFailureMode?: "always-503";
  priorState?: Record<string, unknown> | null;
  /** When set, the GET state endpoint returns this status instead of 200. */
  stateReadStatus?: number;
}

function heartbeatLastError(input: unknown): {
  kind?: string;
  top_dead_letter_classes?: { count: number; error_class: string }[];
} | null {
  if (!isPlainObject(input)) {
    return null;
  }
  const parsed: {
    kind?: string;
    top_dead_letter_classes?: { count: number; error_class: string }[];
  } = {};
  if (typeof input.kind === "string") {
    parsed.kind = input.kind;
  }
  const topClasses = input.top_dead_letter_classes;
  if (Array.isArray(topClasses)) {
    parsed.top_dead_letter_classes = topClasses.flatMap(asDeadLetterClass);
  }
  return parsed;
}

function asDeadLetterClass(input: unknown): { count: number; error_class: string }[] {
  if (!isPlainObject(input) || typeof input.count !== "number" || typeof input.error_class !== "string") {
    return [];
  }
  return [{ count: input.count, error_class: input.error_class }];
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

interface CollectorHarness {
  close: () => Promise<void>;
  gapAcks: Record<string, unknown>[];
  gapRecoveries: Record<string, unknown>[];
  heartbeats: Array<{ status: string; [k: string]: unknown }>;
  ingestedBatches: Array<{ records?: Array<{ data?: Record<string, unknown> }>; [k: string]: unknown }>;
  stateOps: Array<{ body: unknown; method: string }>;
  url: string;
}

async function startCollectorHarness(options: CollectorHarnessOptions): Promise<CollectorHarness> {
  const stateOps: CollectorHarness["stateOps"] = [];
  const heartbeats: CollectorHarness["heartbeats"] = [];
  const ingestedBatches: CollectorHarness["ingestedBatches"] = [];
  const gapAcks: CollectorHarness["gapAcks"] = [];
  const gapRecoveries: CollectorHarness["gapRecoveries"] = [];
  let persistedState: Record<string, unknown> = options.priorState ? { ...options.priorState } : {};
  let heartbeatIndex = 0;

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
      const heartbeatStatus = options.heartbeatStatuses?.[heartbeatIndex++] ?? options.heartbeatStatus;
      if (heartbeatStatus && heartbeatStatus >= 400) {
        res.writeHead(heartbeatStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "synthetic_heartbeat_failure" } }));
        return;
      }
      sendJson(res, 200, { object: "device_exporter_heartbeat", status: "accepted" });
      return;
    }
    if (url.includes("/local-collector-gaps/recovered")) {
      const recovery = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      gapRecoveries.push(recovery);
      const reason = typeof recovery.reason === "string" ? recovery.reason : "policy_budget";
      const stream = typeof recovery.stream === "string" ? recovery.stream : null;
      sendJson(res, 200, {
        object: "device_local_collector_gap",
        device_id: "device-1",
        connector_id: recovery.connector_id ?? "unknown",
        connector_instance_id: "cin_fake",
        source_instance_id: recovery.source_instance_id ?? "src-1",
        gap_id: "gap_fake",
        stream: stream ? `local-collector/${reason}/${stream}` : `local-collector/${reason}`,
        reason,
        retryable: false,
        status: "recovered",
        attempt_count: 0,
        first_seen_at: null,
        first_seen_run_id: null,
        last_run_id: recovery.recovered_run_id ?? null,
        updated_at: new Date().toISOString(),
      });
      return;
    }
    if (url.includes("/local-collector-gaps")) {
      const ack = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      gapAcks.push(ack);
      const reason = typeof ack.reason === "string" ? ack.reason : "policy_budget";
      const stream = typeof ack.stream === "string" ? ack.stream : null;
      sendJson(res, 201, {
        object: "device_local_collector_gap",
        device_id: "device-1",
        connector_id: ack.connector_id ?? "unknown",
        connector_instance_id: "cin_fake",
        source_instance_id: ack.source_instance_id ?? "src-1",
        gap_id: "gap_fake",
        stream: stream ? `local-collector/${reason}/${stream}` : `local-collector/${reason}`,
        reason,
        retryable: ack.retryable ?? true,
        status: "pending",
        attempt_count: 0,
        first_seen_at: ack.first_seen_at ?? null,
        first_seen_run_id: ack.first_seen_run_id ?? null,
        last_run_id: ack.last_run_id ?? null,
        updated_at: new Date().toISOString(),
      });
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
    gapAcks,
    gapRecoveries,
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

test("runCollectorConnector caps one first-backfill scan without losing queued work", async () => {
  // The first-backfill safety valve is intentionally a runner-level backstop:
  // once the child has filled the configured per-run batch budget, already
  // emitted records stay durable, a retryable policy gap is reported, and
  // checkpoint state is withheld so the source can be retried safely.
  const recordCount = 10;
  const batchSize = 2;
  const maxEnqueuedBatchesPerRun = 2;
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
          cursor: "must-not-commit",
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
        connector_id: "fixture-first-backfill-budget",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { maxEnqueuedBatchesPerRun },
      queuePath,
      runId: "run-first-backfill-budget",
      sourceInstanceId: "src-first-backfill-budget",
    });

    assert.equal(result.scanBudgetExceeded, true);
    assert.equal(result.done, null);
    assert.equal(result.enqueuedBatches, maxEnqueuedBatchesPerRun);
    assert.equal(result.recordsQueued, batchSize * maxEnqueuedBatchesPerRun);
    assert.equal(result.flushedState, null);
    assert.equal(harness.heartbeats.at(-1)?.status, "retrying");

    const totalIngested = harness.ingestedBatches.reduce((sum, batch) => sum + (batch.records?.length ?? 0), 0);
    assert.equal(totalIngested, batchSize * maxEnqueuedBatchesPerRun);
    assert.equal(harness.gapAcks.filter((ack) => ack.reason === "policy_budget").length, 1);

    const verify = new LocalDeviceOutbox({ path: queuePath });
    try {
      const gaps = verify.list({ sourceInstanceId: "src-first-backfill-budget" }).filter((item) => item.kind === "gap");
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]?.status, "succeeded");
      assert.equal((gaps[0]?.payload as { reason?: unknown } | undefined)?.reason, "policy_budget");
      assert.match(
        String((gaps[0]?.payload as { details?: unknown } | undefined)?.details ?? ""),
        /^enqueued 2 batches >= /
      );
    } finally {
      verify.close();
    }

    const skippedRetry = await runCollectorConnector({
      baseUrl: harness.url,
      batchSize,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-first-backfill-budget",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { maxEnqueuedBatchesPerRun },
      queuePath,
      runId: "run-first-backfill-budget-same-policy",
      sourceInstanceId: "src-first-backfill-budget",
    });
    assert.equal(skippedRetry.skippedScanForBacklog, true, "same-policy scan-budget retries must not replay work");
    assert.equal(skippedRetry.enqueuedBatches, 0);
    assert.equal(harness.ingestedBatches.length, maxEnqueuedBatchesPerRun);

    const largerBudgetRetry = await runCollectorConnector({
      baseUrl: harness.url,
      batchSize,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-first-backfill-budget",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { maxEnqueuedBatchesPerRun: 16 },
      queuePath,
      runId: "run-first-backfill-budget-larger-policy",
      sourceInstanceId: "src-first-backfill-budget",
    });
    assert.equal(largerBudgetRetry.skippedScanForBacklog, false);
    assert.equal(largerBudgetRetry.scanBudgetExceeded, false);
    assert.deepEqual(largerBudgetRetry.flushedState, { messages: "must-not-commit" });
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
    // Three durable record_batch rows plus one deferred checkpoint must
    // remain in the outbox. With the backoff override, only the record
    // rows are in the retrying subset.
    assert.equal(result.outboxSummary.ready, 4);
    assert.equal(result.outboxSummary.retrying, 3);
    assert.equal(result.outboxSummary.deadLetter, 0);
    const verify = new LocalDeviceOutbox({ path: queuePath });
    try {
      const checkpointRows = verify.list({ sourceInstanceId: "src-1" }).filter((item) => item.kind === "checkpoint");
      assert.equal(checkpointRows.length, 1, "completed scan checkpoint must be durable even while records retry");
      assert.equal(checkpointRows[0]?.status, "ready");
    } finally {
      verify.close();
    }
    // Server saw no checkpoint PUT — the durable checkpoint must not be
    // sent before the record batches it summarizes are acknowledged.
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);
  } finally {
    await harness.close();
  }
});

test("drainCollectorOutbox blocks checkpoint behind retry-delayed predecessors by insert order", async () => {
  const fixedClock = () => new Date("2026-05-20T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: fixedClock, path: await tempQueuePath() });
  try {
    const record = outbox.enqueue({
      id: "zzzz-record-predecessor",
      kind: "record_batch",
      payload: {
        batchId: "batch-1",
        batchSeq: 1,
        connectorId: "fixture-checkpoint-order",
        deviceId: "device-1",
        records: [],
        sourceInstanceId: "src-order",
      },
      sourceInstanceId: "src-order",
    });
    const [claim] = outbox.claimReady({ holder: "seed", leaseMs: 60_000, sourceInstanceId: "src-order" });
    assert.equal(claim?.id, record.id);
    outbox.failRetryable({
      error: "temporary ingest failure",
      holder: "seed",
      id: record.id,
      leaseEpoch: claim.lease_epoch,
      retryBackoffMs: 60_000,
    });

    const checkpoint = outbox.enqueue({
      id: "aaaa-checkpoint-successor",
      kind: "checkpoint",
      payload: {
        connectorId: "fixture-checkpoint-order",
        sourceInstanceId: "src-order",
        state: { messages: "m-final" },
      },
      sourceInstanceId: "src-order",
    });
    assert.equal(record.created_at, checkpoint.created_at, "test must cover same-timestamp ordering");
    assert.ok(record.id > checkpoint.id, "test must cover the lexicographic ordering hazard");
    assert.ok(record.insert_order < checkpoint.insert_order, "outbox insert order must reflect semantic order");

    const putCalls: unknown[] = [];
    const client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState"> = {
      ackLocalCollectorGap() {
        return Promise.reject(new Error("must not ack gaps"));
      },
      ingestBatch() {
        return Promise.reject(new Error("retry-delayed predecessor must not be ready"));
      },
      putSourceInstanceState(request) {
        putCalls.push(request);
        return Promise.resolve({
          device_id: "device-1",
          object: "device_source_instance_state",
          source_instance_id: request.sourceInstanceId,
          state: request.state,
          updated_at: "2026-05-20T12:00:00.000Z",
        });
      },
    };

    const result = await drainCollectorOutbox({
      client,
      connectorId: "fixture-checkpoint-order",
      holderId: "drain",
      outbox,
      policy: {
        drainBatchSize: 1,
        leaseMs: 60_000,
        maxAttempts: 3,
        maxDrainDurationMs: 60_000,
        maxDrainIterations: 4,
        maxEnqueuedBatchesPerRun: 10_000,
        maxQueueDepth: 10_000,
        retryBackoffMs: 1,
      },
      sourceInstanceId: "src-order",
    });

    assert.equal(result.sent, 0);
    assert.equal(putCalls.length, 0, "checkpoint must not advance before retry-delayed predecessor succeeds");
    assert.equal(outbox.get(checkpoint.id)?.status, "ready");
  } finally {
    outbox.close();
  }
});

test("runCollectorConnector persists complete-scan checkpoint across undrained backlog before next scan", async () => {
  let ingestShouldFail = true;
  const harness = await startTogglableHarness({
    ingestHandler: () => (ingestShouldFail ? "fail" : "ok"),
    priorState: { messages: "m-old" },
  });
  try {
    const queuePath = await tempQueuePath();
    const pass1Fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        for (let i = 0; i < 30; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "m-" + i,
            data: { id: "m-" + i, pass: 1 },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-30",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 30,
        }) + "\\n");
      `,
    });
    const baseConfig = {
      baseUrl: harness.url,
      batchSize: 10,
      connector: {
        args: [pass1Fixture],
        command: "node",
        connector_id: "fixture-durable-checkpoint-backlog",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    } as const;

    const pass1 = await runCollectorConnector({
      ...baseConfig,
      // Leave the failed record batches durable and immediately ready for
      // pass 2; the next scan should prove checkpoint replay, not timer jitter.
      outboxPolicy: { maxDrainIterations: 1, retryBackoffMs: 0 },
    });
    assert.equal(pass1.scanBudgetExceeded, false);
    assert.equal(pass1.enqueuedBatches, 3);
    assert.equal(pass1.flushedState, null);
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);

    const afterPass1 = new LocalDeviceOutbox({ path: queuePath });
    try {
      const items = afterPass1.list({ sourceInstanceId: "src-1" });
      assert.equal(items.filter((item) => item.kind === "record_batch").length, 3);
      const checkpoints = items.filter((item) => item.kind === "checkpoint");
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0]?.status, "ready");
      assert.deepEqual((checkpoints[0]?.payload as { state?: unknown } | undefined)?.state, { messages: "m-30" });
    } finally {
      afterPass1.close();
    }

    ingestShouldFail = false;
    const eventsBeforePass2 = harness.events.length;
    const pass2Fixture = await writeFixtureConnector({
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
          key: "pass-2-observed-prior",
          data: { observed_prior: start.state?.messages ?? null },
          emitted_at: new Date().toISOString(),
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 1,
        }) + "\\n");
      `,
    });

    const pass2 = await runCollectorConnector({
      ...baseConfig,
      connector: { ...baseConfig.connector, args: [pass2Fixture] },
      outboxPolicy: { retryBackoffMs: 0 },
    });

    assert.deepEqual(pass2.priorState, { messages: "m-30" });
    assert.equal(harness.ingestedBatches.at(-1)?.records?.[0]?.data?.observed_prior, "m-30");
    const pass2Events = harness.events.slice(eventsBeforePass2).map((event) => event.label);
    const pass2DataEvents = pass2Events.filter((event) => event !== "heartbeat");
    assert.deepEqual(
      pass2DataEvents.slice(0, 5),
      ["ingest:ok", "ingest:ok", "ingest:ok", "state:PUT", "state:GET"],
      `expected pass 2 to drain records, then checkpoint, then read state; saw ${pass2Events.join(",")}`
    );
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
      const items = outbox.list({ sourceInstanceId: "src-1" });
      // No checkpoint row was enqueued because STATE never reached the runner.
      assert.equal(
        items.filter((item) => item.kind === "checkpoint").length,
        0,
        "checkpoint must not be enqueued when child fails mid-stream"
      );
      assert.equal(items.filter((item) => item.kind === "record_batch").length, 2);
      // A gap row is durably persisted alongside the streamed batches so
      // partial coverage stays first-class. Both record_batch rows and the
      // gap row are pending — the next runner pass sees them all.
      assert.equal(items.filter((item) => item.kind === "gap").length, 1);
      const summary = outbox.summary({ sourceInstanceId: "src-1" });
      assert.equal(summary.ready, 3, `expected 2 record batches + 1 gap row, got ${JSON.stringify(summary)}`);
    } finally {
      outbox.close();
    }
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector corrects the heartbeat off 'starting' to an outbox-derived status when the child fails mid-stream", async () => {
  // Regression for the codex collector stuck at "starting": the run emits a
  // "starting" heartbeat before streaming, then the child fails mid-stream and
  // the run throws BEFORE the final heartbeat. Without a corrective heartbeat
  // the last persisted status stays "starting" forever even though the
  // collector keeps delivering across runs. The runner must instead leave a
  // status derived from the durable outbox: here two streamed batches are left
  // pending (undrained), so the honest terminal status is "retrying", never
  // "starting".
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
            connector_id: "fixture-mid-stream-heartbeat",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          outboxPolicy: { retryBackoffMs: 60_000 },
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /fixture-mid-stream-heartbeat connector exited 9/
    );

    const startingCount = harness.heartbeats.filter((h) => h.status === "starting").length;
    assert.ok(startingCount >= 1, "the run must still emit the initial 'starting' heartbeat");
    const last = harness.heartbeats.at(-1);
    assert.equal(
      last?.status,
      "blocked",
      `a delivered failure gap must stay blocking until committed coverage STATE recovery; saw ${harness.heartbeats
        .map((h) => h.status)
        .join(",")}`
    );
    // Two streamed record batches plus the durable connector_child_failure gap
    // row the runner persists for partial coverage all remain pending.
    assert.equal(
      last?.records_pending,
      3,
      "two streamed batches and one gap row remain pending after the mid-stream failure"
    );
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector leaves a failure gap when prior backlog drains but the child fails before streaming", async () => {
  // Faithful reproduction of the live codex collector: an earlier pass left
  // record batches in the durable outbox, this pass's pre-scan drain delivers
  // them successfully (the source is healthily delivering), and then the child
  // fails before emitting any record of its own. The prior backlog may drain,
  // but this failed scan must create a durable gap: a quiet old outbox cannot
  // recover an incomplete new inventory.
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const seedOutbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const records = transformRecordsToCollectorEnvelopes({
        batchId: "prior-backlog-1",
        batchSeq: 1,
        connectorId: "codex",
        deviceId: "device-1",
        messages: [
          {
            data: { id: "prior-1" },
            emitted_at: "2026-06-01T00:00:00.000Z",
            key: "prior-1",
            stream: "sessions",
            type: "RECORD",
          },
        ],
        sourceInstanceId: "src-1",
      });
      seedOutbox.enqueue({
        id: buildLocalDeviceOutboxId({
          kind: "record_batch",
          parts: ["prior-backlog-1"],
          sourceInstanceId: "src-1",
        }),
        kind: "record_batch",
        payload: {
          batchId: "prior-backlog-1",
          batchSeq: 1,
          connectorId: "codex",
          deviceId: "device-1",
          records,
          sourceInstanceId: "src-1",
        },
        sourceInstanceId: "src-1",
      });
    } finally {
      seedOutbox.close();
    }

    // Child fails immediately after START without emitting any record, so the
    // backlog the pre-scan drain cleared is the only outbox state.
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        process.stderr.write("synthetic startup failure after backlog drain\\n");
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
            connector_id: "codex",
            runtime_requirements: { bindings: {} },
            streams: ["sessions"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /codex connector exited 7/
    );

    // The seeded backlog was delivered by the pre-scan drain.
    assert.equal(harness.ingestedBatches.length, 1, "pre-scan drain must deliver the prior backlog");
    const last = harness.heartbeats.at(-1);
    assert.equal(
      last?.status,
      "blocked",
      `a failed scan must stay blocked until committed coverage STATE recovery; saw ${harness.heartbeats
        .map((h) => h.status)
        .join(",")}`
    );
    assert.equal(last?.records_pending, 1, "the failed scan's recovery gap remains pending after the pre-scan drain");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector flushes a partial trailing batch when the child fails mid-stream and still does not advance the checkpoint", async () => {
  // Emit one full batch plus a partial trailing batch (less than batchSize),
  // then exit non-zero before emitting STATE or DONE. The runner must throw,
  // but BOTH the full batch and the partial batch must be durably enqueued
  // so the next pass can drain them. No checkpoint may be enqueued.
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
        // 20 = one full batch (batchSize), then 7 more = a valid partial batch.
        for (let i = 0; i < 27; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "m-" + i,
            data: { id: "m-" + i },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        await new Promise((r) => process.stdout.write("", () => r(undefined)));
        process.stderr.write("synthetic mid-stream failure with partial trailing batch\\n");
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
            connector_id: "fixture-streaming-partial-batch-failure",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          deviceId: "device-1",
          deviceToken: "device-token",
          outboxPolicy: { retryBackoffMs: 60_000 },
          queuePath,
          sourceInstanceId: "src-1",
        }),
      /fixture-streaming-partial-batch-failure connector exited 9/
    );

    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const items = outbox.list({ sourceInstanceId: "src-1" });
      const recordBatches = items.filter((item) => item.kind === "record_batch");
      // Both the full (20) and partial (7) batches must be durable.
      assert.equal(
        recordBatches.length,
        2,
        `expected full + partial record batches durable, got ${recordBatches.length}`
      );
      const totalRecords = recordBatches.reduce((sum, item) => {
        const payload = item.payload as { records: unknown[] };
        return sum + payload.records.length;
      }, 0);
      assert.equal(totalRecords, 27, `expected all 27 parsed records durable, got ${totalRecords}`);
      // No checkpoint row was enqueued because STATE never reached the runner.
      assert.equal(
        items.filter((item) => item.kind === "checkpoint").length,
        0,
        "checkpoint must not be enqueued when child fails mid-stream"
      );
    } finally {
      outbox.close();
    }
    assert.equal(harness.stateOps.filter((op) => op.method === "PUT").length, 0);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector recovers a stale-leased record batch and drains it without enqueuing a duplicate checkpoint", async () => {
  // Simulates crash-after-upload-before-local-ack: a prior runner instance
  // claimed a record batch, the lease expired before the row was
  // acknowledged. The next runner invocation must recover the expired
  // lease, drain the batch through ingest, and only then proceed. A
  // checkpoint must NOT be advanced on top of the recovered batch
  // because the prior STATE never reached this runner.
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const records = transformRecordsToCollectorEnvelopes({
      batchId: "stale-batch",
      batchSeq: 1,
      connectorId: "fixture-stale-lease-recovery",
      deviceId: "device-1",
      messages: [
        {
          data: { id: "m-stale" },
          emitted_at: "2026-05-19T12:00:00.000Z",
          key: "m-stale",
          stream: "messages",
          type: "RECORD",
        },
      ],
      sourceInstanceId: "src-1",
    });
    const staleBatchId = buildLocalDeviceOutboxId({
      kind: "record_batch",
      parts: ["stale-batch"],
      sourceInstanceId: "src-1",
    });
    // Seed the outbox using a frozen clock so we can lease the row at
    // T+0 with a one-second lease, then leave it leased at T+10s — the
    // runner's outbox (real clock, far in the future) will treat the
    // lease as expired and recover it before doing anything else.
    let setupClock = new Date("2026-05-19T12:00:00.000Z");
    const setupOutbox = new LocalDeviceOutbox({ clock: () => setupClock, path: queuePath });
    try {
      setupOutbox.enqueue({
        id: staleBatchId,
        kind: "record_batch",
        payload: {
          batchId: "stale-batch",
          batchSeq: 1,
          connectorId: "fixture-stale-lease-recovery",
          deviceId: "device-1",
          records,
          sourceInstanceId: "src-1",
        },
        sourceInstanceId: "src-1",
      });
      const [claim] = setupOutbox.claimReady({
        holder: "prior-runner",
        leaseMs: 1000,
        sourceInstanceId: "src-1",
      });
      assert.ok(claim, "prior runner must have claimed the seeded batch");
      setupClock = new Date("2026-05-19T12:00:10.000Z");
    } finally {
      setupOutbox.close();
    }

    // The new runner spawns a connector that emits zero records and no
    // STATE — exiting cleanly. The expectation is that the recovered
    // stale batch drains via ingest, and no checkpoint row is enqueued
    // (the recovered batch's STATE never reached this runner).
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
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
        connector_id: "fixture-stale-lease-recovery",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.recoveredLeases, 1, "the expired prior lease must be recovered");
    assert.equal(result.sentBatches, 1, "the recovered batch must drain through ingest");
    assert.equal(result.outboxSummary.ready, 0);
    assert.equal(result.outboxSummary.leased, 0);
    assert.equal(result.outboxSummary.deadLetter, 0);
    assert.equal(harness.ingestedBatches.length, 1);
    assert.equal(harness.ingestedBatches[0]?.records?.[0]?.data?.id, "m-stale");
    // No checkpoint may have been advanced on top of the recovered batch,
    // because the STATE that produced it never reached this runner.
    assert.equal(
      harness.stateOps.filter((op) => op.method === "PUT").length,
      0,
      "stale-recovered records must not push a checkpoint PUT this pass"
    );
    // Reopen the outbox to confirm the recovered row is succeeded and
    // no checkpoint row was enqueued at any point.
    const after = new LocalDeviceOutbox({ path: queuePath });
    try {
      const items = after.list({ sourceInstanceId: "src-1" });
      const recovered = items.find((item) => item.id === staleBatchId);
      assert.equal(recovered?.status, "succeeded", "the recovered batch must be marked succeeded");
      assert.equal(items.filter((item) => item.kind === "checkpoint").length, 0);
    } finally {
      after.close();
    }
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector auto-recovers transient local-device dead letters before scanning", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const seededId = seedDeadLetteredRecordBatch({
      connectorId: "fixture-transient-dead-letter",
      error: "local device request failed: 502",
      queuePath,
      sourceInstanceId: "src-transient-dead-letter",
    });
    const fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
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
        connector_id: "fixture-transient-dead-letter",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-transient-dead-letter",
    });

    assert.equal(result.autoRecoveredTransientDeadLetters, 1);
    assert.equal(result.sentBatches, 1, "the auto-recovered batch must drain through ingest");
    assert.equal(result.skippedScanForBacklog, false, "transient recovery should unblock a normal scan");
    assert.equal(result.done?.status, "succeeded");
    assert.equal(result.outboxSummary.deadLetter, 0);
    assert.equal(harness.ingestedBatches.length, 1);
    const after = new LocalDeviceOutbox({ path: queuePath });
    try {
      assert.equal(after.get(seededId)?.status, "succeeded");
    } finally {
      after.close();
    }
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector preserves terminal local-device dead letters", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const seededId = seedDeadLetteredRecordBatch({
      connectorId: "fixture-terminal-dead-letter",
      error: "local device request failed: 400 invalid_request",
      queuePath,
      sourceInstanceId: "src-terminal-dead-letter",
    });
    const fixture = await writeFixtureConnector({
      script: `
        throw new Error("terminal dead-letter test connector should not spawn");
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-terminal-dead-letter",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-terminal-dead-letter",
    });

    assert.equal(result.autoRecoveredTransientDeadLetters, 0);
    assert.equal(result.skippedScanForBacklog, true);
    assert.equal(result.done, null);
    assert.equal(result.sentBatches, 0);
    assert.equal(result.outboxSummary.deadLetter, 1);
    const after = new LocalDeviceOutbox({ path: queuePath });
    try {
      const terminal = after.get(seededId);
      assert.equal(terminal?.status, "dead_letter");
      assert.equal(terminal?.last_error, "local device request failed: 400 invalid_request");
    } finally {
      after.close();
    }
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector drains a prior pass's enqueued backlog before scanning again", async () => {
  // Models crash-after-enqueue-before-upload-acknowledgement across two
  // runner invocations using one harness whose ingest can be toggled.
  // Pass 1: ingest always fails. Records stream into the outbox and
  // remain retryable. Pass 2: ingest succeeds. The runner must drain
  // the prior pass's backlog (the pre-scan drain) and only then spawn a
  // connector child; the child here emits zero new records, so the
  // server-side ingest count equals the pass-1 backlog size.
  let ingestShouldFail = true;
  let ingestSucceededCount = 0;
  const harness = await startTogglableHarness({
    ingestHandler: () => (ingestShouldFail ? "fail" : "ok"),
    onIngestSucceeded: () => {
      ingestSucceededCount++;
    },
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    const pass1Fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        for (let i = 0; i < 30; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "m-" + i,
            data: { id: "m-" + i, pass: 1 },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "m-30",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 30,
        }) + "\\n");
      `,
    });

    const baseConfig = {
      baseUrl: harness.url,
      batchSize: 10,
      connector: {
        args: [pass1Fixture],
        command: "node",
        connector_id: "fixture-2pass-enqueue-before-ack",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      sourceInstanceId: "src-1",
    } as const;

    const pass1 = await runCollectorConnector({
      ...baseConfig,
      // Stop after one drain iteration so pass 1 leaves failed-but-ready
      // durable work for pass 2 without relying on timer precision.
      outboxPolicy: { maxDrainIterations: 1, retryBackoffMs: 0 },
    });
    assert.equal(pass1.enqueuedBatches, 3, "pass 1 must enqueue three durable batches");
    assert.equal(pass1.sentBatches, 0, "pass 1 must not acknowledge any batch (ingest fails)");
    assert.equal(pass1.flushedState, null, "checkpoint must not advance while record work pending");
    assert.equal(ingestSucceededCount, 0);

    ingestShouldFail = false;
    const eventsBeforePass2 = harness.events.length;
    const pass2Started = harness.ingestedBatches.length;

    // The pass-2 child emits zero records — so any ingest call during
    // pass 2 must come from the pre-scan drain of pass-1 backlog.
    const pass2Fixture = await writeFixtureConnector({
      script: `
        let buf = "";
        await new Promise((r) => process.stdin.on("data", (c) => {
          buf += c;
          if (buf.includes("\\n")) r();
        }));
        process.stdout.write(JSON.stringify({
          type: "DONE",
          status: "succeeded",
          records_emitted: 0,
        }) + "\\n");
      `,
    });

    const pass2 = await runCollectorConnector({
      ...baseConfig,
      connector: { ...baseConfig.connector, args: [pass2Fixture] },
      outboxPolicy: { retryBackoffMs: 0 },
    });

    assert.equal(pass2.recordsQueued, 0, "pass 2 child must not produce new records");
    assert.equal(pass2.sentBatches, 3, "pass 2 must drain the three pass-1 backlog batches");
    assert.equal(pass2.outboxSummary.ready, 0);
    assert.equal(pass2.outboxSummary.leased, 0);
    assert.equal(pass2.outboxSummary.deadLetter, 0);
    assert.equal(
      harness.ingestedBatches.length - pass2Started,
      3,
      "pass 2 server must observe exactly the pass-1 backlog batches"
    );
    // Critical ordering: the pre-scan drain must call ingest before the
    // runner reads prior state for the new spawn. Equivalent: the first
    // state GET of pass 2 must come after the backlog ingest calls.
    const pass2Events = harness.events.slice(eventsBeforePass2).map((event) => event.label);
    const pass2DataEvents = pass2Events.filter((event) => event !== "heartbeat");
    assert.deepEqual(
      pass2DataEvents.slice(0, 5),
      ["ingest:ok", "ingest:ok", "ingest:ok", "state:PUT", "state:GET"],
      `expected pass 2 to drain backlog and checkpoint before state read; saw ${pass2Events.join(",")}`
    );
    assert.deepEqual(pass2.priorState, { messages: "m-30" });
    // Pass-2 child emitted no STATE of its own, so no new checkpoint
    // PUT happens after the pre-scan durable checkpoint is flushed.
    assert.equal(pass2.flushedState, null);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector skips spawn and reports blocked when queue depth crosses the configured ceiling", async () => {
  // Seeds the outbox with N+1 retryable batches that will not drain
  // (ingest fails) and runs with maxQueueDepth: N. The runner must
  // skip spawning a new child and emit an honest `blocked` heartbeat
  // rather than continuing to grow the backlog.
  const harness = await startCollectorHarness({
    ingestFailureMode: "always-503",
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    const maxQueueDepth = 3;
    const seedCount = maxQueueDepth + 1;
    const seedOutbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      for (let i = 0; i < seedCount; i++) {
        const records = transformRecordsToCollectorEnvelopes({
          batchId: `seed-batch-${i}`,
          batchSeq: i + 1,
          connectorId: "fixture-queue-depth-blocked",
          deviceId: "device-1",
          messages: [
            {
              data: { id: `seed-${i}` },
              emitted_at: "2026-05-19T12:00:00.000Z",
              key: `seed-${i}`,
              stream: "messages",
              type: "RECORD",
            },
          ],
          sourceInstanceId: "src-1",
        });
        seedOutbox.enqueue({
          id: buildLocalDeviceOutboxId({
            kind: "record_batch",
            parts: [`seed-batch-${i}`],
            sourceInstanceId: "src-1",
          }),
          kind: "record_batch",
          payload: {
            batchId: `seed-batch-${i}`,
            batchSeq: i + 1,
            connectorId: "fixture-queue-depth-blocked",
            deviceId: "device-1",
            records,
            sourceInstanceId: "src-1",
          },
          sourceInstanceId: "src-1",
        });
      }
    } finally {
      seedOutbox.close();
    }

    const fixture = await writeFixtureConnector({
      script: `
        process.stderr.write("fixture must not spawn while queue depth is over the ceiling\\n");
        process.exit(17);
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-queue-depth-blocked",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      // Long retry backoff so the seeded batches stay retrying rather
      // than collapsing to ready during a possible second drain pass.
      outboxPolicy: { maxQueueDepth, retryBackoffMs: 60_000 },
      queuePath,
      sourceInstanceId: "src-1",
    });

    assert.equal(result.skippedScanForBacklog, true);
    // seedCount record_batch rows plus the policy_budget gap row the
    // runner enqueued to make the depth-blocked deferment first-class.
    assert.equal(result.outboxSummary.total, seedCount + 1);
    assert.ok(
      result.outboxSummary.ready + result.outboxSummary.leased >= maxQueueDepth,
      "queue depth must remain over the configured ceiling"
    );
    // Heartbeat must be honest about the depth-blocked posture.
    assert.equal(harness.heartbeats.at(-1)?.status, "blocked");
    assert.equal(harness.heartbeats.at(-1)?.records_pending, seedCount + 1);
    // No new state ops happened because the runner skipped the spawn.
    assert.equal(harness.stateOps.length, 0);
  } finally {
    await harness.close();
  }
});

test("drainCollectorOutbox stops between iterations when the duration budget is exceeded", async () => {
  // Seed the outbox with several retryable batches and a slow client.
  // With a tight maxDrainDurationMs the drain must stop cleanly
  // between iterations and surface the remaining work in the next
  // runner invocation.
  const queuePath = await tempQueuePath();
  const outbox = new LocalDeviceOutbox({ path: queuePath });
  try {
    for (let i = 0; i < 5; i++) {
      const records = transformRecordsToCollectorEnvelopes({
        batchId: `slow-batch-${i}`,
        batchSeq: i + 1,
        connectorId: "fixture-drain-duration",
        deviceId: "device-1",
        messages: [
          {
            data: { id: `slow-${i}` },
            emitted_at: "2026-05-19T12:00:00.000Z",
            key: `slow-${i}`,
            stream: "messages",
            type: "RECORD",
          },
        ],
        sourceInstanceId: "src-1",
      });
      outbox.enqueue({
        id: buildLocalDeviceOutboxId({
          kind: "record_batch",
          parts: [`slow-batch-${i}`],
          sourceInstanceId: "src-1",
        }),
        kind: "record_batch",
        payload: {
          batchId: `slow-batch-${i}`,
          batchSeq: i + 1,
          connectorId: "fixture-drain-duration",
          deviceId: "device-1",
          records,
          sourceInstanceId: "src-1",
        },
        sourceInstanceId: "src-1",
      });
    }

    const slowClient: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState"> = {
      ackLocalCollectorGap() {
        return Promise.reject(new Error("duration drain test must not ack gaps"));
      },
      async ingestBatch() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ok: true };
      },
      putSourceInstanceState() {
        return Promise.reject(new Error("duration drain test must not send checkpoints"));
      },
    };

    const result = await drainCollectorOutbox({
      client: slowClient,
      connectorId: "fixture-drain-duration",
      holderId: "holder-duration",
      outbox,
      policy: {
        drainBatchSize: 1,
        leaseMs: 60_000,
        maxAttempts: 5,
        maxDrainDurationMs: 25,
        maxDrainIterations: 256,
        maxEnqueuedBatchesPerRun: 2048,
        maxQueueDepth: 10_000,
        retryBackoffMs: 30_000,
      },
      sourceInstanceId: "src-1",
    });

    assert.equal(result.durationBudgetExceeded, true, "drain must mark the duration budget as exceeded");
    assert.ok(result.sent < 5, `drain must stop before sending all 5 batches; sent ${result.sent}`);
    const remaining = outbox.summary({ sourceInstanceId: "src-1" });
    assert.ok(remaining.ready + remaining.leased > 0, "remaining work must surface for the next pass");
    assert.equal(remaining.deadLetter, 0);
  } finally {
    outbox.close();
  }
});

test("drainCollectorOutbox does not crash when batch-claimed work expires before processing", async () => {
  let now = new Date("2026-05-19T12:00:00.000Z");
  const queuePath = await tempQueuePath();
  const outbox = new LocalDeviceOutbox({ clock: () => now, path: queuePath });
  try {
    for (let i = 0; i < 3; i++) {
      const records = transformRecordsToCollectorEnvelopes({
        batchId: `lease-batch-${i}`,
        batchSeq: i + 1,
        connectorId: "fixture-lease",
        deviceId: "device-1",
        messages: [
          {
            data: { id: `lease-${i}` },
            emitted_at: "2026-05-19T12:00:00.000Z",
            key: `lease-${i}`,
            stream: "messages",
            type: "RECORD",
          },
        ],
        sourceInstanceId: "src-1",
      });
      outbox.enqueue({
        id: buildLocalDeviceOutboxId({
          kind: "record_batch",
          parts: [`lease-batch-${i}`],
          sourceInstanceId: "src-1",
        }),
        kind: "record_batch",
        payload: {
          batchId: `lease-batch-${i}`,
          batchSeq: i + 1,
          connectorId: "fixture-lease",
          deviceId: "device-1",
          records,
          sourceInstanceId: "src-1",
        },
        sourceInstanceId: "src-1",
      });
    }

    const slowClient: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState"> = {
      ackLocalCollectorGap() {
        return Promise.reject(new Error("lease test must not ack gaps"));
      },
      ingestBatch() {
        now = new Date(now.getTime() + 40);
        return Promise.resolve({ ok: true });
      },
      putSourceInstanceState() {
        return Promise.reject(new Error("lease test must not send checkpoints"));
      },
    };

    const result = await drainCollectorOutbox({
      client: slowClient,
      connectorId: "fixture-lease",
      holderId: "holder-lease",
      outbox,
      policy: {
        drainBatchSize: 3,
        leaseMs: 50,
        maxAttempts: 5,
        maxDrainDurationMs: 60_000,
        maxDrainIterations: 4,
        maxEnqueuedBatchesPerRun: 2048,
        maxQueueDepth: 10_000,
        retryBackoffMs: 30_000,
      },
      sourceInstanceId: "src-1",
    });

    assert.equal(result.sent, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.deadLettered, 0);
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).staleLeases, 1);
  } finally {
    outbox.close();
  }
});

async function startTogglableHarness(options: {
  ingestHandler: () => "fail" | "ok";
  onIngestSucceeded?: () => void;
  priorState?: Record<string, unknown> | null;
}): Promise<CollectorHarness & { events: Array<{ label: string }> }> {
  const events: Array<{ label: string }> = [];
  const stateOps: CollectorHarness["stateOps"] = [];
  const heartbeats: CollectorHarness["heartbeats"] = [];
  const ingestedBatches: CollectorHarness["ingestedBatches"] = [];
  const gapAcks: CollectorHarness["gapAcks"] = [];
  const gapRecoveries: CollectorHarness["gapRecoveries"] = [];
  let persistedState: Record<string, unknown> = options.priorState ? { ...options.priorState } : {};

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "";
    const body = await readBody(req);
    const parsed = body ? safeJsonParse(body) : null;

    if (url.endsWith("/state") && (method === "GET" || method === "PUT")) {
      events.push({ label: `state:${method}` });
      stateOps.push({ body: parsed, method });
      if (method === "GET") {
        sendJson(res, 200, {
          object: "device_source_instance_state",
          device_id: "device-1",
          source_instance_id: "src-1",
          state: persistedState,
          updated_at: null,
        });
        return;
      }
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
      events.push({ label: "heartbeat" });
      heartbeats.push(parsed as { status: string });
      sendJson(res, 200, { object: "device_exporter_heartbeat", status: "accepted" });
      return;
    }
    if (url.includes("/local-collector-gaps/recovered")) {
      const recovery = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      events.push({ label: "gap-recovered" });
      gapRecoveries.push(recovery);
      const reason = typeof recovery.reason === "string" ? recovery.reason : "policy_budget";
      sendJson(res, 200, {
        object: "device_local_collector_gap",
        device_id: "device-1",
        connector_id: recovery.connector_id ?? "unknown",
        connector_instance_id: "cin_fake",
        source_instance_id: recovery.source_instance_id ?? "src-1",
        gap_id: "gap_fake",
        stream: `local-collector/${reason}`,
        reason,
        retryable: false,
        status: "recovered",
        attempt_count: 0,
        first_seen_at: null,
        first_seen_run_id: null,
        last_run_id: recovery.recovered_run_id ?? null,
        updated_at: new Date().toISOString(),
      });
      return;
    }
    if (url.includes("/local-collector-gaps")) {
      const ack = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      events.push({ label: "gap-ack" });
      gapAcks.push(ack);
      const reason = typeof ack.reason === "string" ? ack.reason : "policy_budget";
      sendJson(res, 201, {
        object: "device_local_collector_gap",
        device_id: "device-1",
        connector_id: ack.connector_id ?? "unknown",
        connector_instance_id: "cin_fake",
        source_instance_id: ack.source_instance_id ?? "src-1",
        gap_id: "gap_fake",
        stream: `local-collector/${reason}`,
        reason,
        retryable: ack.retryable ?? true,
        status: "pending",
        attempt_count: 0,
        first_seen_at: ack.first_seen_at ?? null,
        first_seen_run_id: ack.first_seen_run_id ?? null,
        last_run_id: ack.last_run_id ?? null,
        updated_at: new Date().toISOString(),
      });
      return;
    }
    if (url.includes("/ingest-batches")) {
      const ingestResult = options.ingestHandler();
      events.push({ label: `ingest:${ingestResult}` });
      if (ingestResult === "fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "synthetic_unavailable" } }));
        return;
      }
      ingestedBatches.push(parsed as { records?: Array<{ data?: Record<string, unknown> }> });
      options.onIngestSucceeded?.();
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
    throw new Error("collector togglable harness failed to start");
  }
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    events,
    gapAcks,
    gapRecoveries,
    heartbeats,
    ingestedBatches,
    stateOps,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function writeFixtureConnector(input: { script: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-fixture-connector-"));
  const path = join(dir, "fixture.mjs");
  await writeFile(
    path,
    `(async () => {\n${input.script}\n})().catch((err) => { process.stderr.write(String(err)); process.exit(1); });\n`
  );
  return path;
}

test("runCollectorConnector enqueues a policy-budget gap row when queue depth blocks the scan", async () => {
  // Seed the outbox above the configured ceiling so the runner takes the
  // queue-depth skip-scan branch. The runner must persist a durable
  // gap row describing the deferred scan, in addition to skipping the
  // connector spawn. The gap row must remain retryable across drain
  // attempts (destination route not implemented yet) so partial
  // progress stays honest and targetable.
  const harness = await startCollectorHarness({
    ingestFailureMode: "always-503",
    priorState: {},
  });
  try {
    const queuePath = await tempQueuePath();
    const maxQueueDepth = 2;
    const seedCount = maxQueueDepth + 1;
    const seedOutbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      for (let i = 0; i < seedCount; i++) {
        const records = transformRecordsToCollectorEnvelopes({
          batchId: `seed-batch-${i}`,
          batchSeq: i + 1,
          connectorId: "fixture-gap-policy-budget",
          deviceId: "device-1",
          messages: [
            {
              data: { id: `seed-${i}` },
              emitted_at: "2026-05-19T12:00:00.000Z",
              key: `seed-${i}`,
              stream: "messages",
              type: "RECORD",
            },
          ],
          sourceInstanceId: "src-gap-policy",
        });
        seedOutbox.enqueue({
          id: buildLocalDeviceOutboxId({
            kind: "record_batch",
            parts: [`seed-batch-${i}`],
            sourceInstanceId: "src-gap-policy",
          }),
          kind: "record_batch",
          payload: {
            batchId: `seed-batch-${i}`,
            batchSeq: i + 1,
            connectorId: "fixture-gap-policy-budget",
            deviceId: "device-1",
            records,
            sourceInstanceId: "src-gap-policy",
          },
          sourceInstanceId: "src-gap-policy",
        });
      }
    } finally {
      seedOutbox.close();
    }

    const fixture = await writeFixtureConnector({
      script: `
        process.stderr.write("fixture must not spawn while queue depth blocks the scan\\n");
        process.exit(19);
      `,
    });

    const result = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-gap-policy-budget",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { maxQueueDepth, retryBackoffMs: 60_000 },
      queuePath,
      runId: "run-policy-1",
      sourceInstanceId: "src-gap-policy",
    });

    assert.equal(result.skippedScanForBacklog, true);

    // Inspect durable state directly: the gap row must be visible and
    // carry the expected reason/retryability/first-seen metadata.
    const verify = new LocalDeviceOutbox({ path: queuePath });
    try {
      const items = verify.list({ sourceInstanceId: "src-gap-policy" });
      const gaps = items.filter((i) => i.kind === "gap");
      assert.equal(gaps.length, 1, `expected exactly one gap row, got ${gaps.length}`);
      const firstGap = gaps[0];
      assert.ok(firstGap, "expected gap row");
      const payload = firstGap.payload as Record<string, unknown>;
      assert.equal(payload.reason, "policy_budget");
      assert.equal(payload.retryable, true);
      assert.equal(payload.connectorId, "fixture-gap-policy-budget");
      assert.equal(payload.sourceInstanceId, "src-gap-policy");
      assert.equal(payload.firstSeenRunId, "run-policy-1");
      assert.ok(typeof payload.firstSeenAt === "string");
      assert.ok(typeof payload.nextAttemptBackoffMs === "number");
      // The gap row must surface in pending work for honest reporting.
      assert.ok(result.outboxSummary.ready >= 1);
    } finally {
      verify.close();
    }

    // A second invocation with the same conditions must NOT add a new
    // gap row — the deterministic id makes re-observation idempotent.
    const repeat = await runCollectorConnector({
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-gap-policy-budget",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      outboxPolicy: { maxQueueDepth, retryBackoffMs: 60_000 },
      queuePath,
      runId: "run-policy-2",
      sourceInstanceId: "src-gap-policy",
    });
    assert.equal(repeat.skippedScanForBacklog, true);
    const verify2 = new LocalDeviceOutbox({ path: queuePath });
    try {
      const gaps = verify2.list({ sourceInstanceId: "src-gap-policy" }).filter((i) => i.kind === "gap");
      assert.equal(gaps.length, 1, "re-observation must be idempotent");
      // The gap row must have been acked by the device-exporter gap
      // route — otherwise the runner self-blocks on the gap row forever.
      assert.equal(gaps[0]?.status, "succeeded", "gap row must drain to the server");
    } finally {
      verify2.close();
    }
    // The drain must have hit the server's gap acknowledgement route.
    const policyAcks = harness.gapAcks.filter((ack) => ack.reason === "policy_budget");
    assert.ok(policyAcks.length >= 1, "expected at least one gap ack call");
    assert.equal(policyAcks[0]?.connector_id, "fixture-gap-policy-budget");
    assert.equal(policyAcks[0]?.source_instance_id, "src-gap-policy");
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector records a connector_child_failure gap when the child exits non-zero after partial flush", async () => {
  // Emit a couple of records, then exit with a non-zero status. The
  // runner must flush the partial batch AND persist a durable gap row
  // describing the partial-coverage child failure. State must remain
  // un-checkpointed because there is unacknowledged record + gap work.
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
        for (let i = 0; i < 2; i++) {
          process.stdout.write(JSON.stringify({
            type: "RECORD",
            stream: "messages",
            key: "partial-" + i,
            data: { id: "partial-" + i },
            emitted_at: new Date().toISOString(),
          }) + "\\n");
        }
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "messages",
          cursor: "partial-cursor",
        }) + "\\n");
        process.stderr.write("synthetic child crash token=super-secret-value otp=123456 opaque=abcdefghijklmnopqrstuvwxyz123456\\n");
        process.exit(31);
      `,
    });

    await assert.rejects(
      () =>
        runCollectorConnector({
          baseUrl: harness.url,
          connector: {
            args: [fixture],
            command: "node",
            connector_id: "fixture-gap-child-failure",
            runtime_requirements: { bindings: {} },
            streams: ["messages"],
          },
          batchSize: 1, // force the partial batch to flush before exit
          deviceId: "device-1",
          deviceToken: "device-token",
          queuePath,
          runId: "run-child-fail-1",
          sourceInstanceId: "src-child-fail",
        }),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /connector exited 31/);
        assert.equal(JSON.stringify(error).includes("super-secret-value"), false);
        assert.equal(JSON.stringify(error).includes("123456"), false);
        assert.equal(JSON.stringify(error).includes("abcdefghijklmnopqrstuvwxyz123456"), false);
        return true;
      }
    );

    const verify = new LocalDeviceOutbox({ path: queuePath });
    try {
      const items = verify.list({ sourceInstanceId: "src-child-fail" });
      const gaps = items.filter((i) => i.kind === "gap");
      const batches = items.filter((i) => i.kind === "record_batch");
      assert.ok(batches.length >= 1, "partial record batches must reach the outbox");
      assert.equal(gaps.length, 1, `expected exactly one gap row, got ${gaps.length}`);
      const firstGap = gaps[0];
      assert.ok(firstGap, "expected gap row");
      const payload = firstGap.payload as Record<string, unknown>;
      assert.equal(payload.reason, "connector_child_failure");
      assert.equal(payload.retryable, true);
      assert.equal(payload.firstSeenRunId, "run-child-fail-1");
      assert.equal(JSON.stringify(payload).includes("super-secret-value"), false);
      assert.equal(JSON.stringify(payload).includes("123456"), false);
      assert.equal(JSON.stringify(payload).includes("abcdefghijklmnopqrstuvwxyz123456"), false);
      assert.match(String(payload.details), /\[REDACTED]/);

      // Checkpoint must NOT have been committed past the unacknowledged
      // records + gap row.
      const putOps = harness.stateOps.filter((op) => op.method === "PUT");
      assert.equal(putOps.length, 0);
    } finally {
      verify.close();
    }
  } finally {
    await harness.close();
  }
});

test("drainCollectorOutbox delivers gap rows via ackLocalCollectorGap and acknowledges them", async () => {
  // The drain must deliver gap rows to the device-exporter
  // acknowledgement route, then mark the local row succeeded so the
  // outbox does not self-block the runner from making future progress.
  const outbox = new LocalDeviceOutbox({ path: await tempQueuePath() });
  try {
    outbox.enqueue({
      id: "src-drain-gap:policy",
      kind: "gap",
      payload: {
        connectorId: "fixture-drain",
        firstSeenAt: "2026-05-19T12:00:00.000Z",
        firstSeenRunId: "run-1",
        nextAttemptBackoffMs: 60_000,
        reason: "policy_budget",
        retryable: true,
        sourceInstanceId: "src-drain-gap",
      },
      sourceInstanceId: "src-drain-gap",
    });

    const ackCalls: unknown[] = [];
    const client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState"> = {
      ackLocalCollectorGap(request) {
        ackCalls.push(request);
        return Promise.resolve({
          attempt_count: 0,
          connector_id: request.connector_id,
          connector_instance_id: "cin_fake",
          device_id: "dev_fake",
          first_seen_at: request.first_seen_at,
          first_seen_run_id: request.first_seen_run_id ?? null,
          gap_id: "gap_fake",
          last_run_id: request.last_run_id ?? null,
          object: "device_local_collector_gap",
          reason: request.reason,
          retryable: request.retryable,
          source_instance_id: request.source_instance_id,
          status: "pending",
          stream: `local-collector/${request.reason}`,
          updated_at: "2026-05-19T12:00:00.000Z",
        });
      },
      ingestBatch() {
        return Promise.reject(new Error("gap drain test must not ingest"));
      },
      putSourceInstanceState() {
        return Promise.reject(new Error("gap drain test must not write state"));
      },
    };

    const result = await drainCollectorOutbox({
      client,
      connectorId: "fixture-drain",
      holderId: "holder-1",
      outbox,
      policy: {
        drainBatchSize: 1,
        leaseMs: 60_000,
        maxAttempts: 3,
        maxDrainDurationMs: 60_000,
        maxDrainIterations: 16,
        maxEnqueuedBatchesPerRun: 2048,
        maxQueueDepth: 10_000,
        retryBackoffMs: 1,
      },
      sourceInstanceId: "src-drain-gap",
    });

    assert.equal(result.sent, 1);
    assert.equal(result.sentByKind.gap, 1);
    assert.equal(ackCalls.length, 1);
    const item = outbox.get("src-drain-gap:policy");
    assert.equal(item?.status, "succeeded");
    const summary = outbox.summary({ sourceInstanceId: "src-drain-gap" });
    assert.equal(summary.ready, 0);
    assert.equal(summary.leased, 0);
    assert.equal(summary.deadLetter, 0);
    assert.equal(summary.succeeded, 1);
  } finally {
    outbox.close();
  }
});

test("drainCollectorOutbox dead-letters a malformed gap row instead of poisoning the drain", async () => {
  // A gap row whose payload is missing required fields must dead-letter
  // before any HTTP call so the outbox cannot loop on a permanently
  //-broken row.
  const outbox = new LocalDeviceOutbox({ path: await tempQueuePath() });
  try {
    outbox.enqueue({
      id: "src-bad-gap:broken",
      kind: "gap",
      // Missing required fields (firstSeenAt, nextAttemptBackoffMs, retryable).
      payload: {
        connectorId: "fixture-bad",
        reason: "policy_budget",
        sourceInstanceId: "src-bad-gap",
      } as unknown,
      sourceInstanceId: "src-bad-gap",
    });

    const client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState"> = {
      ackLocalCollectorGap() {
        return Promise.reject(new Error("malformed gap must dead-letter before ack"));
      },
      ingestBatch() {
        return Promise.reject(new Error("must not ingest"));
      },
      putSourceInstanceState() {
        return Promise.reject(new Error("must not write state"));
      },
    };

    const result = await drainCollectorOutbox({
      client,
      connectorId: "fixture-bad",
      holderId: "holder-bad",
      outbox,
      policy: {
        drainBatchSize: 1,
        leaseMs: 60_000,
        maxAttempts: 3,
        maxDrainDurationMs: 60_000,
        maxDrainIterations: 4,
        maxEnqueuedBatchesPerRun: 2048,
        maxQueueDepth: 10_000,
        retryBackoffMs: 1,
      },
      sourceInstanceId: "src-bad-gap",
    });

    assert.equal(result.sent, 0);
    assert.equal(result.deadLettered, 1);
    const item = outbox.get("src-bad-gap:broken");
    assert.equal(item?.status, "dead_letter");
  } finally {
    outbox.close();
  }
});

test("drainCollectorOutbox sanitizes secrets out of the persisted last_error on dead-letter", async () => {
  // `last_error` is a durable, operator-readable field. Even though the
  // network client (LocalDeviceHttpError) already exposes only a sanitized
  // envelope detail, failOutboxItem is the generic persistence boundary for
  // *every* error type, so it must guarantee no bearer token, cookie, OTP,
  // long opaque credential, or unbounded body is ever stored.
  const outbox = new LocalDeviceOutbox({ path: await tempQueuePath() });
  try {
    const records = transformRecordsToCollectorEnvelopes({
      batchId: "leak-batch",
      batchSeq: 1,
      connectorId: "fixture-leak",
      deviceId: "device-1",
      messages: [
        {
          data: { id: "m-1", note: "ssn 123-45-6789 should never reach last_error" },
          emitted_at: "2026-05-19T12:00:00.000Z",
          key: "m-1",
          stream: "messages",
          type: "RECORD",
        },
      ],
      sourceInstanceId: "src-leak",
    });
    outbox.enqueue({
      id: "src-leak:record_batch:1",
      kind: "record_batch",
      payload: {
        batchId: "leak-batch",
        batchSeq: 1,
        connectorId: "fixture-leak",
        deviceId: "device-1",
        records,
        sourceInstanceId: "src-leak",
      },
      sourceInstanceId: "src-leak",
    });

    const bearer = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cookie = "session=ZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState"> = {
      ackLocalCollectorGap() {
        return Promise.reject(new Error("must not ack"));
      },
      ingestBatch() {
        // An error message that carries secrets and a long body. A naive
        // persistence path would write all of this into last_error verbatim.
        return Promise.reject(
          new Error(
            `ingest failed 401 authorization: Bearer ${bearer} cookie: ${cookie} otp 482913 body=${"x".repeat(500)}`
          )
        );
      },
      putSourceInstanceState() {
        return Promise.reject(new Error("must not write state"));
      },
    };

    const result = await drainCollectorOutbox({
      client,
      connectorId: "fixture-leak",
      holderId: "holder-leak",
      outbox,
      policy: {
        drainBatchSize: 1,
        leaseMs: 60_000,
        maxAttempts: 1,
        maxDrainDurationMs: 60_000,
        maxDrainIterations: 2,
        maxEnqueuedBatchesPerRun: 2048,
        maxQueueDepth: 10_000,
        retryBackoffMs: 1,
      },
      sourceInstanceId: "src-leak",
    });

    assert.equal(result.sent, 0);
    assert.equal(result.deadLettered, 1);
    const item = outbox.get("src-leak:record_batch:1");
    assert.equal(item?.status, "dead_letter");
    const lastError = item?.last_error ?? "";
    // The status/code-shaped prefix survives so the row is still diagnosable.
    assert.ok(lastError.includes("ingest failed 401"), `expected diagnosable prefix, got: ${lastError}`);
    // No raw secrets, opaque credentials, OTP, or record bodies survive.
    assert.ok(!lastError.includes(bearer), "bearer token leaked into last_error");
    assert.ok(!lastError.includes("session=ZZZZ"), "cookie value leaked into last_error");
    assert.ok(!lastError.includes("482913"), "OTP leaked into last_error");
    assert.ok(!lastError.includes("123-45-6789"), "record data leaked into last_error");
    assert.ok(!lastError.includes("xxxxxxxxxx"), "unbounded body leaked into last_error");
    assert.ok(lastError.includes("[REDACTED]"), `expected redaction markers, got: ${lastError}`);
    // Bounded length (sanitizer caps at 300 chars).
    assert.ok(lastError.length <= 300, `last_error exceeded bound: ${lastError.length}`);
  } finally {
    outbox.close();
  }
});

test("runCollectorConnector does not let a dead-lettered gap row permanently skip scans", async () => {
  // A failed diagnostic gap acknowledgement must keep checkpoints from
  // advancing, but it should not forever prevent the collector from
  // re-observing the source and making useful, idempotent progress.
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const seedOutbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      seedOutbox.enqueue({
        id: "src-dead-gap:policy",
        kind: "gap",
        payload: {
          connectorId: "fixture-dead-gap",
          firstSeenAt: "2026-05-19T12:00:00.000Z",
          firstSeenRunId: "run-dead-gap-1",
          nextAttemptBackoffMs: 60_000,
          reason: "policy_budget",
          retryable: true,
          sourceInstanceId: "src-dead-gap",
        },
        sourceInstanceId: "src-dead-gap",
      });
      const [claim] = seedOutbox.claimReady({ holder: "seed", leaseMs: 60_000, sourceInstanceId: "src-dead-gap" });
      assert.ok(claim);
      seedOutbox.deadLetter({
        error: "synthetic gap ack failure",
        holder: "seed",
        id: claim.id,
        leaseEpoch: claim.lease_epoch,
      });
    } finally {
      seedOutbox.close();
    }

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
          cursor: "cursor-after-dead-gap",
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
        connector_id: "fixture-dead-gap",
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      runId: "run-dead-gap-2",
      sourceInstanceId: "src-dead-gap",
    });

    assert.equal(result.skippedScanForBacklog, false);
    assert.equal(result.done?.status, "succeeded");
    assert.equal(result.outboxSummary.deadLetter, 1);
    assert.equal(result.flushedState, null, "checkpoint must not advance past an unacknowledged gap");
    const putOps = harness.stateOps.filter((op) => op.method === "PUT");
    assert.equal(putOps.length, 0);
  } finally {
    await harness.close();
  }
});

test("runCollectorConnector recovers acknowledged local gaps only after a successful coverage STATE commit", async () => {
  const harness = await startCollectorHarness({ priorState: {} });
  try {
    const queuePath = await tempQueuePath();
    const seedOutbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      seedOutbox.enqueue({
        id: "src-recovered-gap:policy",
        kind: "gap",
        payload: {
          connectorId: "fixture-recovered-gap",
          firstSeenAt: "2026-05-19T12:00:00.000Z",
          firstSeenRunId: "run-recovered-gap-1",
          nextAttemptBackoffMs: 60_000,
          reason: "policy_budget",
          retryable: true,
          sourceInstanceId: "src-recovered-gap",
        },
        sourceInstanceId: "src-recovered-gap",
      });
      const [claim] = seedOutbox.claimReady({ holder: "seed", leaseMs: 60_000, sourceInstanceId: "src-recovered-gap" });
      assert.ok(claim);
      seedOutbox.acknowledge({ holder: "seed", id: claim.id, leaseEpoch: claim.lease_epoch });
    } finally {
      seedOutbox.close();
    }

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
          cursor: "cursor-after-recovery",
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "STATE",
          stream: "coverage_diagnostics",
          cursor: { fetched_at: new Date().toISOString() },
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
        connector_id: "fixture-recovered-gap",
        runtime_requirements: { bindings: {} },
        streams: ["messages", "coverage_diagnostics"],
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath,
      runId: "run-recovered-gap-2",
      sourceInstanceId: "src-recovered-gap",
    });

    assert.equal(result.skippedScanForBacklog, false);
    assert.equal(result.flushedState?.messages, "cursor-after-recovery");
    assert.equal(
      typeof (result.flushedState?.coverage_diagnostics as { fetched_at?: unknown } | undefined)?.fetched_at,
      "string"
    );
    assert.equal(harness.gapRecoveries.length, 1);
    assert.equal(harness.gapRecoveries[0]?.reason, "policy_budget");
    assert.equal(harness.gapRecoveries[0]?.recovered_run_id, "run-recovered-gap-2");
    const verify = new LocalDeviceOutbox({ path: queuePath });
    try {
      const gaps = verify.list({ sourceInstanceId: "src-recovered-gap" }).filter((item) => item.kind === "gap");
      assert.equal(
        gaps.length,
        0,
        "recovered local gap rows should be pruned so future re-observation can report a fresh gap"
      );
    } finally {
      verify.close();
    }
  } finally {
    await harness.close();
  }
});
