import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "@opendatalabs/remote-surface/leases";
import { closeDb, initDb } from "../server/db.js";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";

// Regression guard for the scheduler cold-dispatch bug.
//
// `createController` accepted `browserSurfaceLeaseManager` as an option and used
// it internally (so manual `runNow` leases the warm neko surface), but it never
// re-exported the manager on the controller's public return object. As a result
// `controller.browserSurfaceLeaseManager === undefined`, which made the scheduler
// wiring in server/index.js resolve `runManagedConnectorViaController` to `null`
// and hardwire `isManagedConnector` to `false`. Scheduled managed-connector runs
// therefore fell through to the COLD `runConnector` path (empty profile, no
// cf_clearance) and failed the provider's bot challenge — while manual runs
// (which read the lease manager from `runNow`'s own closure) worked.
//
// The fix re-exports the manager on the public object. These tests assert the
// real controller (not a mock) exposes the same lease-manager instance it was
// built with — the exact invariant the scheduler wiring keys off.

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-controller-lease-export-"));
  return path.join(dir, "pdpp.sqlite");
}

function createLeaseManager() {
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed"]),
      surfaceCap: 1,
      staticProfileKey: "managed-profile",
      staticCdpHttpUrl: "http://127.0.0.1:9222/json/version",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs: 300_000,
      idleTtlMs: 600_000,
      defaultPriorityClass: "scheduled_refresh",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: "static",
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_${++surfaceSeq}`,
    nextFencingToken: () => ++tokenSeq,
  });
}

function buildController(t, overrides = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  return createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: {
      listActiveRuns: () => [],
      upsertActiveRun: () => {},
      deleteActiveRun: () => {},
      getSchedule: () => null,
      listSchedules: () => [],
      updateSchedule: () => {},
      createSchedule: () => {},
      setScheduleEnabled: () => {},
      deleteSchedule: () => {},
    },
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: () => ({ status: "succeeded" }),
    ...overrides,
  });
}

test("real controller re-exports the browser-surface lease manager it was built with", (t) => {
  const manager = createLeaseManager();
  const controller = buildController(t, { browserSurfaceLeaseManager: manager });

  // The exact regression: the public property must be the SAME instance that was
  // passed in — not undefined. The scheduler's managed-routing seam and its
  // `isManagedConnector` predicate both key off this property.
  assert.equal(
    controller.browserSurfaceLeaseManager,
    manager,
    "controller.browserSurfaceLeaseManager must be the lease manager passed to createController, so the scheduler routes managed runs through the warm surface instead of cold-dispatching",
  );
  // And it must expose the method the scheduler predicate calls.
  assert.equal(
    typeof controller.browserSurfaceLeaseManager.isManagedConnector,
    "function",
    "exposed lease manager must carry isManagedConnector so server/index.js's predicate is live",
  );
});

test("controller built without a lease manager leaves the property undefined (disabled case)", (t) => {
  const controller = buildController(t);

  assert.equal(
    controller.browserSurfaceLeaseManager,
    undefined,
    "with browser surfaces disabled the property is undefined, so the scheduler seam stays inert",
  );
});
