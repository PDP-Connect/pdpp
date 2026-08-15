// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Live incident: GroupMe UAT run_1786410860909_1 (2026-08-11 01:14-02:47Z).
// See the guard comment at `dispatchIfDue` (runtime/scheduler.ts) for the
// why/how; see the commit message for the full mechanism.
//
// This suite proves the fix at the exact seam the scheduler's interval timer
// drives (`createScheduler(...).start()`), not the pure governor unit (that
// governor has no visibility into `runtime.activeRuns` at all — the guard
// belongs, and lives, one level up in scheduler.ts).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

interface ClosableHttpServer {
  close: (cb: () => void) => void;
  closeAllConnections?: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: ClosableHttpServer;
  rsPort: number;
  rsServer: ClosableHttpServer;
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 2000);
    server.rsServer.close(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await new Promise<void>((resolve) => server.asServer.close(() => resolve()));
  closeDb();
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { user_code: string; device_code: string };

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = tokenBody as { access_token: string };
  return token.access_token;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered test polling is intentionally sequential
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
    Promise.resolve({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? connectorId,
      ownerSubjectId: ownerSubjectId ?? "owner_local",
    });
}

test("scheduler does not probe forward-evidence-debt (reconcile) for a connector instance with an already-active run", async () => {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-active-run-probe-suppression-"));
  const connectorPath = join(tmpDir, "long-running-connector.mjs");
  const startedMarkerPath = join(tmpDir, "started.marker");

  // A connector that stays "in flight" for well over several scheduler
  // ticks before completing — models the live incident's 93-minute
  // in-progress GroupMe run at test scale. Writes a marker file the instant
  // it receives START so the test can flip `runIsActive` at the true right
  // moment (the run's OWN admission, not the earlier tick that dispatched
  // it — that dispatching tick's own probe call is legitimate: nothing was
  // running yet when it evaluated).
  const RUN_DURATION_MS = 400;
  const TICK_INTERVAL_MS = 40; // several ticks fire well before the run completes
  writeFileSync(
    connectorPath,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(startedMarkerPath)}, 'started', 'utf8');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'succeeded',
      records_emitted: 0,
    }) + '\\n');
    rl.close();
    process.exit(0);
  }, ${RUN_DURATION_MS});
});
`,
    "utf8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  let probeCallsWhileRunning = 0;
  let probeCallsAfterCompletion = 0;
  let runIsActive = false;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_active_run_probe_user");

    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          // Deliberately distinct from connectorId: the real multi-instance
          // hazard is instance A's active run suppressing dispatch for a
          // DIFFERENT sibling instance B of the same connector. A fixture
          // where connectorInstanceId === connectorId can't discriminate a
          // regression to a connectorId-only guard (e.g.
          // `activeRuns.has(schedule.connectorId)`) from the correct
          // per-instance guard — both read the same key. PROVED by
          // mutation: with this fixture unchanged, that regression left
          // both tests in this file green.
          connectorInstanceId: `${spotifyManifest.connector_id}#cin_probe_suppression`,
          connectorPath,
          intervalMs: TICK_INTERVAL_MS,
          manifest: spotifyManifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_active_run_probe_user",
          ownerToken,
        },
      ],
      // The exact probe the live incident's reconcile sweep runs through
      // (scheduler-manager-factory.ts wires the real
      // reconcileDirtyConnectorSummaryEvidence call here). Counting calls
      // while the run is active vs. after completion is the discriminator:
      // BEFORE the fix, this fires on every ~TICK_INTERVAL_MS tick
      // regardless of run state; AFTER the fix, it must be silent for the
      // instance's entire in-flight duration.
      getForwardEvidenceDebt: () => {
        if (runIsActive) {
          probeCallsWhileRunning += 1;
        } else {
          probeCallsAfterCompletion += 1;
        }
        return false;
      },
      // The forward-evidence-debt probe is only reached when non-pressure
      // recovery is otherwise eligible (dispatch-governor.ts's
      // `probeForwardEvidenceDebt` call site) — a non-zero backlog here is
      // required to actually exercise the probe this test is discriminating
      // on, matching the live incident's connection (which had real pending
      // gaps driving its own recovery/debt evaluation every tick).
      getNonPressureRecoverableCount: async () => 1,
      getState: async () => null,
      onInteraction: async (interaction: unknown) => ({
        request_id: (interaction as { request_id: string }).request_id,
        status: "cancelled",
        type: "INTERACTION_RESPONSE",
      }),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: fixture callback intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    try {
      await waitFor(() => existsSync(startedMarkerPath), 5000);
      // The run has now genuinely begun (runtime.activeRuns holds its key).
      // Any probe call counted from this point on, while the run is still
      // in flight, is the live-incident defect.
      runIsActive = true;
      // Give the scheduler several ticks' worth of wall time to fire while
      // the run is still in flight (subsequent ticks at TICK_INTERVAL_MS
      // would each re-evaluate dispatch — and re-probe — if unguarded).
      await new Promise((resolve) => setTimeout(resolve, RUN_DURATION_MS - 150));
      // Guard against the one genuine flake vector: if the run had already
      // completed by measurement time (e.g. under load), activeRuns would
      // have cleared and a probe would legitimately fire — that would fail
      // the assertion below for a reason unrelated to the guard. Assert the
      // run is still in flight so a failure below can only mean the guard
      // let a probe through against a genuinely active run.
      assert.equal(
        completedRuns.length,
        0,
        "the run must still be in flight at measurement time, or the assertion below is meaningless"
      );
      assert.equal(
        probeCallsWhileRunning,
        0,
        "forward-evidence-debt probe (reconcile) must not fire for a connector instance with an active run — " +
          "this is the exact live-incident mechanism: the probe's reconcile write and the active run's own " +
          "per-record writes contend for the same in-process connector-instance mutex, producing spurious " +
          "retryable ingest failures"
      );

      await waitFor(() => completedRuns.length === 1, 5000);
      runIsActive = false;

      // Once the run completes, the connector instance is no longer active —
      // the NEXT tick's probe call is expected and proves the guard is
      // scoped to "has an active run", not a blanket disable of the probe.
      await waitFor(() => probeCallsAfterCompletion > 0, 5000);
    } finally {
      scheduler.stop();
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});
