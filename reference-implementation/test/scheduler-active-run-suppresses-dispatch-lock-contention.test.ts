// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Companion to scheduler-active-run-suppresses-dispatch-probes.test.ts. That
// suite proves the guard suppresses the probe CALL (probe-count oracle). This
// suite proves the mechanism the live GroupMe UAT incident (run_1786410860909_1)
// actually hit: a real `withConnectorInstanceWrite` mutex contention between the
// evidence-reconcile probe and the in-flight run's own writes, surfaced as
// `ConnectorInstanceAdmissionError` (`connector_instance_busy`) — the exact
// error class `repairCandidate` (connector-summary-evidence-engine.ts) catches
// and that turns into a retryable, then systemic, `ingest_batch_storage_error`.
//
// `getForwardEvidenceDebt` here calls the REAL `withConnectorInstanceWrite` for
// the same connector instance id a real in-flight run holds open — mirroring
// `repairCandidate`'s own `withConnectorInstanceWrite(connectorInstanceId, ...)`
// call (scheduler-manager-factory.ts wires the real
// `reconcileDirtyConnectorSummaryEvidence`, which reaches `repairCandidate`).
// `PDPP_INGEST_LOCK_WAIT_MS` is set short so a real contention (if the guard
// were absent) resolves fast and deterministically, matching
// connector-instance-write-coordinator.test.ts's own pattern for proving
// `connector_instance_busy` under real contention.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import {
  ConnectorInstanceAdmissionError,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
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

async function withShortLockWait<T>(waitMs: number, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.PDPP_INGEST_LOCK_WAIT_MS;
  process.env.PDPP_INGEST_LOCK_WAIT_MS = String(waitMs);
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_INGEST_LOCK_WAIT_MS;
    } else {
      process.env.PDPP_INGEST_LOCK_WAIT_MS = previous;
    }
  }
}

test("guarded scheduler: a real in-flight run's held write lock never contends with the evidence-reconcile probe", async () => {
  await withShortLockWait(150, async () => {
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-lock-contention-"));
    const connectorPath = join(tmpDir, "long-running-connector.mjs");
    const startedMarkerPath = join(tmpDir, "started.marker");
    // Deliberately distinct from connector_id: the real multi-instance
    // hazard this guard must catch is instance A's active run suppressing
    // dispatch for a DIFFERENT sibling instance B of the same connector. A
    // fixture where connectorInstanceId === connectorId can't discriminate
    // a regression to a connectorId-only guard (e.g. `activeRuns.has(schedule.connectorId)`)
    // from the correct per-instance guard — both read the same key.
    const connectorInstanceId = `${spotifyManifest.connector_id}#cin_lock_contention`;

    // A connector that holds the run's OWN `withConnectorInstanceWrite` lock
    // for its entire in-flight duration — modeling the live incident's
    // per-record ingest writes, which take the same per-instance mutex the
    // reconcile repair does. Held via an explicit release signal (a marker
    // file) rather than a fixed timer so the test can deterministically
    // control exactly how long the lock is held across several scheduler ticks.
    const RUN_HOLD_MS = 400;
    const TICK_INTERVAL_MS = 40;
    let releaseRunLock!: () => void;
    const runLockHeld = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });

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
  }, ${RUN_HOLD_MS});
});
`,
      "utf8"
    );

    const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const completedRuns: RunRecord[] = [];
    const admissionErrors: unknown[] = [];
    let runIsActive = false;
    let probeCallsWhileRunning = 0;

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(spotifyManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, "scheduler_lock_contention_user");

      const scheduler = createScheduler({
        admitRunConnection: fakeAdmitRunConnection(),
        connectors: [
          {
            connectorId: spotifyManifest.connector_id,
            connectorInstanceId,
            connectorPath,
            intervalMs: TICK_INTERVAL_MS,
            manifest: spotifyManifest,
            maxRetries: 0,
            ownerSubjectId: "scheduler_lock_contention_user",
            ownerToken,
          },
        ],
        // Mirrors repairCandidate's real call
        // (connector-summary-evidence-engine.ts): reconcile takes the SAME
        // per-instance write-coordinator lock the run itself holds. If the
        // scheduler's guard did not suppress this probe for an active-run
        // instance, this call would race the run's held lock and — once
        // PDPP_INGEST_LOCK_WAIT_MS elapses — throw ConnectorInstanceAdmissionError
        // (connector_instance_busy), the exact live-incident mechanism.
        getForwardEvidenceDebt: async () => {
          if (runIsActive) {
            probeCallsWhileRunning += 1;
          }
          // Deliberately caught and counted here, not left to propagate: the
          // real dispatch-governor.ts probeForwardEvidenceDebt call site
          // swallows any throw from getForwardEvidenceDebt (fail-closed). If
          // this admission error were allowed to propagate instead, the
          // governor's catch would eat it silently and admissionErrors would
          // stay empty regardless of whether the guard held — the oracle
          // would go vacuous in exactly the way it must not.
          try {
            await withConnectorInstanceWrite(connectorInstanceId, async () => undefined);
          } catch (err) {
            admissionErrors.push(err);
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
        runIsActive = true;
        // Simulates the real run's own per-record write, acquired the moment
        // the run genuinely starts (mirroring when a real run's ingest
        // writes would first take this same per-instance lock): holds the
        // write-coordinator lock for the remainder of the run's in-flight
        // window.
        const runWriteHold = withConnectorInstanceWrite(connectorInstanceId, () => runLockHeld);

        // Give the scheduler several ticks' worth of wall time while the run
        // (and its write-coordinator lock) is still held.
        await new Promise((resolve) => setTimeout(resolve, RUN_HOLD_MS - 150));

        // Guard against the one genuine flake vector: if the run had already
        // completed by measurement time (e.g. under load), activeRuns would
        // have cleared and a probe would legitimately fire — that would fail
        // the assertion below for a reason unrelated to the guard. Assert the
        // run is still in flight so a failure below can only mean the guard
        // let a probe through against a genuinely active run.
        assert.equal(
          completedRuns.length,
          0,
          "the run must still be in flight at measurement time, or the assertions below are meaningless"
        );
        assert.equal(
          probeCallsWhileRunning,
          0,
          "the guard must suppress the probe entirely while the run is active — it must never even attempt the lock"
        );
        assert.deepEqual(
          admissionErrors,
          [],
          "no connector_instance_busy (ConnectorInstanceAdmissionError) may occur: the guarded scheduler never " +
            "issues a competing write-coordinator acquisition against a real in-flight run's held lock"
        );

        releaseRunLock();
        await runWriteHold;
        await waitFor(() => completedRuns.length === 1, 5000);
        runIsActive = false;
      } finally {
        scheduler.stop();
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeServer(server);
    }
  });
});

test("regression control: an UNGUARDED reconcile probe against a real held run lock DOES throw connector_instance_busy", async () => {
  // Negative control proving the oracle above is discriminating (not
  // vacuously green): with no scheduler guard involved at all, a bare
  // concurrent withConnectorInstanceWrite call against an instance whose
  // lock is already held — the exact shape an unguarded dispatch tick would
  // have produced — genuinely throws ConnectorInstanceAdmissionError. This
  // is the mechanism the fix's guard prevents from ever being reached.
  await withShortLockWait(50, async () => {
    const connectorInstanceId = "cin_unguarded_contention_control";
    let releaseHold!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holder = withConnectorInstanceWrite(connectorInstanceId, () => held);
    // Let the holder actually acquire the lock before the competing call.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await assert.rejects(
      () => withConnectorInstanceWrite(connectorInstanceId, async () => undefined),
      (err: unknown) => err instanceof ConnectorInstanceAdmissionError && err.code === "connector_instance_busy"
    );

    releaseHold();
    await holder;
  });
});
