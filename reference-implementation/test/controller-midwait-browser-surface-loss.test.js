/**
 * Controller integration tests for mid-wait browser-surface loss detection.
 *
 * Proves: when a connector passes the preflight readiness probe and then emits
 * a manual_action INTERACTION, the controller monitors the surface with a
 * periodic poll. If the surface dies before the owner responds:
 *
 *   - run.browser_surface_lost is emitted with the typed probe failure code,
 *   - the interaction resolves as "cancelled",
 *   - any subsequent respondToInteraction call for the same interaction_id
 *     throws no_pending_interaction (stale-response guard active),
 *   - the connector child receives INTERACTION_RESPONSE status=cancelled.
 *
 * Also proves that surface-backed otp interactions are monitored, non-browser
 * otp/credentials interactions are unaffected, and that a surface that stays
 * live allows the owner response to settle normally.
 *
 * Uses the same fake lease manager + DB setup as controller-browser-surface-readiness.test.js.
 * All timers are controlled via the low pollIntervalMs override so the test runs
 * without real wall-clock delays.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "@opendatalabs/remote-surface/leases";
import { ControllerError, __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";

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

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-controller-midwait-"));
  return path.join(dir, "pdpp.sqlite");
}

function createSchedulerStore() {
  const activeRuns = new Map();
  return {
    listActiveRuns: () => [...activeRuns.values()],
    upsertActiveRun: (record) => {
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

function createManagerWithReadySurface() {
  let leaseSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed"]),
      surfaceCap: 1,
      staticProfileKey: "managed-profile",
      staticCdpHttpUrl: "http://127.0.0.1:9222",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 600_000,
      defaultPriorityClass: "scheduled_refresh",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: "static",
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_static`,
    nextFencingToken: () => ++tokenSeq,
    initialSurfaces: [
      {
        surface_id: "surface_static",
        backend: "neko",
        profile_key: "managed-profile",
        connector_id: "managed",
        cdp_url: "http://127.0.0.1:9222",
        stream_base_url: "http://127.0.0.1:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
  });
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

/**
 * Build a probe factory that:
 *   - returns ok=true for the first `passTimes` calls (preflight + N polls),
 *   - returns the given failure code+detail for all subsequent calls.
 */
function buildProbeWithFailAfter(passTimes, failCode, failDetail) {
  let callCount = 0;
  return {
    probe: async () => {
      callCount++;
      if (callCount <= passTimes) {
        return { ok: true, pageTargetCount: 1 };
      }
      return { ok: false, code: failCode, detail: failDetail };
    },
  };
}

function setup(t, { probe, leaseManager, pollIntervalMs = 5 } = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const runConnectorCalls = [];
  const controller = createController({
    browserSurfaceLeaseManager: leaseManager || createManagerWithReadySurface(),
    browserSurfaceReadinessProbe: probe,
    browserSurfaceMidWaitPollIntervalMs: pollIntervalMs,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: (opts) => {
      runConnectorCalls.push(opts);
      return Promise.resolve({
        status: "completed",
        records_emitted: 0,
        state: null,
        checkpoint_summary: null,
      });
    },
  });
  return { controller, runConnectorCalls };
}

test("surface dies during manual_action wait: run.browser_surface_lost emitted, interaction cancelled", async (t) => {
  // The preflight probe passes once. The very next poll (mid-wait) fails,
  // simulating the CDP socket dropping after the connector starts but
  // before the owner submits their OTP.
  const probe = buildProbeWithFailAfter(1, "browser_surface_cdp_disconnected", "GET /json/version returned HTTP 503");

  let capturedOnInteraction = null;
  let interactionResponseStatus = null;

  const { controller } = setup(t, {
    probe,
    pollIntervalMs: 5,
  });

  // Replace runConnectorImpl with one that captures the onInteraction callback
  // and simulates a connector blocking on manual_action.
  closeDb();
  initDb(
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-midwait-main-"));
      return path.join(dir, "pdpp.sqlite");
    })()
  );
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  let resolveConnectorDone;
  const connectorDone = new Promise((res) => {
    resolveConnectorDone = res;
  });

  const c2 = createController({
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceReadinessProbe: probe,
    browserSurfaceMidWaitPollIntervalMs: 5,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: async (opts) => {
      capturedOnInteraction = opts.onInteraction;
      // Simulate the connector emitting a manual_action INTERACTION and waiting.
      const response = await opts.onInteraction({
        kind: "manual_action",
        request_id: "req_midwait_1",
        message: "Please complete the login in the browser.",
        stream: null,
      });
      interactionResponseStatus = response?.status;
      resolveConnectorDone(response);
      return {
        status: "completed",
        records_emitted: 0,
        state: null,
        checkpoint_summary: null,
      };
    },
  });

  const runResult = await c2.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_midwait_loss",
  });

  assert.equal(runResult.status, "started");

  // Wait for the connector to receive INTERACTION_RESPONSE (detector fires).
  const connectorResponse = await connectorDone;
  assert.equal(connectorResponse.status, "cancelled", "connector must receive cancelled interaction response");
  assert.equal(interactionResponseStatus, "cancelled");

  await c2.drainActiveRuns(2000);

  // run.browser_surface_lost must be emitted.
  const events = listRunEvents("run_midwait_loss");
  const lostEvent = events.find((e) => e.event_type === "run.browser_surface_lost");
  assert.ok(
    lostEvent,
    `expected run.browser_surface_lost; got: ${events.map((e) => e.event_type).join(", ")}`,
  );
  assert.equal(lostEvent.status, "surface_failed");
  assert.equal(lostEvent.data.interaction_id, "req_midwait_1");
  assert.equal(lostEvent.data.kind, "manual_action");
  assert.equal(lostEvent.data.browser_surface_probe.ok, false);
  assert.equal(lostEvent.data.browser_surface_probe.code, "browser_surface_cdp_disconnected");
  assert.match(lostEvent.data.browser_surface_probe.detail, /503/);
});

test("surface-backed otp wait is monitored and cancelled when the surface dies", async (t) => {
  const probe = buildProbeWithFailAfter(1, "browser_surface_cdp_disconnected", "GET /json/version returned HTTP 503");

  closeDb();
  initDb(
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-midwait-otp-surface-"));
      return path.join(dir, "pdpp.sqlite");
    })()
  );
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  let resolveConnectorDone;
  const connectorDone = new Promise((res) => {
    resolveConnectorDone = res;
  });
  let interactionResponseStatus = null;

  const c = createController({
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceReadinessProbe: probe,
    browserSurfaceMidWaitPollIntervalMs: 5,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: async (opts) => {
      const response = await opts.onInteraction({
        kind: "otp",
        request_id: "req_surface_otp_1",
        message: "Enter the OTP shown by the browser-backed login.",
        stream: null,
      });
      interactionResponseStatus = response?.status;
      resolveConnectorDone(response);
      return { status: "completed", records_emitted: 0, state: null, checkpoint_summary: null };
    },
  });

  await c.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_surface_otp_loss",
  });

  const connectorResponse = await connectorDone;
  assert.equal(connectorResponse.status, "cancelled");
  assert.equal(interactionResponseStatus, "cancelled");

  await c.drainActiveRuns(2000);

  const events = listRunEvents("run_surface_otp_loss");
  const lostEvent = events.find((e) => e.event_type === "run.browser_surface_lost");
  assert.ok(lostEvent, "expected run.browser_surface_lost for surface-backed otp");
  assert.equal(lostEvent.data.interaction_id, "req_surface_otp_1");
  assert.equal(lostEvent.data.kind, "otp");
  assert.equal(lostEvent.data.browser_surface_probe.code, "browser_surface_cdp_disconnected");
});

test("surface lost: respondToInteraction with same interaction_id throws no_pending_interaction", async (t) => {
  // Preflight passes once, then mid-wait poll fails immediately.
  const probe = buildProbeWithFailAfter(1, "browser_surface_cdp_unreachable", "fetch failed: ECONNREFUSED");

  let resolveConnectorDone;
  const connectorDone = new Promise((res) => {
    resolveConnectorDone = res;
  });

  closeDb();
  initDb(
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-midwait-stale-"));
      return path.join(dir, "pdpp.sqlite");
    })()
  );
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const c = createController({
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceReadinessProbe: probe,
    browserSurfaceMidWaitPollIntervalMs: 5,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: async (opts) => {
      await opts.onInteraction({
        kind: "manual_action",
        request_id: "req_stale_1",
        message: "Complete the browser step.",
        stream: null,
      });
      resolveConnectorDone();
      return { status: "completed", records_emitted: 0, state: null, checkpoint_summary: null };
    },
  });

  await c.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stale_resp",
  });

  // Wait for the detector to fire and clear the pending entry.
  await connectorDone;

  // Now try to respond. This must throw no_pending_interaction.
  assert.throws(
    () =>
      c.respondToInteraction("run_stale_resp", {
        interaction_id: "req_stale_1",
        status: "success",
      }),
    (err) => err instanceof ControllerError && err.code === "no_pending_interaction",
    "respondToInteraction must reject stale interaction_id after surface-loss cancellation",
  );

  await c.drainActiveRuns(2000);
});

test("surface stays live: owner response settles normally, no browser_surface_lost event", async (t) => {
  // Probe always returns ok, so the surface never dies.
  const alwaysOkProbe = {
    probe: async () => ({ ok: true, pageTargetCount: 1 }),
  };

  let resolveOwnerResponse;
  let resolveConnectorDone;
  const ownerResponseReady = new Promise((res) => {
    resolveOwnerResponse = res;
  });
  const connectorDone = new Promise((res) => {
    resolveConnectorDone = res;
  });

  closeDb();
  initDb(
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-midwait-live-"));
      return path.join(dir, "pdpp.sqlite");
    })()
  );
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  let interactionResponseStatus = null;
  const c = createController({
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceReadinessProbe: alwaysOkProbe,
    browserSurfaceMidWaitPollIntervalMs: 5,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: async (opts) => {
      const response = await opts.onInteraction({
        kind: "manual_action",
        request_id: "req_live_1",
        message: "Approve in browser.",
        stream: null,
      });
      interactionResponseStatus = response?.status;
      resolveConnectorDone();
      return { status: "completed", records_emitted: 0, state: null, checkpoint_summary: null };
    },
  });

  await c.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_live_surface",
  });

  // Let the interaction become pending, then owner responds with success.
  // Poll a few times to make sure the live surface doesn't cause a false loss.
  await new Promise((r) => setTimeout(r, 30));

  const pending = c.getPendingInteraction("run_live_surface");
  assert.ok(pending, "interaction should still be pending (surface is live)");

  c.respondToInteraction("run_live_surface", {
    interaction_id: "req_live_1",
    status: "success",
  });

  await connectorDone;
  await c.drainActiveRuns(2000);

  assert.equal(interactionResponseStatus, "success");

  const events = listRunEvents("run_live_surface");
  const lostEvent = events.find((e) => e.event_type === "run.browser_surface_lost");
  assert.equal(lostEvent, undefined, "must NOT emit run.browser_surface_lost when surface stays live");
});

test("otp interaction without browser surface is not monitored, no spurious browser_surface_lost", async (t) => {
  // A non-managed connector (no browser surface) emitting otp should work
  // normally without a detector.
  const NON_BROWSER_MANIFEST = {
    connector_id: "plain-connector",
    name: "Plain",
    version: "1.0.0",
    streams: [],
    capabilities: {},
  };

  closeDb();
  initDb(
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-midwait-otp-"));
      return path.join(dir, "pdpp.sqlite");
    })()
  );
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  let resolveConnectorDone;
  const connectorDone = new Promise((res) => {
    resolveConnectorDone = res;
  });
  let interactionResponseStatus = null;

  const c = createController({
    // No lease manager: not a managed connector, so no surface detector.
    browserSurfaceReadinessProbe: {
      probe: async () => {
        throw new Error("probe should never be called for non-browser interactions");
      },
    },
    browserSurfaceMidWaitPollIntervalMs: 5,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: async (opts) => {
      const response = await opts.onInteraction({
        kind: "otp",
        request_id: "req_otp_1",
        message: "Enter your OTP.",
        stream: null,
      });
      interactionResponseStatus = response?.status;
      resolveConnectorDone();
      return { status: "completed", records_emitted: 0, state: null, checkpoint_summary: null };
    },
  });

  await c.runNow("plain-connector", {
    manifest: NON_BROWSER_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_otp_plain",
  });

  // Let detector poll window pass to confirm no probe is called.
  await new Promise((r) => setTimeout(r, 30));

  // Respond with success. This should work normally.
  c.respondToInteraction("run_otp_plain", {
    interaction_id: "req_otp_1",
    status: "success",
  });

  await connectorDone;
  await c.drainActiveRuns(2000);

  assert.equal(interactionResponseStatus, "success");

  const events = listRunEvents("run_otp_plain");
  const lostEvent = events.find((e) => e.event_type === "run.browser_surface_lost");
  assert.equal(lostEvent, undefined, "no browser_surface_lost for non-browser interactions");
});
