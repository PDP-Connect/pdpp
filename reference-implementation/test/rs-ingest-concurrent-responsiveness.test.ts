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
 *
 * The default record count (PDPP_TEST_INGEST_RECORD_COUNT, default 8000) is
 * chosen to be discriminating under a bare `node --test` invocation with no
 * env override: local benchmarking (see /tmp/as-latency-0809.md) measured
 * an ~8000-record batch at ~1s wall time on unmodified code with a >1000ms
 * worst-case probe stall, and ~1s total test wall time is acceptable for
 * this suite. A smaller default (e.g. the original 800) completes in ~200ms
 * on unmodified code — too fast to reliably starve a probe issued 20ms in —
 * which would make the default CI invocation vacuously pass regardless of
 * whether the fix is present. Do not lower this default without re-proving
 * it still fails on a reverted fix.
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

  const { status: approveStatus, body: approveBody } = await fetchJson(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(
    approveStatus >= 200 && approveStatus < 300,
    `device/approve should succeed: status=${approveStatus} body=${JSON.stringify(approveBody)}`
  );

  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tokenBody?.access_token, `token exchange should return access_token: ${JSON.stringify(tokenBody)}`);
  return tokenBody.access_token;
}

const TEST_MANIFEST = {
  connector_id: "concurrent-responsiveness-probe",
  connector_key: "concurrent-responsiveness-probe",
  display_name: "Concurrent responsiveness probe",
  manifest_uri: "https://sources.example/concurrent-responsiveness-probe",
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

interface IngestOutcome {
  errors?: unknown[];
  records_accepted?: number;
  records_rejected?: number;
  stream?: string;
}

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

    // See the module doc comment for why 8000 is the default, not a
    // smaller/arbitrary number: it is the smallest scale locally confirmed
    // to be discriminating (fails on unmodified code, ~1s total wall time)
    // under a bare `node --test` invocation with no env override.
    const RECORD_COUNT = Number(process.env.PDPP_TEST_INGEST_RECORD_COUNT || 8000);
    const body = buildNdjsonBatch(RECORD_COUNT);

    // Budget for the lightweight sibling request. GET / does no DB access
    // and no ingest-coordinator work at all — under healthy scheduling it
    // should resolve in low single-digit milliseconds even while a large
    // ingest is in flight on the same process.
    const LIGHTWEIGHT_BUDGET_MS = 300;

    // Structural settlement tracking (not a fixed sleep-and-hope): the
    // ingest promise's own resolution is the source of truth for whether
    // the batch is still in flight while probes run.
    let ingestSettled = false;
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
    ).finally(() => {
      ingestSettled = true;
    });

    // Give the ingest request a moment to actually start executing its
    // synchronous loop before we start probing, so we're not just measuring
    // request-parse/dispatch latency. Assert it is genuinely still in
    // flight at this point — if it already settled, the batch was too fast
    // to be a discriminating oracle at this record count/machine, and the
    // test below would be vacuous (probes would all run after completion).
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      ingestSettled,
      false,
      `ingest(${RECORD_COUNT} records) settled within 20ms — too fast to be a discriminating oracle; ` +
        "raise PDPP_TEST_INGEST_RECORD_COUNT or investigate why this machine ingests faster than expected"
    );

    const probeLatencies: number[] = [];
    const probeIngestActiveAtStart: boolean[] = [];
    const PROBE_COUNT = 10;
    for (let i = 0; i < PROBE_COUNT; i += 1) {
      probeIngestActiveAtStart.push(!ingestSettled);
      const start = performance.now();
      // biome-ignore lint/performance/noAwaitInLoops: Each probe must observe scheduling latency independently, in sequence, while the batch is in flight.
      const resp = await fetch(`${rsUrl}/`);
      const elapsed = performance.now() - start;
      probeLatencies.push(elapsed);
      assert.equal(resp.status, 200, "lightweight GET / must succeed while ingest is in flight");
      await resp.text();
    }

    // Non-vacuity: at least one probe must have both STARTED and FINISHED
    // while the ingest batch was still active, or this test proves nothing
    // about concurrent-request behavior during ingest.
    const probesStartedWhileActive = probeIngestActiveAtStart.filter(Boolean).length;
    assert.ok(
      probesStartedWhileActive >= 1,
      `expected at least one of ${PROBE_COUNT} GET / probes to start while the ${RECORD_COUNT}-record ingest ` +
        "batch was still in flight (ingestSettled was already true before any probe started); got 0 — the batch " +
        "completed before probing began, making this run vacuous. Raise PDPP_TEST_INGEST_RECORD_COUNT."
    );

    const ingestResp = await ingestPromise;
    const ingestElapsed = performance.now() - ingestStart;
    assert.equal(ingestResp.status, 200, "ingest batch should still succeed");
    const ingestOutcome = (await ingestResp.json()) as IngestOutcome;

    // Exact-count assertion, not just "status 200": proves the batch this
    // test measured actually processed every record it sent, not a
    // truncated/partial/error-short-circuited batch that would understate
    // real synchronous work and invalidate the timing measurement above.
    assert.equal(
      ingestOutcome.records_accepted,
      RECORD_COUNT,
      `expected all ${RECORD_COUNT} records to be accepted; got ${JSON.stringify(ingestOutcome)}`
    );
    assert.equal(
      ingestOutcome.records_rejected ?? 0,
      0,
      `expected zero rejected records; got ${JSON.stringify(ingestOutcome)}`
    );
    assert.deepEqual(
      ingestOutcome.errors ?? [],
      [],
      `expected zero ingest errors; got ${JSON.stringify(ingestOutcome)}`
    );

    const maxProbeLatency = Math.max(...probeLatencies);
    const overBudget = probeLatencies.filter((ms) => ms > LIGHTWEIGHT_BUDGET_MS);

    console.log(
      `[result] ingest(${RECORD_COUNT} records)=${ingestElapsed.toFixed(1)}ms wall, ` +
        `${probesStartedWhileActive}/${PROBE_COUNT} probes started while active; ` +
        `GET / probes (ms) = ${probeLatencies.map((v) => v.toFixed(1)).join(",")}`
    );

    assert.equal(
      overBudget.length,
      0,
      `expected all ${PROBE_COUNT} lightweight GET / probes to resolve within ${LIGHTWEIGHT_BUDGET_MS}ms while an ${RECORD_COUNT}-record ingest batch (${ingestElapsed.toFixed(1)}ms wall, ${probesStartedWhileActive}/${PROBE_COUNT} probes started while active) was in flight on the same process; observed max=${maxProbeLatency.toFixed(1)}ms, all=${probeLatencies.map((v) => v.toFixed(1)).join(",")}ms (ingest outcome: ${JSON.stringify(ingestOutcome)})`
    );
  } finally {
    await closeServer(server);
  }
});
