// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime cancellation tests for a connector that has already filled the
// parent runtime's ingest queue. Gmail can produce this shape while attachment
// hydration and message records are being forwarded to the resource server.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";

const STREAM = "items";
const MANIFEST = {
  connector_id: "https://registry.pdpp.org/connectors/cancel-queue-regression",
  runtime_requirements: {},
  streams: [
    {
      name: STREAM,
      primary_key: "id",
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "0.1.0",
};

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-cancel-queue-db-"));
  closeDb();
  initDb(join(dir, "pdpp.sqlite"));
  return dir;
}

function writeFloodStub({ ignoreSigterm }: { ignoreSigterm: boolean }): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-cancel-queue-"));
  const path = join(dir, "stub.mjs");
  const sigtermHandler = ignoreSigterm
    ? 'process.on("SIGTERM", () => { /* force the parent runtime fallback */ });'
    : "// default SIGTERM disposition: exit immediately";
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";

${sigtermHandler}

await new Promise((resolve) => {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.once("line", () => { reader.close(); resolve(); });
});

for (let i = 0; i < 120; i += 1) {
  process.stdout.write(JSON.stringify({
    type: "RECORD",
    stream: "${STREAM}",
    key: String(i),
    data: { id: String(i) },
    emitted_at: new Date().toISOString(),
  }) + "\\n");
}
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

async function runCancelQueueScenario(
  t: TestContext,
  { ignoreSigterm, runId }: { ignoreSigterm: boolean; runId: string }
): Promise<{ elapsedMs: number; ingestCount: number; requestCountAtCancel: number | null; result: unknown }> {
  const dbDir = freshDb();
  t.after(() => {
    closeDb();
    rmSync(dbDir, { force: true, recursive: true });
  });
  const previousBatchSize = process.env.PDPP_RUNTIME_BATCH_SIZE;
  process.env.PDPP_RUNTIME_BATCH_SIZE = "1";
  t.after(() => {
    if (previousBatchSize === undefined) {
      delete process.env.PDPP_RUNTIME_BATCH_SIZE;
    } else {
      process.env.PDPP_RUNTIME_BATCH_SIZE = previousBatchSize;
    }
  });

  let ingestCount = 0;
  let requestCountAtCancel: number | null = null;
  let resolveFirstIngest!: () => void;
  const firstIngest = new Promise<void>((resolve) => {
    resolveFirstIngest = resolve;
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { method, url } = req;
      const { pathname } = new URL(url ?? "/", "http://localhost");
      if (method === "POST" && pathname === `/v1/ingest/${STREAM}`) {
        ingestCount += 1;
        if (ingestCount === 1) {
          resolveFirstIngest();
        }
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ records_accepted: body.split("\\n").filter(Boolean).length, records_rejected: 0 }));
        }, 20).unref();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { dir, path } = writeFloodStub({ ignoreSigterm });
  t.after(() => rmSync(dir, { force: true, recursive: true }));

  const cancellation = new AbortController();
  cancellation.signal.addEventListener("abort", () => {
    requestCountAtCancel = ingestCount;
  });
  firstIngest.then(() => cancellation.abort());
  const startedAt = Date.now();
  const result = await runConnector({
    admitRunConnection: async ({ connectorId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId: "cin_cancel_queue_regression",
      ownerSubjectId: ownerSubjectId ?? "owner_local",
    }),
    cancelSignal: cancellation.signal,
    collectionMode: "full_refresh",
    connectorId: MANIFEST.connector_id,
    connectorPath: path,
    detailGapStore: {
      listPendingGaps: async () => [],
      markGapStatus: async () => null,
      upsertPendingGap: async () => null,
    },
    manifest: MANIFEST,
    onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
    onProgress: () => undefined,
    ownerToken: "test-owner-token",
    persistState: true,
    rsUrl: `http://127.0.0.1:${address.port}`,
    runId,
    state: null,
  });

  return { elapsedMs: Date.now() - startedAt, ingestCount, requestCountAtCancel, result };
}

test("runtime cancellation drops queued ingest work for a cooperative child", async (t) => {
  const { elapsedMs, ingestCount, requestCountAtCancel, result } = await runCancelQueueScenario(t, {
    ignoreSigterm: false,
    runId: "run_cancel_queue_graceful",
  });
  assert.equal((result as { status: string }).status, "cancelled");
  assert.equal((result as { terminal_reason: string }).terminal_reason, "owner_cancelled");
  assert.equal(ingestCount, requestCountAtCancel, "no queued ingest starts after cooperative cancellation");
  assert.ok(ingestCount >= 1, "the first already-started ingest is preserved");
  assert.ok(elapsedMs < 1500, `terminalization should not drain the queued flood (${elapsedMs}ms)`);
});

test("runtime cancellation drops queued ingest work for an uncooperative child", async (t) => {
  const { elapsedMs, ingestCount, requestCountAtCancel, result } = await runCancelQueueScenario(t, {
    ignoreSigterm: true,
    runId: "run_cancel_queue_forced",
  });
  assert.equal((result as { status: string }).status, "cancelled");
  assert.equal((result as { terminal_reason: string }).terminal_reason, "owner_cancel_forced");
  assert.equal(ingestCount, requestCountAtCancel, "no queued ingest starts after forced cancellation");
  assert.ok(ingestCount >= 1, "the first already-started ingest is preserved");
  assert.ok(elapsedMs < 1500, `forced terminalization should not drain the queued flood (${elapsedMs}ms)`);
});
