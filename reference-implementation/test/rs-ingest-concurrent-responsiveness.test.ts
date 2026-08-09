// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating oracle for application-server responsiveness under
 * concurrent ingestion.
 *
 * Incident: live /v1/ingest responseTime logs showed ~65s/305s/1009ms-scale
 * wall-clock times, and a concurrent lightweight request (local collector
 * enrollment) saw an ECONNRESET/opaque 500 during a live connector tranche.
 *
 * This test isolates ONE candidate mechanism: the per-record ingest loop in
 * `ingestRecordsWithinCoordinator` (server/records.ts) runs each record's
 * `writeTransaction` (a fully synchronous better-sqlite3 transaction,
 * lib/db.ts writeTransaction) back-to-back with no genuine event-loop yield
 * between records when `deferIndexes: true` (the batch path's default). If
 * that is true, a single large `/v1/ingest` POST should be able to starve an
 * unrelated, otherwise-instant `GET /` request on the SAME RS process for as
 * long as the batch's synchronous work takes — regardless of the
 * connector-instance write-coordinator's admission gate, since `GET /` does
 * not touch that gate at all.
 *
 * This does not test the write-coordinator admission gate, SQLite locking,
 * or the local-collector client-side timeout — only the event-loop
 * scheduling question, which those other mechanisms cannot explain (`GET /`
 * never contends for a connector-instance write fence or a DB row).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../server/index.ts";

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.rsServer.closeAllConnections();
  server.asServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { body: parsed as T | null, status: resp.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  assert.ok(device, "device_authorization should return a body");
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tokenBody, "token response should return a body");
  return tokenBody.access_token;
}

const TEST_MANIFEST = {
  connector_id: "concurrent-responsiveness-probe",
  connector_key: "concurrent-responsiveness-probe",
  display_name: "Concurrent responsiveness probe",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      cursor_field: "updated_at",
      name: "items",
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          payload: { type: "string" },
          updated_at: { format: "date-time", type: ["string", "null"] },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

function buildNdjsonBatch(count: number): string {
  const lines: string[] = [];
  // ~2KB payload per record so JSON.parse + SQLite write work per record is
  // non-trivial without needing an enormous record count to see starvation.
  const filler = "x".repeat(2048);
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({
        data: { id: `rec-${i}`, payload: filler, updated_at: "2026-08-09T00:00:00.000Z" },
        emitted_at: "2026-08-09T00:00:00.000Z",
        key: `rec-${i}`,
      })
    );
  }
  return lines.join("\n");
}

// Calibration run: seed a small batch first and print wall-clock time so the
// main assertion's record count can be sized off a REAL local measurement
// instead of a guess. Also proves the harness itself (register, token,
// ingest, teardown) terminates cleanly before the heavier case runs.
test("calibration: measure single-record and small-batch ingest wall time", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: ["pdpp-reference-test-initial-access-token"],
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(TEST_MANIFEST),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register probe manifest");
    const ownerToken = await issueOwnerToken(asUrl);

    for (const count of [1, 200]) {
      const body = buildNdjsonBatch(count);
      const start = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: Sequential calibration measurements are intentional.
      const resp = await fetch(
        `${rsUrl}/v1/ingest/${encodeURIComponent("items")}?connector_id=${encodeURIComponent(TEST_MANIFEST.connector_id)}`,
        {
          body,
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
          method: "POST",
        }
      );
      const elapsed = performance.now() - start;
      assert.equal(resp.status, 200, `ingest of ${count} records should succeed`);
      await resp.text();
      console.log(
        `[calibration] ${count} records: ${elapsed.toFixed(1)}ms wall (${(elapsed / count).toFixed(2)}ms/record)`
      );
    }
  } finally {
    await closeServer(server);
  }
});

test("a concurrent /v1/ingest batch must not block a lightweight GET / beyond an explicit budget", {
  timeout: 60_000,
}, async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: ["pdpp-reference-test-initial-access-token"],
    quiet: true,
    rsPort: 0,
  })) as TestServer;

  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(TEST_MANIFEST),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register probe manifest");

    const ownerToken = await issueOwnerToken(asUrl);

    // Sized off the calibration test's measured per-record cost, not a
    // guess — large enough that a fully-serialized synchronous loop takes
    // several seconds, comparable in order of magnitude to the incident's
    // reported responseTime values, so starvation (if it exists) is
    // unambiguous rather than lost in scheduling noise.
    const RECORD_COUNT = Number(process.env.PDPP_TEST_INGEST_RECORD_COUNT || 800);
    const body = buildNdjsonBatch(RECORD_COUNT);

    // Budget for the lightweight sibling request. GET / does no DB access
    // and no ingest-coordinator work at all — under healthy scheduling it
    // should resolve in low single-digit milliseconds even while a large
    // ingest is in flight on the same process.
    const LIGHTWEIGHT_BUDGET_MS = 300;

    const ingestStart = performance.now();
    const ingestPromise = fetch(
      `${rsUrl}/v1/ingest/${encodeURIComponent("items")}?connector_id=${encodeURIComponent(TEST_MANIFEST.connector_id)}`,
      {
        body,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );

    // Give the ingest request a moment to actually start executing its
    // synchronous loop before we start probing, so we're not just measuring
    // request-parse/dispatch latency.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const probeLatencies: number[] = [];
    const PROBE_COUNT = 10;
    for (let i = 0; i < PROBE_COUNT; i += 1) {
      const start = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: Each probe must observe scheduling latency independently, in sequence, while the batch is in flight.
      const resp = await fetch(`${rsUrl}/`);
      const elapsed = performance.now() - start;
      probeLatencies.push(elapsed);
      assert.equal(resp.status, 200, "lightweight GET / must succeed while ingest is in flight");
      await resp.text();
    }

    const ingestResp = await ingestPromise;
    const ingestElapsed = performance.now() - ingestStart;
    assert.equal(ingestResp.status, 200, "ingest batch should still succeed");
    const ingestOutcome = (await ingestResp.json()) as { accepted?: number };

    const maxProbeLatency = Math.max(...probeLatencies);
    const overBudget = probeLatencies.filter((ms) => ms > LIGHTWEIGHT_BUDGET_MS);

    console.log(
      `[result] ingest(${RECORD_COUNT} records)=${ingestElapsed.toFixed(1)}ms wall; ` +
        `GET / probes (ms) = ${probeLatencies.map((v) => v.toFixed(1)).join(",")}`
    );

    assert.equal(
      overBudget.length,
      0,
      `expected all ${PROBE_COUNT} lightweight GET / probes to resolve within ${LIGHTWEIGHT_BUDGET_MS}ms while an ${RECORD_COUNT}-record ingest batch (${ingestElapsed.toFixed(1)}ms wall) was in flight on the same process; observed max=${maxProbeLatency.toFixed(1)}ms, all=${probeLatencies.map((v) => v.toFixed(1)).join(",")}ms (ingest outcome: ${JSON.stringify(ingestOutcome)})`
    );
  } finally {
    await closeServer(server);
  }
});
