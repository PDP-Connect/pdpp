// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCollectorConnector } from "../../packages/polyfill-connectors/src/collector-runner.ts";
import { handleLocalDeviceTerminalRunCommit } from "../operations/local-device-terminal-collection.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { commitTerminalRun } from "../server/stores/terminal-run-commit-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID = "terminal_restart_fixture";
const CONNECTOR_INSTANCE_ID = "cin_terminal_restart_fixture";
const DEVICE_ID = "dev-terminal-restart";
const SOURCE_INSTANCE_ID = "src-terminal-restart";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

type Backend = "postgres" | "sqlite";

async function seed(backend: Backend): Promise<void> {
  const now = "2026-08-12T12:00:00.000Z";
  if (backend === "postgres") {
    assert.ok(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    await cleanupPostgres();
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, '{}'::jsonb, $2)", [
      CONNECTOR_ID,
      now,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES ($1, 'owner_local', $2, 'Restart fixture', 'active',
         'local_device', 'device:restart', '{}'::jsonb, $3, $3)`,
      [CONNECTOR_INSTANCE_ID, CONNECTOR_ID, now]
    );
    return;
  }
  initDb(makeTemporaryDbPath("pdpp-terminal-collector-restart-"));
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
    .run(CONNECTOR_ID, now);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES (?, 'owner_local', ?, 'Restart fixture', 'active',
         'local_device', 'device:restart', '{}', ?, ?)`
    )
    .run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, now, now);
}

async function cleanupPostgres(): Promise<void> {
  await postgresQuery("DELETE FROM run_history WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
  await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_state WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [CONNECTOR_INSTANCE_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function stateProjection(backend: Backend): Promise<Record<string, unknown>> {
  if (backend === "postgres") {
    const { rows } = await postgresQuery<{ state_json: unknown; stream: string }>(
      "SELECT stream, state_json FROM connector_state WHERE connector_instance_id = $1 ORDER BY stream",
      [CONNECTOR_INSTANCE_ID]
    );
    return Object.fromEntries(rows.map((row) => [row.stream, row.state_json]));
  }
  const rows = getDb()
    .prepare("SELECT stream, state_json FROM connector_state WHERE connector_instance_id = ? ORDER BY stream")
    .all(CONNECTOR_INSTANCE_ID) as Array<{ state_json: string; stream: string }>;
  return Object.fromEntries(rows.map((row) => [row.stream, JSON.parse(row.state_json) as unknown]));
}

async function counts(backend: Backend): Promise<{ events: number; runs: number }> {
  if (backend === "postgres") {
    const { rows } = await postgresQuery<{ events: number; runs: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM spine_events WHERE connector_instance_id = $1) AS events,
         (SELECT COUNT(*)::int FROM run_history WHERE connector_instance_id = $1) AS runs`,
      [CONNECTOR_INSTANCE_ID]
    );
    return { events: Number(rows[0]?.events ?? 0), runs: Number(rows[0]?.runs ?? 0) };
  }
  const events = getDb()
    .prepare("SELECT COUNT(*) AS n FROM spine_events WHERE connector_instance_id = ?")
    .get(CONNECTOR_INSTANCE_ID) as { n: number };
  const runs = getDb()
    .prepare("SELECT COUNT(*) AS n FROM run_history WHERE connector_instance_id = ?")
    .get(CONNECTOR_INSTANCE_ID) as { n: number };
  return { events: events.n, runs: runs.n };
}

async function connectorFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-terminal-restart-connector-"));
  const path = join(directory, "fixture.mjs");
  await writeFile(
    path,
    `(async () => {
      let input = "";
      await new Promise((resolve) => process.stdin.on("data", (chunk) => { input += chunk; if (input.includes("\\n")) resolve(); }));
      const start = JSON.parse(input.split("\\n")[0]);
      const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
      if (start.state?.messages?.cursor) {
        emit({ type: "DONE", status: "succeeded", records_emitted: 0 });
        return;
      }
      emit({ type: "RECORD", stream: "messages", key: "message-1", data: { id: "message-1" }, emitted_at: "2026-08-12T12:00:00.000Z" });
      emit({ type: "STATE", stream: "messages", cursor: { cursor: "c1" } });
      emit({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:messages", data: { id: "coverage:messages", store: "messages", stream: "messages", status: "collected" }, emitted_at: "2026-08-12T12:00:00.000Z" });
      emit({ type: "STATE", stream: "coverage_diagnostics", cursor: { cursor: "coverage-c1" } });
      emit({ type: "DONE", status: "succeeded", records_emitted: 2 });
    })().catch((error) => { process.stderr.write(String(error)); process.exit(1); });\n`
  );
  return path;
}

async function startHarness(backend: Backend) {
  let dropFirstTerminalResponse = true;
  let ingestCount = 0;
  const terminalResponses: unknown[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const url = req.url ?? "";
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.endsWith("/state") && req.method === "GET") {
      send(200, {
        connector_instance_id: CONNECTOR_INSTANCE_ID,
        device_id: DEVICE_ID,
        object: "device_source_instance_state",
        source_instance_id: SOURCE_INSTANCE_ID,
        state: await stateProjection(backend),
        updated_at: null,
      });
      return;
    }
    if (url.includes("/ingest-batches")) {
      ingestCount += Array.isArray(body?.records) ? body.records.length : 0;
      send(201, { accepted_record_count: 1, object: "device_ingest_batch_result", status: "accepted" });
      return;
    }
    if (url.endsWith("/terminal-run-commits")) {
      let status = 0;
      await handleLocalDeviceTerminalRunCommit({
        ctx: {
          canonicalConnectorKey: () => CONNECTOR_ID,
          commitTerminalRun,
          emitSpineEvent: () => Promise.resolve(),
          handleError: (_response, error) => {
            throw error;
          },
          pdppError: (_response, errorStatus, code, message) => send(errorStatus, { code, message }),
        },
        req: {
          body,
          deviceExporter: { deviceId: DEVICE_ID },
          params: { deviceId: DEVICE_ID, sourceInstanceId: SOURCE_INSTANCE_ID },
        },
        res: {
          json(value) {
            terminalResponses.push(value);
            if (dropFirstTerminalResponse) {
              dropFirstTerminalResponse = false;
              res.destroy();
              return value;
            }
            send(status, value);
            return value;
          },
          status(code) {
            status = code;
            return this;
          },
        },
        resolveAuthorizedSource: () =>
          Promise.resolve({
            connectorInstance: { connectorInstanceId: CONNECTOR_INSTANCE_ID },
            sourceInstance: { connectorId: CONNECTOR_ID },
          }),
      });
      return;
    }
    send(200, { object: "device_exporter_heartbeat", status: "accepted" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    ingestCount: () => ingestCount,
    terminalResponses,
    url: `http://127.0.0.1:${address.port}`,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(`cursor-aware response-loss restart exact-replays once on ${backend}`, {
    skip: backend === "postgres" && !POSTGRES_URL ? "PDPP_TEST_POSTGRES_URL unset" : false,
  }, async () => {
    await seed(backend);
    const harness = await startHarness(backend);
    const queuePath = join(await mkdtemp(join(tmpdir(), `pdpp-terminal-restart-${backend}-`)), "outbox.sqlite3");
    const fixture = await connectorFixture();
    const config = {
      baseUrl: harness.url,
      connector: {
        args: [fixture],
        command: process.execPath,
        connector_id: CONNECTOR_ID,
        runtime_requirements: { bindings: {} },
        streams: ["messages", "coverage_diagnostics"],
      },
      deviceId: DEVICE_ID,
      deviceToken: "device-token",
      outboxPolicy: { maxDrainIterations: 1, retryBackoffMs: 1 },
      queuePath,
      runId: "run-terminal-restart",
      sourceInstanceId: SOURCE_INSTANCE_ID,
    } as const;
    try {
      const first = await runCollectorConnector(config);
      assert.equal(first.statePutFailed, true, "lost response leaves the terminal item unacknowledged");
      assert.equal(harness.ingestCount(), 2, "first pass sends one data record plus its coverage diagnostic");
      assert.deepEqual(await counts(backend), { events: 1, runs: 1 });

      const second = await runCollectorConnector(config);
      assert.equal(second.statePutFailed, false);
      assert.equal(harness.ingestCount(), 2, "cursor-aware restart emits no duplicate record or coverage batch");
      assert.deepEqual(await counts(backend), { events: 1, runs: 1 });
      assert.equal(harness.terminalResponses.length, 2);
      assert.deepEqual(harness.terminalResponses[1], harness.terminalResponses[0], "retry returns the stored response");
    } finally {
      await harness.close();
      if (backend === "postgres") {
        await cleanupPostgres();
        await closePostgresStorage();
      } else {
        closeDb();
      }
    }
  });
}
