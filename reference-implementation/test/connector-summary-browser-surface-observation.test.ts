// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeDynamicBrowserSurfaceRuntimeSurfaces } from "../runtime/browser-surface/allocator-observation.ts";
import { readBrowserSurfaceRuntimeSurfaces } from "../runtime/browser-surface/health-summary-adapter.ts";
import type { BrowserSurfaceRuntimeInventorySnapshot, BrowserSurfaceRuntimeManagement } from "../runtime/controller.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  type ConnectorSummary,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
} from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

// `ControllerLike` is module-private in ref-control.ts; redeclared here
// matching the shape listConnectorSummaries actually reads, plus the
// forbidden-mutation methods this test's fake controller must expose (and
// prove are never called).
interface TestController {
  acquireLease: () => void;
  acquireSurfaceLease: () => void;
  createSurface: () => void;
  ensureSurface: () => void;
  getBrowserSurfaceRuntimeAllocatorScopeId: () => string;
  getBrowserSurfaceRuntimeManagement: (connectorId: string) => BrowserSurfaceRuntimeManagement;
  observeBrowserSurfaceRuntimeInventory: () => Promise<BrowserSurfaceRuntimeInventorySnapshot>;
  restartSurface: () => void;
  stopSurface: () => void;
}

const OWNER_SUBJECT_ID = "owner_local";
const CONNECTORS = ["heb", "reddit"];
const NOW = "2026-07-16T12:00:00.000Z";
const OVER_CAP_SURFACE_IDS = /at most 25 surface ids/;

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-observation-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      invalidateConnectorSummariesCache();
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnector(connectorId: string): void {
  const manifest = {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"] }],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

async function seedBrowserCollectorConnection(connectorId: string): Promise<void> {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: `${connectorId}:primary`,
    createdAt: NOW,
    displayName: connectorId,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { kind: "browser_collector", profile: `${connectorId}:primary` },
    sourceBindingKey: `${connectorId}:browser`,
    sourceKind: "browser_collector",
    status: "active",
    updatedAt: NOW,
  });
}

interface CallCounters {
  acquireLease: number;
  acquireSurfaceLease: number;
  createSurface: number;
  ensureSurface: number;
  observe: number;
  observedAt: string[];
  restartSurface: number;
  stopSurface: number;
}

function observedAtFor(call: number): string {
  return new Date(Date.now() + call).toISOString();
}

function nonMutatingDynamicController(calls: CallCounters): TestController {
  const forbiddenOperation = (name: keyof CallCounters) => () => {
    (calls[name] as number) += 1;
    throw new Error(`health read must not call ${name}`);
  };
  return {
    acquireLease: forbiddenOperation("acquireLease"),
    acquireSurfaceLease: forbiddenOperation("acquireSurfaceLease"),
    createSurface: forbiddenOperation("createSurface"),
    ensureSurface: forbiddenOperation("ensureSurface"),
    getBrowserSurfaceRuntimeAllocatorScopeId: () => "summary-observation-test",
    getBrowserSurfaceRuntimeManagement: () => ({ managed: true, surface_mode: "dynamic-managed" }),
    async observeBrowserSurfaceRuntimeInventory() {
      calls.observe += 1;
      const observed_at = observedAtFor(calls.observe);
      calls.observedAt.push(observed_at);
      if (calls.observe > 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        allocator_observation: {
          expires_at: new Date(Date.now() + 35).toISOString(),
          observed_at,
          status: "available",
        },
        surfaces: [],
      };
    },
    restartSurface: forbiddenOperation("restartSurface"),
    stopSurface: forbiddenOperation("stopSurface"),
  };
}

function allocatorObservedAt(summary: ConnectorSummary): string | undefined {
  return summary.connection_health.ephemeral_browser_runtime?.allocator_observation?.observed_at;
}

// Under the reconcile-active-summary-evidence contract (design.md "Central
// consumer and cache boundary"), the connector-summaries value cache is
// removed entirely — only in-flight promise coalescing remains. A dynamic
// allocator inventory observation is fetched fresh by
// `loadConnectorSummaryProjectionDeps` on EVERY `listConnectorSummaries`
// call (it has no cache of its own; it was only ever deduped by the now-
// removed outer value cache), so two sequential calls now genuinely
// re-observe — that re-synthesis is exactly what "no pre-repair verdict can
// bypass the barrier" requires. Two CONCURRENT calls still coalesce onto
// one shared in-flight promise, which this test also proves.
test(
  "one connector-summary refresh observes dynamic inventory once per call, concurrent callers coalesce, never a mutating side effect",
  withTmpDb(async () => {
    invalidateConnectorSummariesCache();
    for (const connectorId of CONNECTORS) {
      seedConnector(connectorId);
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await seedBrowserCollectorConnection(connectorId);
    }
    const calls = {
      acquireLease: 0,
      acquireSurfaceLease: 0,
      createSurface: 0,
      ensureSurface: 0,
      observe: 0,
      observedAt: [],
      restartSurface: 0,
      stopSurface: 0,
    };
    const controller = nonMutatingDynamicController(calls);

    const first = await listConnectorSummaries(controller);
    assert.deepEqual(
      first.map((summary) => summary.connector_id).sort((left, right) => left.localeCompare(right)),
      CONNECTORS
    );
    assert.equal(calls.observe, 1, "one full refresh shares one inventory observation across H-E-B and Reddit");

    const second = await listConnectorSummaries(controller);
    assert.equal(calls.observe, 2, "a second sequential call re-observes: no cached pre-repair verdict is served");
    const secondFirstConnector = second.find((s) => s.connector_id === CONNECTORS[0]);
    const firstFirstConnector = first.find((s) => s.connector_id === CONNECTORS[0]);
    assert.ok(secondFirstConnector && firstFirstConnector, "expected both seeded connectors to be present");
    assert.notEqual(
      allocatorObservedAt(secondFirstConnector),
      allocatorObservedAt(firstFirstConnector),
      "the re-observation is a genuinely fresh read, not a replayed value"
    );

    const [concurrentA, concurrentB] = await Promise.all([
      listConnectorSummaries(controller),
      listConnectorSummaries(controller),
    ]);
    assert.equal(calls.observe, 3, "two concurrent calls coalesce onto one shared in-flight observation");
    assert.deepEqual(concurrentA.map(allocatorObservedAt), concurrentB.map(allocatorObservedAt));

    assert.deepEqual(
      Object.fromEntries(Object.entries(calls).filter(([name]) => name !== "observe" && name !== "observedAt")),
      {
        acquireLease: 0,
        acquireSurfaceLease: 0,
        createSurface: 0,
        ensureSurface: 0,
        restartSurface: 0,
        stopSurface: 0,
      },
      "the health read has no allocator mutation or lease-acquisition side effect"
    );
  })
);

test("scoped runtime observation reads only requested surfaces and keeps missing and unknown ids explicit", async () => {
  const known = new Map(
    Array.from({ length: 25 }, (_, index) => [
      `surface_${index}`,
      {
        backend: "neko" as const,
        cdp_url: `http://neko/${index}`,
        connector_id: `connector_${index}`,
        created_at: NOW,
        health: "ready" as const,
        last_used_at: NOW,
        profile_key: `profile_${index}`,
        stream_base_url: `http://stream/${index}`,
        surface_id: `surface_${index}`,
      },
    ])
  );
  let listCalls = 0;
  const statusCalls: string[] = [];
  const allocator = {
    ensureSurface: () => Promise.reject(new Error("scoped observation must not allocate")),
    getSurfaceStatus(surfaceId: string) {
      statusCalls.push(surfaceId);
      if (surfaceId === "unknown_surface") {
        return Promise.reject(new Error("temporary allocator failure"));
      }
      return Promise.resolve(known.get(surfaceId) ?? null);
    },
    listSurfaces() {
      listCalls += 1;
      return Promise.reject(new Error("scoped observation must not list the global inventory"));
    },
    stopSurface: () => Promise.resolve(null),
  };

  const scopedObservation = (surfaceIds: readonly string[]) =>
    observeDynamicBrowserSurfaceRuntimeSurfaces({
      allocator,
      now: new Date(NOW),
      surface_ids: surfaceIds,
      ttl_ms: 1000,
    });
  const requestedCases = [[], ["surface_0"], [...known.keys()]] as const;
  const observations = await Promise.all(requestedCases.map(scopedObservation));
  for (const [caseIndex, requested] of requestedCases.entries()) {
    const observation = mustObservation(observations[caseIndex], `scope ${caseIndex} returned an observation`);
    assert.deepEqual(
      observation.surfaces,
      requested.flatMap((surfaceId) => {
        const surface = known.get(surfaceId);
        return surface ? [surface] : [];
      }),
      "scoped output matches a global inventory filtered to the requested ids"
    );
  }
  assert.equal(statusCalls.length, 26, "one bounded status call per known requested surface");

  const incomplete = await scopedObservation(["surface_0", "missing_surface", "unknown_surface"]);
  assert.deepEqual(incomplete.missing_surface_ids, ["missing_surface"]);
  assert.deepEqual(incomplete.unknown_surface_ids, ["unknown_surface"]);
  assert.equal(incomplete.allocator_observation?.status, "unavailable");
  assert.equal(listCalls, 0, "the scoped path never calls the global allocator inventory");
  await assert.rejects(
    () => scopedObservation(Array.from({ length: 26 }, (_, index) => `overflow_${index}`)),
    OVER_CAP_SURFACE_IDS
  );
});

test("scoped runtime adapter never falls back to the global controller observation", async () => {
  let globalCalls = 0;
  let scopedCalls = 0;
  const observation = mustObservation(
    await readBrowserSurfaceRuntimeSurfaces(
      {
        observeBrowserSurfaceRuntimeInventory: () => {
          globalCalls += 1;
          return Promise.reject(new Error("scoped runtime adapter must not call the global observation"));
        },
        observeBrowserSurfaceRuntimeSurfaces(surfaceIds: readonly string[]) {
          scopedCalls += 1;
          return Promise.resolve({
            allocator_observation: null,
            missing_surface_ids: surfaceIds,
            surfaces: [],
            unknown_surface_ids: [],
          });
        },
      },
      ["missing_surface"]
    ),
    "scoped controller observation is available"
  );
  assert.deepEqual(observation.missing_surface_ids, ["missing_surface"]);
  assert.equal(scopedCalls, 1);
  assert.equal(globalCalls, 0);
});

function mustObservation<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}
