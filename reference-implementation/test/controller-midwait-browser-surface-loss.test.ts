// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import test, { type TestContext } from "node:test";
import {
  type BrowserSurfaceAllocator,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  // biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
} from "@opendatalabs/remote-surface/leases";
import type {
  BrowserSurfaceReadinessProbe,
  BrowserSurfaceReadinessProbeCode,
} from "../runtime/browser-surface-readiness.ts";
import { __resetControllerInteractionStateForTests, ControllerError, createController } from "../runtime/controller.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import type { ActiveRunRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";

const REGEXP_1 = /503/;

/** Local equivalents of runtime/controller.ts's unexported RuntimeInteraction/InteractionResponse. */
interface FixtureInteractionRequest {
  readonly kind: string;
  readonly message?: string;
  readonly request_id: string;
  readonly stream?: string | null;
  readonly [key: string]: unknown;
}

interface FixtureInteractionResponse {
  data?: Record<string, unknown>;
  readonly request_id: string;
  readonly status: "cancelled" | "success";
  readonly type: "INTERACTION_RESPONSE";
}

function callOnInteraction(
  onInteraction: ((request: FixtureInteractionRequest) => unknown) | null | undefined,
  request: FixtureInteractionRequest
): Promise<FixtureInteractionResponse> {
  if (!onInteraction) {
    throw new Error("onInteraction was not provided by the controller");
  }
  return onInteraction(request) as Promise<FixtureInteractionResponse>;
}

interface BrowserSurfaceLostEventData {
  readonly browser_surface_probe: { readonly ok: boolean; readonly code: string; readonly detail: string };
  readonly interaction_id: string;
  readonly kind: string;
}

function surfaceLostData(data: Record<string, unknown> | null): BrowserSurfaceLostEventData {
  assert.ok(data);
  return data as unknown as BrowserSurfaceLostEventData;
}

const MANIFEST = {
  capabilities: {
    browser_surface: {
      profile_key: "managed-profile",
    },
  },
  connector_id: "managed",
  name: "Managed",
  streams: [],
  version: "1.0.0",
};

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-controller-midwait-"));
  return path.join(dir, "pdpp.sqlite");
}

// A minimal, production-shaped admission fixture. Every `runNow` call in this
// file omits `connectorInstanceId` (these tests exercise the "managed"
// browser-surface connector against a single unnamespaced static surface), so
// the fallback here echoes `connectorId` itself as the admitted instance —
// NOT a synthesized default-account id — to keep
// `connectorInstanceId === connectorId`. That equality is load-bearing:
// `readBrowserSurfaceProfileKey` (runtime/browser-surface/profile-key.ts)
// namespaces the profile key as `${profileKey}:${connectorInstanceId}`
// whenever the two differ, which would make this fixture's static surface's
// plain "managed-profile" key mismatch and the run defer
// (`incompatible_static_profile`) — a fixture-induced behavior change this
// admission gate must not introduce. Mirrors the equivalent fallback in
// controller-browser-surface-readiness.test.ts's `admitManagedFixtureRun`.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? connectorId;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function createSchedulerStore(): SchedulerStore {
  const activeRuns = new Map<string, ActiveRunRecord>();
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: (_connectorId, runId) => {
      activeRuns.delete(runId);
    },
    deleteSchedule: () => undefined,
    getActiveRun: (connectorInstanceId) => activeRuns.get(connectorInstanceId) ?? null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: (record) => {
      activeRuns.set(record.run_id, record);
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

function createManagerWithReadySurface(surfaceMode: "static" | "dynamic" = "static") {
  let leaseSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      staticCdpHttpUrl: "http://127.0.0.1:9222",
      staticProfileKey: "managed-profile",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      surfaceCap: 1,
      surfaceMode,
    },
    initialSurfaces: [
      {
        backend: "neko",
        cdp_url: "http://127.0.0.1:9222",
        connector_id: "managed",
        created_at: "2026-05-12T11:00:00.000Z",
        health: "ready",
        last_used_at: "2026-05-12T11:00:00.000Z",
        profile_key: "managed-profile",
        stream_base_url: "http://127.0.0.1:8080",
        surface_id: "surface_static",
      },
    ],
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_${leaseSeq}`;
    },
    makeSurfaceId: () => "surface_static",
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
  });
}

function createTestAllocator(stopRequests: string[]): BrowserSurfaceAllocator {
  return {
    ensureSurface: async (request) => ({
      backend: "neko",
      cdp_url: "http://127.0.0.1:9222/replacement",
      connector_id: request.connectorId,
      created_at: "2026-05-12T12:00:00.000Z",
      health: "ready",
      last_used_at: "2026-05-12T12:00:00.000Z",
      profile_key: request.profileKey,
      stream_base_url: "http://127.0.0.1:8080/replacement",
      surface_id: request.surfaceId,
    }),
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [],
    stopSurface: ({ surfaceId }) => {
      stopRequests.push(surfaceId);
      return Promise.resolve(null);
    },
  };
}

interface RunEventRow {
  data_json: string | null;
  event_type: string;
  status: string;
}

function listRunEvents(runId: string) {
  return (
    getDb()
      .prepare("SELECT event_type, status, data_json FROM spine_events WHERE run_id = ? ORDER BY event_seq")
      .all(runId) as RunEventRow[]
  ).map((row) => ({
    data: row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : null,
    event_type: row.event_type,
    status: row.status,
  }));
}

/**
 * Build a probe factory that:
 *   - returns ok=true for the first `passTimes` calls (preflight + N polls),
 *   - returns the given failure code+detail for all subsequent calls.
 */
function buildProbeWithFailAfter(
  passTimes: number,
  failCode: BrowserSurfaceReadinessProbeCode,
  failDetail: string
): BrowserSurfaceReadinessProbe {
  let callCount = 0;
  return {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    probe: async () => {
      callCount += 1;
      if (callCount <= passTimes) {
        return { ok: true, pageTargetCount: 1 };
      }
      return { code: failCode, detail: failDetail, ok: false };
    },
  };
}

interface SetupOptions {
  leaseManager?: BrowserSurfaceLeaseManager;
  pollIntervalMs?: number;
  probe?: BrowserSurfaceReadinessProbe;
}

function setup(t: TestContext, { probe, leaseManager, pollIntervalMs = 5 }: SetupOptions = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const runConnectorCalls: unknown[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    browserSurfaceLeaseManager: leaseManager || createManagerWithReadySurface(),
    ...(probe ? { browserSurfaceReadinessProbe: probe } : {}),
    browserSurfaceMidWaitPollIntervalMs: pollIntervalMs,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: (opts) => {
      runConnectorCalls.push(opts);
      return Promise.resolve({
        checkpoint_summary: null,
        records_emitted: 0,
        state: null,
        status: "succeeded" as const,
      });
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
    },
  });
  return { controller, runConnectorCalls };
}

test("surface dies during manual_action wait: run.browser_surface_lost emitted, interaction cancelled", async (t) => {
  // The preflight probe passes once. The very next poll (mid-wait) fails,
  // simulating the CDP socket dropping after the connector starts but
  // before the owner submits their OTP.
  const probe = buildProbeWithFailAfter(1, "browser_surface_cdp_disconnected", "GET /json/version returned HTTP 503");

  let interactionResponseStatus: "cancelled" | "success" | null = null;

  setup(t, {
    pollIntervalMs: 5,
    probe,
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

  let resolveConnectorDone!: (value?: FixtureInteractionResponse) => void;
  const connectorDone = new Promise<FixtureInteractionResponse | undefined>((res) => {
    resolveConnectorDone = res;
  });
  const leaseManager = createManagerWithReadySurface("dynamic");
  const stopRequests: string[] = [];

  const c2 = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    browserSurfaceAllocator: createTestAllocator(stopRequests),
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceMidWaitPollIntervalMs: 5,
    browserSurfaceReadinessProbe: probe,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async (opts) => {
      // Simulate the connector emitting a manual_action INTERACTION and waiting.
      const response = await callOnInteraction(opts.onInteraction, {
        kind: "manual_action",
        message: "Please complete the login in the browser.",
        request_id: "req_midwait_1",
        stream: null,
      });
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      interactionResponseStatus = response?.status;
      resolveConnectorDone(response);
      return {
        checkpoint_summary: null,
        records_emitted: 0,
        state: null,
        status: "succeeded",
      };
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
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
  assert.ok(connectorResponse);
  assert.equal(connectorResponse.status, "cancelled", "connector must receive cancelled interaction response");
  assert.equal(interactionResponseStatus, "cancelled");

  await c2.drainActiveRuns(2000);

  assert.equal(
    leaseManager.getSurface("surface_static"),
    undefined,
    "a mid-wait CDP loss must invalidate the surface before cleanup releases its lease"
  );
  assert.deepEqual(stopRequests, ["surface_static"], "a dynamic surface loss must stop the dead allocator resource");

  // run.browser_surface_lost must be emitted.
  const events = listRunEvents("run_midwait_loss");
  const lostEvent = events.find((e) => e.event_type === "run.browser_surface_lost");
  assert.ok(lostEvent, `expected run.browser_surface_lost; got: ${events.map((e) => e.event_type).join(", ")}`);
  assert.equal(lostEvent.status, "surface_failed");
  assert.equal(surfaceLostData(lostEvent.data).interaction_id, "req_midwait_1");
  assert.equal(surfaceLostData(lostEvent.data).kind, "manual_action");
  assert.equal(surfaceLostData(lostEvent.data).browser_surface_probe.ok, false);
  assert.equal(surfaceLostData(lostEvent.data).browser_surface_probe.code, "browser_surface_cdp_disconnected");
  assert.match(surfaceLostData(lostEvent.data).browser_surface_probe.detail, REGEXP_1);
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

  let resolveConnectorDone!: (value?: FixtureInteractionResponse) => void;
  const connectorDone = new Promise<FixtureInteractionResponse | undefined>((res) => {
    resolveConnectorDone = res;
  });
  let interactionResponseStatus: "cancelled" | "success" | null = null;

  const c = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceMidWaitPollIntervalMs: 5,
    browserSurfaceReadinessProbe: probe,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async (opts) => {
      const response = await callOnInteraction(opts.onInteraction, {
        kind: "otp",
        message: "Enter the OTP shown by the browser-backed login.",
        request_id: "req_surface_otp_1",
        stream: null,
      });
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      interactionResponseStatus = response?.status;
      resolveConnectorDone(response);
      return { checkpoint_summary: null, records_emitted: 0, state: null, status: "succeeded" };
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
    },
  });

  await c.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_surface_otp_loss",
  });

  const connectorResponse = await connectorDone;
  assert.ok(connectorResponse);
  assert.equal(connectorResponse.status, "cancelled");
  assert.equal(interactionResponseStatus, "cancelled");

  await c.drainActiveRuns(2000);

  const events = listRunEvents("run_surface_otp_loss");
  const lostEvent = events.find((e) => e.event_type === "run.browser_surface_lost");
  assert.ok(lostEvent, "expected run.browser_surface_lost for surface-backed otp");
  assert.equal(surfaceLostData(lostEvent.data).interaction_id, "req_surface_otp_1");
  assert.equal(surfaceLostData(lostEvent.data).kind, "otp");
  assert.equal(surfaceLostData(lostEvent.data).browser_surface_probe.code, "browser_surface_cdp_disconnected");
});

test("surface lost: respondToInteraction with same interaction_id throws no_pending_interaction", async (t) => {
  // Preflight passes once, then mid-wait poll fails immediately.
  const probe = buildProbeWithFailAfter(1, "browser_surface_cdp_unreachable", "fetch failed: ECONNREFUSED");

  let resolveConnectorDone!: (value?: FixtureInteractionResponse) => void;
  const connectorDone = new Promise<FixtureInteractionResponse | undefined>((res) => {
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
    admitRunConnection: fakeAdmitRunConnection(),
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceMidWaitPollIntervalMs: 5,
    browserSurfaceReadinessProbe: probe,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async (opts) => {
      await callOnInteraction(opts.onInteraction, {
        kind: "manual_action",
        message: "Complete the browser step.",
        request_id: "req_stale_1",
        stream: null,
      });
      resolveConnectorDone();
      return { checkpoint_summary: null, records_emitted: 0, state: null, status: "succeeded" };
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
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
    "respondToInteraction must reject stale interaction_id after surface-loss cancellation"
  );

  await c.drainActiveRuns(2000);
});

test("surface stays live: owner response settles normally, no browser_surface_lost event", async (t) => {
  // Probe always returns ok, so the surface never dies.
  const alwaysOkProbe: BrowserSurfaceReadinessProbe = {
    probe: async () => ({ ok: true, pageTargetCount: 1 }),
  };

  let resolveConnectorDone!: (value?: FixtureInteractionResponse) => void;
  const connectorDone = new Promise<FixtureInteractionResponse | undefined>((res) => {
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

  let interactionResponseStatus: "cancelled" | "success" | null = null;
  const c = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    browserSurfaceLeaseManager: createManagerWithReadySurface(),
    browserSurfaceMidWaitPollIntervalMs: 5,
    browserSurfaceReadinessProbe: alwaysOkProbe,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async (opts) => {
      const response = await callOnInteraction(opts.onInteraction, {
        kind: "manual_action",
        message: "Approve in browser.",
        request_id: "req_live_1",
        stream: null,
      });
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      interactionResponseStatus = response?.status;
      resolveConnectorDone();
      return { checkpoint_summary: null, records_emitted: 0, state: null, status: "succeeded" };
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
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
    capabilities: {},
    connector_id: "plain-connector",
    name: "Plain",
    streams: [],
    version: "1.0.0",
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

  let resolveConnectorDone!: (value?: FixtureInteractionResponse) => void;
  const connectorDone = new Promise<FixtureInteractionResponse | undefined>((res) => {
    resolveConnectorDone = res;
  });
  let interactionResponseStatus: "cancelled" | "success" | null = null;

  const c = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    browserSurfaceMidWaitPollIntervalMs: 5,
    // No lease manager: not a managed connector, so no surface detector.
    browserSurfaceReadinessProbe: {
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      probe: async () => {
        throw new Error("probe should never be called for non-browser interactions");
      },
    },
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async (opts) => {
      const response = await callOnInteraction(opts.onInteraction, {
        kind: "otp",
        message: "Enter your OTP.",
        request_id: "req_otp_1",
        stream: null,
      });
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      interactionResponseStatus = response?.status;
      resolveConnectorDone();
      return { checkpoint_summary: null, records_emitted: 0, state: null, status: "succeeded" };
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
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
