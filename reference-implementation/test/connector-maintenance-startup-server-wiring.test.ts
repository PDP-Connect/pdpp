// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * This regression owns the `startServer` startup-order contract. It does not
 * recreate the ordering in test code: `startServer` receives one injected
 * timer constructor, starts its real bounded startup walker, and later arms
 * that real timer. The constructor enables `runImmediately` only to recreate
 * the competing-tick hazard while the real first fold is paused.
 *
 * Mutation oracle: restoring the rejected deferred startup launch in
 * server/index.ts lets the immediate timer acquire the coordinator first.
 * The real fold pause below is then never reached and this test fails its
 * bounded `waitFor` assertion, rather than silently accepting a zero-round
 * startup walk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type BrowserSurfaceLeaseSweepTimer,
  type BrowserSurfaceLeaseSweepTimerOptions,
  createBrowserSurfaceLeaseSweepTimer,
} from "../runtime/browser-surface-lease-sweep-timer.ts";
import {
  __testOnlySetFoldPauseHook,
  markConnectorSummaryEvidenceDirty,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const CONNECTOR_ID = "startup_wiring_probe";
const CONNECTION_ID = "cin_startup_wiring_probe";
const NOW = "2026-08-02T00:00:00.000Z";

interface StartedServer {
  abortStartupBackfill: (reason: unknown) => void;
  asServer: { close: (callback: () => void) => void; closeAllConnections: () => void };
  rsServer: { close: (callback: () => void) => void; closeAllConnections: () => void };
  schedulerManager: { stop: () => void } | null;
  startupSummaryEvidenceSweepDone: Promise<void>;
  stopBrowserSurfaceLeaseSweep: () => void;
  stopClientEventDeliveryWorker: () => Promise<void>;
  stopConnectorMaintenanceSweep: () => void;
}

function seedPausedFoldFixture(databasePath: string): Promise<void> {
  initDb(databasePath);
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      CONNECTOR_ID,
      JSON.stringify({
        capabilities: { public_listing: { listed: true, status: "test" } },
        connector_id: CONNECTOR_ID,
        display_name: "Startup wiring probe",
        protocol_version: "0.1.0",
        streams: [{ name: "items", primary_key: ["id"] }],
        version: "1.0.0",
      }),
      NOW
    );
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'startup wiring probe', 'active', 'account', 'probe', '{}', ?, ?, NULL)`
    )
    .run(CONNECTION_ID, CONNECTOR_ID, NOW, NOW);

  // Create the durable evidence baseline before inserting a raw newer
  // terminal event. That event then makes the actual startup fold enter the
  // read-model's named test pause; it is not a synthetic coordinator mock.
  return rebuildConnectorSummaryEvidence()
    .then(() => {
      getDb()
        .prepare(
          `INSERT INTO spine_events(
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
           ) VALUES (?, 1, 'run.completed', ?, ?, 'test', 'trc_startup_wiring', 'runtime', 'test', 'run', ?, 'succeeded', ?, ?, ?, '1')`
        )
        .run(
          "evt_startup_wiring",
          NOW,
          NOW,
          "run_startup_wiring",
          "run_startup_wiring",
          CONNECTION_ID,
          JSON.stringify({
            collection_facts: {
              streams: [
                {
                  checkpoint: "committed",
                  collected: 1,
                  considered: 1,
                  covered: 1,
                  pending_detail_gaps: 0,
                  skipped: null,
                  stream: "items",
                },
              ],
            },
            connection_id: CONNECTION_ID,
            connector_instance_id: CONNECTION_ID,
          })
        );
      return markConnectorSummaryEvidenceDirty({
        connectorInstanceId: CONNECTION_ID,
        reason: "startup wiring race fixture",
      });
    })
    .finally(() => closeDb());
}

async function waitFor<T>(promise: Promise<T>, description: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), 1500);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function closeServer(server: StartedServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.stopConnectorMaintenanceSweep();
  await server.stopClientEventDeliveryWorker();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(resolve)),
    new Promise<void>((resolve) => server.rsServer.close(resolve)),
  ]);
}

test("startServer gives its real startup walker the first fenced round before a factory-enabled immediate maintenance tick", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-startup-wiring-"));
  const databasePath = join(directory, "pdpp.sqlite");
  let releaseFold: (() => void) | null = null;
  let notifyFoldEntered: (() => void) | null = null;
  const foldEntered = new Promise<void>((resolve) => {
    notifyFoldEntered = resolve;
  });
  const startupRounds: number[] = [];
  let immediateTimerSweeps = 0;
  let server: StartedServer | null = null;
  try {
    await seedPausedFoldFixture(databasePath);
    __testOnlySetFoldPauseHook((point) => {
      if (point !== "after_seed_before_read") {
        return;
      }
      notifyFoldEntered?.();
      return new Promise<void>((resolve) => {
        releaseFold = resolve;
      });
    });

    const connectorMaintenanceSweepTimerFactory = (
      options: BrowserSurfaceLeaseSweepTimerOptions
    ): BrowserSurfaceLeaseSweepTimer =>
      createBrowserSurfaceLeaseSweepTimer({
        ...options,
        clearIntervalFn: () => undefined,
        runImmediately: true,
        setIntervalFn: () => ({}) as NodeJS.Timeout,
        sweep: async () => {
          immediateTimerSweeps += 1;
          await options.sweep();
        },
      });

    const starting = startServer({
      asPort: 0,
      autoEnrollEligibleSchedules: false,
      connectorMaintenanceSweepTimerFactory,
      dbPath: databasePath,
      onStartupSummaryEvidenceSweepRound: (_, round) => startupRounds.push(round),
      quiet: true,
      rsPort: 0,
      startClientEventDeliveryWorker: false,
    }) as Promise<StartedServer>;

    await waitFor(foldEntered, "the real startup fold to claim its first round");
    server = await starting;
    assert.equal(immediateTimerSweeps, 1, "startServer armed the injected competing immediate timer path");

    const release = releaseFold as (() => void) | null;
    assert.ok(release, "the real startup fold is held while the timer attempts its immediate tick");
    release();
    await server.startupSummaryEvidenceSweepDone;
    assert.ok(
      startupRounds.some((round) => round >= 1),
      "the startServer-owned startup walker records at least one completed round, never a suppressed zero-round walk"
    );
  } finally {
    (releaseFold as (() => void) | null)?.();
    __testOnlySetFoldPauseHook(null);
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
});
