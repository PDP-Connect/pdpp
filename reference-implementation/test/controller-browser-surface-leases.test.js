import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "../runtime/browser-surface-leases.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";

const MANIFEST = {
  connector_id: "managed",
  name: "Managed",
  version: "1.0.0",
  streams: [],
  capabilities: {
    browser_surface: {
      profile_key: "managed-profile",
    },
  },
};

const OTHER_MANAGED_MANIFEST = {
  ...MANIFEST,
  connector_id: "other-managed",
  name: "Other Managed",
  capabilities: {
    browser_surface: {
      profile_key: "managed-profile",
    },
  },
};

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-controller-bsl-"));
  return path.join(dir, "pdpp.sqlite");
}

function createSchedulerStore(calls) {
  const activeRuns = new Map();
  return {
    listActiveRuns: () => [...activeRuns.values()],
    upsertActiveRun: (record) => {
      calls.persistActiveRun += 1;
      activeRuns.set(record.run_id, record);
    },
    deleteActiveRun: (_connectorId, runId) => {
      activeRuns.delete(runId);
    },
    getSchedule: () => null,
    listSchedules: () => [],
    updateSchedule: () => {},
    createSchedule: () => {},
    setScheduleEnabled: () => {},
    deleteSchedule: () => {},
  };
}

function createManager({ surfaceCap = 1, staticProfileKey, leaseWaitTimeoutMs = 300_000 } = {}) {
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed", "other-managed"]),
      surfaceCap,
      staticProfileKey,
      staticCdpHttpUrl: "http://127.0.0.1:9222/json/version",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs,
      idleTtlMs: 600_000,
      defaultPriorityClass: "scheduled_refresh",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: staticProfileKey ? "static" : "dynamic",
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_${++surfaceSeq}`,
    nextFencingToken: () => ++tokenSeq,
  });
}

function setup(t, { manager = createManager(), runConnectorImpl, connectorPathResolver = () => "/tmp/connector.js" } = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const calls = {
    persistActiveRun: 0,
    registerNonce: 0,
    runConnector: 0,
    runConnectorOpts: [],
  };
  const controller = createController({
    browserSurfaceLeaseManager: manager,
    connectorPathResolver,
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(calls),
    streamingTargetNonceHooks: {
      registerNonce: () => {
        calls.registerNonce += 1;
      },
      clearNonce: () => {},
    },
    runConnectorImpl: (opts) => {
      calls.runConnector += 1;
      calls.runConnectorOpts.push(opts);
      return runConnectorImpl
        ? runConnectorImpl(opts)
        : Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
    },
  });
  return { calls, controller, manager };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function listRunEventTypes(runId) {
  return getDb()
    .prepare("SELECT event_type FROM spine_events WHERE run_id = ? ORDER BY event_seq")
    .all(runId)
    .map((row) => row.event_type);
}

function listRunEvents(runId) {
  return getDb()
    .prepare("SELECT event_type, status, data_json FROM spine_events WHERE run_id = ? ORDER BY event_seq")
    .all(runId)
    .map((row) => ({
      event_type: row.event_type,
      status: row.status,
      data: row.data_json ? JSON.parse(row.data_json) : null,
    }));
}

test("managed free surface leases and spawns with browser-surface env", async (t) => {
  const { calls, controller, manager } = setup(t);

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_free",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.run_id, "run_free");
  assert.equal(result.status, "started");
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.registerNonce, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_REQUIRED, "neko");
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_LEASE_ID, "lease_1");
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_PROFILE_KEY, "managed-profile");
  assert.equal(manager.getLease("lease_1").status, "released");
});

test("managed run emits browser-surface starting before leased", async (t) => {
  const { controller } = setup(t);

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_starting_event",
  });
  await controller.drainActiveRuns(1000);
  await waitFor(
    () => listRunEventTypes("run_starting_event").includes("run.browser_surface_leased"),
    "browser-surface leased event should be emitted"
  );

  const eventTypes = listRunEventTypes("run_starting_event");
  assert.ok(eventTypes.includes("run.browser_surface_starting"));
  assert.ok(
    eventTypes.indexOf("run.browser_surface_starting") < eventTypes.indexOf("run.browser_surface_leased"),
    "starting event should precede leased event"
  );
});

test("managed run emits browser-surface cancelled when manual action is cancelled", async (t) => {
  const runConnectorImpl = async (opts) => {
    const response = await opts.onInteraction({
      kind: "manual_action",
      request_id: "int_cancel_surface",
      message: "cancel me",
    });
    return { status: response.status, records_emitted: 0, state: null, checkpoint_summary: null };
  };
  const { controller } = setup(t, { runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_cancel_event",
  });
  await waitFor(
    () => controller.getPendingInteraction("run_cancel_event")?.interaction_id === "int_cancel_surface",
    "manual action should become pending"
  );
  controller.respondToInteraction("run_cancel_event", {
    interaction_id: "int_cancel_surface",
    status: "cancelled",
  });
  await controller.drainActiveRuns(1000);
  await waitFor(
    () => listRunEventTypes("run_cancel_event").includes("run.browser_surface_cancelled"),
    "browser-surface cancelled event should be emitted"
  );
});

test("managed cap-full second connector queues without active-run, nonce, or spawn side effects", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  const queued = await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_second",
  });

  assert.equal(queued.status, "waiting_for_browser_surface");
  assert.equal(queued.browser_surface.browser_surface_wait_reason, "capacity_full");
  assert.equal(manager.getLease("lease_2").priority_class, "owner_interactive");
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.registerNonce, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(controller.getActiveRun("managed").run_id, "run_first");
  assert.equal(controller.getActiveRun("other-managed"), null);
  assert.deepEqual(controller.listBrowserSurfaceRunProjections().find((run) => run.pending_run_id === "run_second"), {
    connector_id: "other-managed",
    pending_run_id: "run_second",
    browser_surface_status: "waiting_for_browser_surface",
    browser_surface_lease_id: "lease_2",
    browser_surface_profile_key: "managed-profile",
    browser_surface_wait_reason: "capacity_full",
  });

  releaseFirst();
  await waitFor(() => calls.runConnector === 2, "queued browser-surface run should be promoted and spawned");
  await controller.drainActiveRuns(1000);
  assert.equal(manager.getLease("lease_2").status, "released");
  assert.equal(controller.getActiveRun("other-managed"), null);
});

test("queued browser-surface cancellation emits event and promotes next waiter", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_cancelled_waiter",
  });

  const cancelled = await controller.cancelBrowserSurfaceRun("run_cancelled_waiter");

  assert.equal(cancelled?.browser_surface_status, "cancelled");
  assert.equal(manager.getLease("lease_2").status, "cancelled");
  assert.ok(listRunEventTypes("run_cancelled_waiter").includes("run.browser_surface_cancelled"));

  releaseFirst();
  await controller.drainActiveRuns(1000);
  assert.equal(calls.runConnector, 1);
});

test("queued browser-surface timeout emits deferred event without connector failure", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile", leaseWaitTimeoutMs: 0 });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_timed_out_waiter",
  });
  const expired = await controller.expireBrowserSurfaceWaits();

  assert.equal(expired.length, 1);
  assert.equal(expired[0].browser_surface_status, "deferred");
  assert.equal(expired[0].browser_surface_wait_reason, "lease_wait_timeout");
  const events = listRunEvents("run_timed_out_waiter");
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_deferred"));
  assert.equal(events.some((event) => event.event_type === "run.failed"), false);

  releaseFirst();
  await controller.drainActiveRuns(1000);
  assert.equal(calls.runConnector, 1);
});

test("promotion precondition failure defers lease instead of recording clean release", async (t) => {
  let releaseFirst;
  let promotedRunPathResolutions = 0;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller } = setup(t, {
    manager,
    runConnectorImpl,
    connectorPathResolver: (_connectorId, _manifest, options) => {
      if (options?.runId !== "run_promotion_failure") {
        return "/tmp/connector.js";
      }
      promotedRunPathResolutions += 1;
      return promotedRunPathResolutions > 1 ? null : "/tmp/connector.js";
    },
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_promotion_failure",
  });

  releaseFirst();
  await waitFor(
    () => manager.getLease("lease_2")?.status === "deferred",
    "promotion failure should terminally defer the promoted lease"
  );

  const failedLease = manager.getLease("lease_2");
  assert.equal(failedLease.status, "deferred");
  assert.equal(failedLease.wait_reason, "launch_precondition_failed");
  const events = listRunEvents("run_promotion_failure");
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_deferred"));
  assert.equal(events.some((event) => event.event_type === "run.browser_surface_released"), false);
});

test("managed connector with active run rejects without acquiring a new lease", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 2 });
  const runConnectorImpl = () =>
    new Promise((resolve) => {
      releaseFirst = () => resolve({ status: "completed" });
    });
  const { controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_active",
  });

  await assert.rejects(
    () =>
      controller.runNow("managed", {
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_duplicate",
      }),
    /Connector already has an active run/
  );

  assert.equal(manager.listLeases().length, 1);

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("duplicate queued managed connector request reports existing pending run", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller, manager: leases } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_waiting",
  });

  await assert.rejects(
    () =>
      controller.runNow("other-managed", {
        manifest: OTHER_MANAGED_MANIFEST,
        runId: "run_duplicate_wait",
      }),
    (err) => {
      assert.equal(err.code, "run_browser_surface_queued");
      assert.equal(err.runId, "run_waiting");
      return true;
    }
  );

  assert.equal(leases.listLeases().length, 2);

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("incompatible static profile defers without active-run, nonce, or spawn side effects", async (t) => {
  const { calls, controller } = setup(t, {
    manager: createManager({ staticProfileKey: "other-profile" }),
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_deferred",
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.browser_surface.browser_surface_wait_reason, "incompatible_static_profile");
  assert.equal(calls.persistActiveRun, 0);
  assert.equal(calls.registerNonce, 0);
  assert.equal(calls.runConnector, 0);
  assert.equal(controller.getActiveRun("managed"), null);
  assert.deepEqual(controller.listBrowserSurfaceRunProjections().find((run) => run.pending_run_id === "run_deferred"), {
    connector_id: "managed",
    pending_run_id: "run_deferred",
    browser_surface_status: "deferred",
    browser_surface_lease_id: "lease_1",
    browser_surface_profile_key: "managed-profile",
    browser_surface_wait_reason: "incompatible_static_profile",
  });
});

test("release frees the lease for the next managed run", async (t) => {
  const { controller, manager } = setup(t);

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_one",
  });
  await controller.drainActiveRuns(1000);

  const second = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_two",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(second.status, "started");
  assert.equal(manager.getLease("lease_1").status, "released");
  assert.equal(manager.getLease("lease_2").status, "released");
});
