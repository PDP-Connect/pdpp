// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime-level tests for the owner-cancel cooperative-termination path added by
// openspec/changes/add-owner-run-cancellation-control.
//
// Unlike controller-cancel-run.test.js (which injects a fake runConnectorImpl
// and never spawns a child), these tests run the REAL `runConnector` against a
// REAL stub connector child process and a mock resource server, so they prove
// the runtime's process-signal behavior end to end:
//
//   - a connector that exits on SIGTERM after abort terminals as
//     `run.cancelled` with reason `owner_cancelled` (graceful);
//   - a connector that IGNORES SIGTERM is force-terminated via the existing
//     graceful-then-SIGKILL escalation and terminals as `run.cancelled` with
//     reason `owner_cancel_forced`;
//   - in both cases records already flushed to the RS before cancel are
//     preserved (the mock RS received the ingest POST), and no staged cursor
//     state is committed (the mock RS received NO `PUT /v1/state/...`), because
//     the run exits without `DONE status="succeeded"`;
//   - a non-terminal `run.cancel_requested` spine event and a terminal
//     `run.cancelled` spine event are recorded for the run.
//
// The stub emits one RECORD then one STATE (which flushes that stream's records
// to the RS and stages — but does not commit — the cursor), signals readiness on
// stderr, then idles. The test aborts the cancel signal as soon as the mock RS
// has received the ingest POST, guaranteeing the run is past START and actively
// collecting when cancellation lands.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const STREAM = "items";

const MANIFEST = {
  connector_id: "https://registry.pdpp.org/connectors/runtime-cancel-stub",
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

// A mock resource server that records every request by `${method} ${pathname}`.
// `ingested` resolves as soon as the first record-ingest POST lands, so the test
// can abort precisely when the run is actively collecting.
interface MockRsRequest {
  body: string;
  method: string | undefined;
  pathname: string;
}

function startMockRs() {
  const requests: MockRsRequest[] = [];
  let resolveIngested: () => void;
  const ingested = new Promise<void>((resolve) => {
    resolveIngested = resolve;
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      requests.push({ body, method: req.method, pathname });
      if (req.method === "POST" && pathname.startsWith("/v1/ingest/")) {
        const records_accepted = body.split("\n").filter(Boolean).length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ records_accepted, records_rejected: 0 }));
        resolveIngested();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return { ingested, requests, server };
}

// Writes a stub connector that reads START, emits one RECORD and one STATE,
// announces readiness on stderr, then idles forever. `ignoreSigterm` installs a
// no-op SIGTERM handler so the runtime must escalate to SIGKILL (the forced
// path). Records and state are emitted at module top level after START so the
// runtime flushes the record and stages the cursor before the test aborts.
function writeStub({ ignoreSigterm }: { ignoreSigterm: boolean }): { stubPath: string; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-cancel-"));
  const stubPath = join(tmpDir, "stub.mjs");
  const sigtermLine = ignoreSigterm
    ? "process.on('SIGTERM', () => { /* deliberately ignore: force SIGKILL escalation */ });"
    : "// default SIGTERM disposition: terminate the process";
  writeFileSync(
    stubPath,
    `
import { createInterface } from 'node:readline';

${sigtermLine}

function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

async function main() {
  // Read START.
  await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.once('line', () => { rl.close(); resolve(); });
  });

  // One record, then a STATE checkpoint. Emitting STATE flushes this stream's
  // records to the RS (proving already-collected records survive cancel) and
  // stages — but does NOT commit — the cursor (no DONE will follow).
  emit({ type: 'RECORD', stream: '${STREAM}', key: 'r1', data: { id: 'r1' }, emitted_at: new Date().toISOString() });
  emit({ type: 'STATE', stream: '${STREAM}', cursor: { offset: 1 } });

  // Announce readiness; then idle until the runtime terminates us.
  process.stderr.write('STUB_READY\\n');
  setInterval(() => {}, 1000);
}

main();
`,
    "utf8"
  );
  chmodSync(stubPath, 0o755);
  return { stubPath, tmpDir };
}

function freshDb(t: TestContext): void {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-runtime-cancel-db-")), "pdpp.sqlite"));
  t.after(() => closeDb());
}

interface SpineEventRow {
  event_type: string;
  status: string | null;
}

interface StructuredCancelOutcome {
  status: unknown;
  terminal_reason: unknown;
}

function asStructuredOutcome(value: unknown): StructuredCancelOutcome {
  assert.ok(value && typeof value === "object", "structured outcome");
  assert.ok("status" in value, "expected a status field");
  assert.ok("terminal_reason" in value, "expected a terminal_reason field");
  return value as StructuredCancelOutcome;
}

function spineEventsForRun(runId: string): SpineEventRow[] {
  const db = getDb();
  return db
    .prepare("SELECT event_type, status FROM spine_events WHERE run_id = ? ORDER BY event_seq ASC")
    .all(runId) as SpineEventRow[];
}

async function runCancelScenario(t: TestContext, { ignoreSigterm, runId }: { ignoreSigterm: boolean; runId: string }) {
  freshDb(t);
  const { server, requests, ingested } = startMockRs();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected an AddressInfo from an ephemeral listen(0)");
  const rsUrl = `http://127.0.0.1:${address.port}`;
  const { stubPath, tmpDir } = writeStub({ ignoreSigterm });

  const controller = new AbortController();
  // Abort as soon as the RS has received the flushed record: the run is past
  // START and actively collecting, exactly the motivating mid-run case.
  ingested.then(() => controller.abort());

  let outcome: RuntimeRunConnectorResult | null = null;
  let outcomeError: unknown = null;
  try {
    outcome = await runConnector({
      cancelSignal: controller.signal,
      collectionMode: "full_refresh",
      connectorId: MANIFEST.connector_id,
      connectorPath: stubPath,
      detailGapStore: {
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async listPendingGaps() {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async markGapStatus() {
          return null;
        },
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async upsertPendingGap() {
          return null;
        },
      },
      manifest: MANIFEST,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      onProgress: () => {},
      ownerToken: "test-owner-token",
      persistState: true,
      rsUrl,
      runId,
      state: null,
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    server.close();
    rmSync(tmpDir, { force: true, recursive: true });
  }

  return { outcome, outcomeError, requests };
}

test("runtime owner-cancel: connector that exits on SIGTERM terminals as owner_cancelled", async (t) => {
  const runId = "run_cancel_graceful";
  const { outcome, outcomeError, requests } = await runCancelScenario(t, {
    ignoreSigterm: false,
    runId,
  });

  const result = asStructuredOutcome(outcome ?? outcomeError);
  assert.equal(result.status, "cancelled", "owner-cancelled run resolves status=cancelled");
  assert.equal(result.terminal_reason, "owner_cancelled", "graceful exit → owner_cancelled");

  // Records already flushed to the RS are preserved.
  const ingests = requests.filter((r) => r.method === "POST" && r.pathname.startsWith("/v1/ingest/"));
  assert.ok(ingests.length >= 1, "the flushed record reached the resource server");

  // No staged cursor state is committed: the run never sent DONE succeeded, so
  // the runtime never issued a PUT /v1/state/... commit.
  const stateCommits = requests.filter((r) => r.method === "PUT" && r.pathname.startsWith("/v1/state/"));
  assert.equal(stateCommits.length, 0, "staged cursor state is NOT committed on cancel");

  // Spine timeline records the request and a terminal run.cancelled.
  const events = spineEventsForRun(runId).map((e) => e.event_type);
  assert.ok(events.includes("run.cancel_requested"), "a non-terminal run.cancel_requested is recorded");
  assert.ok(events.includes("run.cancelled"), "a terminal run.cancelled is recorded");
  assert.ok(!events.includes("run.failed"), "an owner-cancelled run does NOT terminal as run.failed");
});

test("runtime owner-cancel: connector that ignores SIGTERM is force-terminated → owner_cancel_forced", async (t) => {
  const runId = "run_cancel_forced";
  const { outcome, outcomeError, requests } = await runCancelScenario(t, {
    ignoreSigterm: true,
    runId,
  });

  const result = asStructuredOutcome(outcome ?? outcomeError);
  assert.equal(result.status, "cancelled", "force-cancelled run resolves status=cancelled");
  assert.equal(
    result.terminal_reason,
    "owner_cancel_forced",
    "a connector that ignores SIGTERM is escalated to SIGKILL → owner_cancel_forced"
  );

  // Same preservation guarantees as the graceful path.
  const ingests = requests.filter((r) => r.method === "POST" && r.pathname.startsWith("/v1/ingest/"));
  assert.ok(ingests.length >= 1, "the flushed record reached the resource server");
  const stateCommits = requests.filter((r) => r.method === "PUT" && r.pathname.startsWith("/v1/state/"));
  assert.equal(stateCommits.length, 0, "staged cursor state is NOT committed on forced cancel");

  const events = spineEventsForRun(runId).map((e) => e.event_type);
  assert.ok(events.includes("run.cancel_requested"), "a non-terminal run.cancel_requested is recorded");
  assert.ok(events.includes("run.cancelled"), "a terminal run.cancelled is recorded");
  assert.ok(!events.includes("run.failed"), "a force-cancelled run does NOT terminal as run.failed");
});
