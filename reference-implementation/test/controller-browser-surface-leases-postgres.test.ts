// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  // biome-ignore lint/correctness/noUnresolvedImports: workspace package subpath is available to the test runtime.
} from "@opendatalabs/remote-surface/leases";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import { createPostgresBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import type { ActiveRunRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function schedulerStore(): SchedulerStore {
  const active = new Map<string, ActiveRunRecord>();
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: (_connectorId, runId) => {
      for (const [key, value] of active) {
        if (value.run_id === runId) {
          active.delete(key);
        }
      }
    },
    deleteSchedule: () => undefined,
    getActiveRun: (connectorInstanceId) => active.get(connectorInstanceId) ?? null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => [...active.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: (record) => {
      active.set(record.connector_instance_id ?? record.run_id, record);
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

test("dedicated PostgreSQL: duplicate allocator-absent ready rows create one boundary and one successor completion", {
  skip: POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async (t) => {
  assert.ok(POSTGRES_URL, "dedicated PostgreSQL URL is configured when this test runs");
  const namespace = `pg-ready-scope-${process.pid}-${Date.now()}`;
  const connectorId = `${namespace}-managed`;
  const subjectId = `${namespace}-subject`;
  const profileKey = `managed-profile:${subjectId}`;
  const first: BrowserSurface = {
    backend: "neko",
    cdp_url: "http://pg-ready-current:9222",
    connector_id: connectorId,
    container_id: "pg-ready-current-container",
    created_at: "2026-07-29T20:00:00.000Z",
    health: "ready",
    last_used_at: "2026-07-29T21:00:00.000Z",
    profile_key: profileKey,
    stream_base_url: "http://pg-ready-current:8080",
    surface_id: `${namespace}-a-current`,
    surface_subject_id: subjectId,
  };
  const duplicate: BrowserSurface = {
    ...first,
    cdp_url: "http://pg-ready-redundant:9222",
    container_id: "pg-ready-redundant-container",
    stream_base_url: "http://pg-ready-redundant:8080",
    surface_id: `${namespace}-b-redundant`,
  };
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  __resetControllerInteractionStateForTests();
  t.after(async () => {
    __resetControllerInteractionStateForTests();
    await postgresQuery("DELETE FROM browser_surface_replacement_selection_overrides WHERE replacement_id LIKE $1", [
      `${namespace}%`,
    ]);
    await postgresQuery("DELETE FROM browser_surface_replacement_receipts WHERE connection_id = $1", [subjectId]);
    await postgresQuery("DELETE FROM browser_surface_leases WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM browser_surfaces WHERE connector_id = $1", [connectorId]);
    await closePostgresStorage();
  });

  const manager = new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set([connectorId]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 10,
      surfaceMode: "dynamic",
    },
    initialSurfaces: [first, duplicate],
    makeLeaseId: () => `${namespace}-successor-lease`,
    makeSurfaceId: () => `${namespace}-successor-surface`,
    nextFencingToken: () => 1,
    now: () => new Date("2026-07-29T21:00:00.000Z"),
  });
  const leaseStore = createPostgresBrowserSurfaceLeaseStore();
  const receiptStore = createPostgresBrowserSurfaceReplacementReceiptStore();
  const allocatorSurfaces = new Map<string, BrowserSurface>();
  let ensureCalls = 0;
  const allocator: BrowserSurfaceAllocator = {
    // biome-ignore lint/suspicious/useAwait: allocator contract requires a Promise even though this deterministic fixture has no asynchronous work.
    ensureSurface: async (request) => {
      ensureCalls += 1;
      const successor: BrowserSurface = {
        ...first,
        cdp_url: "http://pg-ready-successor:9222",
        container_id: "pg-ready-successor-container",
        health: "ready",
        last_used_at: "2026-07-29T21:01:00.000Z",
        stream_base_url: "http://pg-ready-successor:8080",
        surface_id: request.surfaceId,
      };
      allocatorSurfaces.set(successor.surface_id, successor);
      return successor;
    },
    getSurfaceStatus: async (surfaceId) => allocatorSurfaces.get(surfaceId) ?? null,
    listSurfaces: async () => [...allocatorSurfaces.values()],
    stopSurface: async () => null,
  };
  const controller = createController({
    browserSurfaceAllocator: allocator,
    browserSurfaceLeaseManager: manager,
    browserSurfaceLeaseStore: leaseStore,
    browserSurfaceReadinessProbe: {
      probe: async () => ({ browserGenerationHash: "a".repeat(64), ok: true as const, pageTargetCount: 1 }),
    },
    browserSurfaceReplacementReceiptStore: receiptStore,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async () => ({ checkpoint_summary: null, records_emitted: 0, state: null, status: "succeeded" }),
    schedulerStore: schedulerStore(),
  });
  await leaseStore.upsertSurface(first);
  await leaseStore.upsertSurface(duplicate);
  await controller.reconcileBrowserSurfaceLeasesAfterBoot();

  const started = (await receiptStore.list()).filter(
    (receipt) =>
      receipt.phase === "started" && receipt.connection_id === subjectId && receipt.profile_key === profileKey
  );
  assert.deepEqual(
    started.map((receipt) => receipt.surface_id),
    [first.surface_id]
  );
  assert.equal((await leaseStore.getSurface(first.surface_id))?.health, "unhealthy");
  assert.equal((await leaseStore.getSurface(duplicate.surface_id))?.health, "unhealthy");

  const result = await controller.runNow(connectorId, {
    connectorInstanceId: subjectId,
    manifest: {
      capabilities: { browser_surface: { profile_key: "managed-profile" } },
      connector_id: connectorId,
      name: "Postgres managed",
      streams: [],
      version: "1.0.0",
    },
    ownerToken: "owner-token",
    runId: `${namespace}-successor-run`,
  });
  await controller.drainActiveRuns(1000);
  assert.equal(result.status, "started");
  assert.equal(ensureCalls, 1);
  assert.deepEqual(
    (await receiptStore.list())
      .filter((receipt) => receipt.connection_id === subjectId && receipt.cause === "external_or_host_loss")
      .map((receipt) => receipt.phase),
    ["started", "completed"]
  );
});
