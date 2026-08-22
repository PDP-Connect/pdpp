// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Oracle for the connector runtime's retry against a NETWORK-LEVEL fetch
// failure — distinct from `runtime-ingest-retryable-503.test.ts`, which covers
// a response the RS chose to send (a retryable status code).
//
// The defect this covers: live incident on the Google Maps Timeline import
// (cin_50f5bf4b7ecbc7acd6f4c254, run_1787334764061). 269,000 of 269,500
// attempted records were durably accepted, then the runtime's last in-flight
// ingest batch (500 records — the default PDPP_RUNTIME_BATCH_SIZE) hit a raw
// `fetch()` throw (`TypeError: fetch failed`, no HTTP response at all) that
// `postIngestBatchWithRetry` did not catch: it only classifies a STATUS CODE
// the server returned (`isRetryableIngestStatus`), so a connection-level
// failure skipped the retry loop entirely and killed the whole run with
// `terminal_reason: runtime_error`. Because the crash happened mid-ingest,
// before the connector reached its STATE-emitting phase, the checkpoint read
// `not_staged` with no denominator despite 269,000 records already being
// safely stored — reported to the owner as "coverage unknown" for data that
// was, in fact, present.
//
// A second, independently-reachable instance of the identical gap lives in
// `commitState`'s STATE PUT (the terminal checkpoint commit), which had no
// retry wrapper at all before this fix. These tests cover both call sites
// using the same scripted-stub-RS harness as the 503 oracle: the stub
// destroys the raw TCP socket before responding (a real ECONNRESET, not a
// mocked error), forcing `fetch()` itself to throw exactly as it did in the
// live incident.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";

before(() => {
  initDb(":memory:");
});

after(() => {
  closeDb();
});

const CONNECTOR_ID = "network-retry-test";
const OWNER_TOKEN = "owner-token-for-stub";

function streamSchema() {
  return {
    properties: { id: { type: "string" }, value: { type: "string" } },
    required: ["id"],
    type: "object",
  };
}

function manifest() {
  return {
    connector_id: CONNECTOR_ID,
    display_name: "Network Retry Test Connector",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" }],
    version: "1.0.0",
  };
}

/** A connector child that emits one record, one STATE, then DONE. */
function createTestConnector() {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-network-retry-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const messages = [
    {
      data: { id: "i1", value: "ok" },
      emitted_at: new Date().toISOString(),
      key: "i1",
      stream: "items",
      type: "RECORD",
    },
    { cursor: { last_id: "i1" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    for (const m of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf-8"
  );
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

type ScriptedOutcome = "reset" | "ok";

interface StubRs {
  close: () => Promise<void>;
  readonly ingestAttempts: number;
  readonly statePutAttempts: number;
  url: string;
}

/**
 * Stub RS whose ingest POST and state PUT responses are independently
 * scripted. A `"reset"` entry destroys the raw socket before ANY bytes are
 * written back — the client observes a real connection failure (`fetch
 * failed` / ECONNRESET), not a scripted HTTP status. Once a script is
 * exhausted, further requests to that endpoint succeed.
 */
async function startStubRs(scripts: { ingest?: ScriptedOutcome[]; statePut?: ScriptedOutcome[] }): Promise<StubRs> {
  const ingestScript = [...(scripts.ingest ?? [])];
  const statePutScript = [...(scripts.statePut ?? [])];
  let ingestAttempts = 0;
  let statePutAttempts = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString("utf-8");

      if (url.startsWith("/v1/ingest/")) {
        ingestAttempts += 1;
        const outcome = ingestScript.shift();
        if (outcome === "reset") {
          req.socket.destroy();
          return;
        }
        const lines = body.split("\n").filter((l) => l.trim().length > 0);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [], records_accepted: lines.length, records_rejected: 0 }));
        return;
      }

      if (url.startsWith("/v1/state/")) {
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ state: {} }));
          return;
        }
        statePutAttempts += 1;
        const outcome = statePutScript.shift();
        if (outcome === "reset") {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "stub" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    get ingestAttempts() {
      return ingestAttempts;
    },
    get statePutAttempts() {
      return statePutAttempts;
    },
    url: `http://127.0.0.1:${port}`,
  };
}

interface RunOutcome {
  ingestAttempts: number;
  result: Awaited<ReturnType<typeof runConnector>> | null;
  sleeps: number[];
  statePutAttempts: number;
  thrown: unknown;
}

async function runAgainstScript(
  scripts: { ingest?: ScriptedOutcome[]; statePut?: ScriptedOutcome[] },
  overrides: { maxAttempts?: number; persistState?: boolean } = {}
): Promise<RunOutcome> {
  const rs = await startStubRs(scripts);
  const { cleanup, connectorPath } = createTestConnector();
  const sleeps: number[] = [];
  let result: Awaited<ReturnType<typeof runConnector>> | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnector({
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? `${connectorId}:default`,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      collectionMode: "full_refresh",
      connectorId: CONNECTOR_ID,
      connectorPath,
      ingestRetryPolicy: {
        baseDelayMs: 100,
        maxAttempts: overrides.maxAttempts ?? 4,
        maxDelayMs: 8000,
        maxRetryAfterMs: 15_000,
      },
      ingestRetryRandom: () => 0.5,
      ingestRetrySleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      manifest: manifest(),
      onInteraction: async () => ({}),
      ownerToken: OWNER_TOKEN,
      persistState: overrides.persistState ?? true,
      rsUrl: rs.url,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
    await rs.close();
  }
  return { ingestAttempts: rs.ingestAttempts, result, sleeps, statePutAttempts: rs.statePutAttempts, thrown };
}

// ─── (a) ingest path: one connection reset, then succeeds ───────────────────

test("an ingest POST that hits a raw connection reset is retried and the run still succeeds", async () => {
  const outcome = await runAgainstScript({ ingest: ["reset"] });

  assert.equal(outcome.thrown, null, "a single transient network failure must not kill the run");
  assert.equal(outcome.result?.status, "succeeded", "run should succeed once the retried batch reaches the RS");
  assert.equal(outcome.ingestAttempts, 2, "the identical batch must be re-POSTed exactly once after the reset");
  assert.deepEqual(
    outcome.sleeps,
    [100],
    "the network-error retry must back off using the same injected policy as the status-code retry path"
  );
});

// ─── (b) ingest path: resets exceeding the retry budget stay terminal ───────

test("an ingest POST that keeps resetting past maxAttempts still fails the run, bounded", async () => {
  const outcome = await runAgainstScript({ ingest: ["reset", "reset", "reset"] }, { maxAttempts: 2 });

  assert.equal(outcome.ingestAttempts, 2, "attempts must be bounded by maxAttempts, not retried forever");
  assert.equal(outcome.sleeps.length, 1, "maxAttempts=2 means exactly one retry sleep");
  assert.notEqual(outcome.result?.status, "succeeded", "exhausting the retry budget must still be a real failure");
  assert.notEqual(outcome.thrown, null, "the exhausted network failure must surface, not vanish silently");
});

// ─── (c) state-commit path: the terminal checkpoint PUT survives a reset ────
//
// This is the exact live-incident shape: records already accepted, then the
// STATE commit itself hits a network failure. Before this fix, `commitState`
// had no retry at all, so this scenario killed the run with
// `terminal_reason: runtime_error` and left the checkpoint unstaged despite
// every record already being durably stored.

test("a STATE commit PUT that hits a raw connection reset is retried and the checkpoint still commits", async () => {
  const outcome = await runAgainstScript({ statePut: ["reset"] });

  assert.equal(outcome.thrown, null, "a transient network failure on the terminal STATE commit must not kill the run");
  assert.equal(outcome.result?.status, "succeeded", "run should succeed once the retried STATE PUT is accepted");
  assert.equal(outcome.statePutAttempts, 2, "the STATE PUT must be retried exactly once after the reset");
  const checkpointSummary = (
    outcome.result as { checkpoint_summary?: { commit_status?: string } } | null
  )?.checkpoint_summary;
  assert.equal(
    checkpointSummary?.commit_status,
    "committed",
    "the checkpoint must read committed, not not_staged, once the retried PUT succeeds"
  );
});

// ─── (d) happy path: unaffected ─────────────────────────────────────────────

test("a fully healthy run adds no retry attempts and no sleeps on either path", async () => {
  const outcome = await runAgainstScript({});

  assert.equal(outcome.thrown, null);
  assert.equal(outcome.result?.status, "succeeded");
  assert.equal(outcome.ingestAttempts, 1);
  assert.equal(outcome.statePutAttempts, 1);
  assert.deepEqual(outcome.sleeps, []);
});
