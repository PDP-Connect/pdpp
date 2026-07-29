// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: workspace package subpath is available to the test runtime.
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "@opendatalabs/remote-surface/leases";
import type { ControllerOptions } from "../runtime/controller.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { SchedulerStore } from "../server/stores/scheduler-store.ts";

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
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 300_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      staticCdpHttpUrl: "http://127.0.0.1:9222/json/version",
      staticProfileKey: "managed-profile",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      surfaceCap: 1,
      surfaceMode: "static",
    },
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_${leaseSeq}`;
    },
    makeSurfaceId: () => {
      surfaceSeq += 1;
      return `surface_${surfaceSeq}`;
    },
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
  });
}

function buildController(t: TestContext, overrides: Partial<ControllerOptions> = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const schedulerStore: SchedulerStore = {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: () => undefined,
    deleteSchedule: () => undefined,
    getActiveRun: () => null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => [],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: () => true,
    upsertLastRunTime: () => undefined,
  };

  return createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.resolve({ status: "succeeded" }),
    schedulerStore,
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
    },
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
    "controller.browserSurfaceLeaseManager must be the lease manager passed to createController, so the scheduler routes managed runs through the warm surface instead of cold-dispatching"
  );
  // And it must expose the method the scheduler predicate calls.
  assert.equal(
    typeof controller.browserSurfaceLeaseManager.isManagedConnector,
    "function",
    "exposed lease manager must carry isManagedConnector so server/index.js's predicate is live"
  );
});

test("controller built without a lease manager leaves the property undefined (disabled case)", (t) => {
  const controller = buildController(t);

  assert.equal(
    controller.browserSurfaceLeaseManager,
    undefined,
    "with browser surfaces disabled the property is undefined, so the scheduler seam stays inert"
  );
});
