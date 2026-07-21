// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { invalidateConnectorSummariesCache, listConnectorSummaries } from '../server/ref-control.ts';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const OWNER_SUBJECT_ID = 'owner_local';
const CONNECTORS = ['heb', 'reddit'];
const NOW = '2026-07-16T12:00:00.000Z';

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-observation-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      invalidateConnectorSummariesCache();
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedConnector(connectorId) {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: connectorId,
    capabilities: { public_listing: { listed: true, status: 'test' } },
    streams: [{ name: 'items', primary_key: ['id'] }],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify(manifest), NOW);
}

async function seedBrowserCollectorConnection(connectorId) {
  await createSqliteConnectorInstanceStore().upsert({
    connectorInstanceId: `${connectorId}:primary`,
    ownerSubjectId: OWNER_SUBJECT_ID,
    connectorId,
    displayName: connectorId,
    status: 'active',
    sourceKind: 'browser_collector',
    sourceBindingKey: `${connectorId}:browser`,
    sourceBinding: { kind: 'browser_collector', profile: `${connectorId}:primary` },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function observedAtFor(call) {
  return new Date(Date.now() + call).toISOString();
}

function nonMutatingDynamicController(calls) {
  const forbiddenOperation = (name) => () => {
    calls[name] += 1;
    throw new Error(`health read must not call ${name}`);
  };
  return {
    getBrowserSurfaceRuntimeManagement: () => ({ managed: true, surface_mode: 'dynamic-managed' }),
    getBrowserSurfaceRuntimeAllocatorScopeId: () => 'summary-observation-test',
    async observeBrowserSurfaceRuntimeInventory() {
      calls.observe += 1;
      const observed_at = observedAtFor(calls.observe);
      calls.observedAt.push(observed_at);
      if (calls.observe > 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        allocator_observation: {
          status: 'available',
          observed_at,
          expires_at: new Date(Date.now() + 35).toISOString(),
        },
        surfaces: [],
      };
    },
    ensureSurface: forbiddenOperation('ensureSurface'),
    stopSurface: forbiddenOperation('stopSurface'),
    acquireLease: forbiddenOperation('acquireLease'),
    acquireSurfaceLease: forbiddenOperation('acquireSurfaceLease'),
    createSurface: forbiddenOperation('createSurface'),
    restartSurface: forbiddenOperation('restartSurface'),
  };
}

function allocatorObservedAt(summary) {
  return summary.connection_health.ephemeral_browser_runtime.allocator_observation.observed_at;
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
  'one connector-summary refresh observes dynamic inventory once per call, concurrent callers coalesce, never a mutating side effect',
  withTmpDb(async () => {
    invalidateConnectorSummariesCache();
    for (const connectorId of CONNECTORS) {
      seedConnector(connectorId);
      await seedBrowserCollectorConnection(connectorId);
    }
    const calls = {
      observe: 0,
      observedAt: [],
      ensureSurface: 0,
      stopSurface: 0,
      acquireLease: 0,
      acquireSurfaceLease: 0,
      createSurface: 0,
      restartSurface: 0,
    };
    const controller = nonMutatingDynamicController(calls);

    const first = await listConnectorSummaries(controller);
    assert.deepEqual(first.map((summary) => summary.connector_id).sort(), CONNECTORS);
    assert.equal(calls.observe, 1, 'one full refresh shares one inventory observation across H-E-B and Reddit');

    const second = await listConnectorSummaries(controller);
    assert.equal(calls.observe, 2, 'a second sequential call re-observes: no cached pre-repair verdict is served');
    assert.notEqual(
      allocatorObservedAt(second.find((s) => s.connector_id === CONNECTORS[0])),
      allocatorObservedAt(first.find((s) => s.connector_id === CONNECTORS[0])),
      'the re-observation is a genuinely fresh read, not a replayed value',
    );

    const [concurrentA, concurrentB] = await Promise.all([
      listConnectorSummaries(controller),
      listConnectorSummaries(controller),
    ]);
    assert.equal(calls.observe, 3, 'two concurrent calls coalesce onto one shared in-flight observation');
    assert.deepEqual(concurrentA.map(allocatorObservedAt), concurrentB.map(allocatorObservedAt));

    assert.deepEqual(
      Object.fromEntries(Object.entries(calls).filter(([name]) => name !== 'observe' && name !== 'observedAt')),
      {
        ensureSurface: 0,
        stopSurface: 0,
        acquireLease: 0,
        acquireSurfaceLease: 0,
        createSurface: 0,
        restartSurface: 0,
      },
      'the health read has no allocator mutation or lease-acquisition side effect'
    );
  })
);
