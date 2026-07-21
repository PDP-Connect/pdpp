/**
 * Route-wiring test for the optional connection selector on
 * `GET /_ref/connectors` (mountRefConnectorsList).
 *
 * Spec: openspec/changes/scope-ref-connectors-summary-to-one-connection/
 *       specs/reference-implementation-architecture/spec.md
 *
 * Records subpages resolve one connection from the route param. Before this
 * change they called the all-connector summary projection and filtered the
 * result in the browser, so opening one connection's records page ran the
 * per-connection fan-out for EVERY configured connection (~8N reads). With the
 * selector, the route resolves and projects only the requested connection.
 *
 * What this pins
 * --------------
 * 1. A scoped request (`?connection=<id>`) calls `getConnectorSummaryForRoute`
 *    and NOT the all-connector `listConnectorSummaries` — the records-subpage
 *    hot path no longer hydrates every connector.
 * 2. The scoped envelope is the same `{object: 'list', data}` shape with a
 *    single matching item.
 * 3. A scoped request that resolves nothing returns an empty list, not a
 *    silently-unscoped full list.
 * 4. An unscoped request (no selector) still calls `listConnectorSummaries`
 *    and returns every connection, unchanged.
 * 5. The route itself never calls `reconcileDirtyConnectorSummaryEvidence`
 *    directly (Sol P1.2): that was a genuinely redundant, always-UNSCOPED
 *    second barrier pass ahead of a caller (`listConnectorSummaries`/
 *    `getConnectorSummaryForRoute`) that already runs its own barrier
 *    internally, scoped to the resolved connection when one is known —
 *    defeating the whole point of the connection selector's scoping.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountRefConnectorsList } from '../server/routes/ref-connectors.ts';

function summaryItem(connectorId, connectionId = connectorId) {
  return {
    connection_id: connectionId,
    connection_health: null,
    connector_id: connectorId,
    connector_instance_id: connectionId,
    display_name: connectorId,
    manifest_version: '1.0.0',
    streams: [],
    total_records: 0,
    freshness: { status: 'unknown' },
    refresh_policy: null,
    schedule: null,
    last_run: null,
    last_successful_run: null,
  };
}

// Minimal Express-shaped harness that captures the GET handler registered by
// mountRefConnectorsList and invokes it with a query and a response recorder.
// The owner-session middleware is a no-op here; auth posture is covered
// elsewhere. The ctx spies record which projection dependency the route used.
function buildHarness({ allConnections, summaryForRoute }) {
  const calls = {
    getConnectorSummaryForRoute: [],
    listConnectorSummaries: 0,
    reconcileDirtyConnectorSummaryEvidence: 0,
  };
  const ctx = {
    requireOwnerSession: (_req, _res, next) => (typeof next === 'function' ? next() : undefined),
    // Mirror the production helper: take the first string value, ignore arrays
    // and non-strings, and treat empty as absent.
    resolveSingleConnectorIdQueryValue(raw) {
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
    listConnectorSummaries() {
      calls.listConnectorSummaries += 1;
      return allConnections;
    },
    getConnectorSummaryForRoute(routeId) {
      calls.getConnectorSummaryForRoute.push(routeId);
      return summaryForRoute(routeId);
    },
    reconcileDirtyConnectorSummaryEvidence() {
      calls.reconcileDirtyConnectorSummaryEvidence += 1;
    },
    handleError(_res, err) {
      throw err;
    },
  };

  let handler = null;
  const app = {
    get(_path, ..._handlers) {
      handler = _handlers[_handlers.length - 1];
      return app;
    },
  };
  mountRefConnectorsList(app, ctx);

  return {
    calls,
    async invoke(query = {}) {
      const recorder = { body: undefined };
      const res = {
        json(body) {
          recorder.body = body;
          return body;
        },
      };
      await handler({ query }, res);
      return recorder.body;
    },
  };
}

test('scoped request projects only the resolved connection and skips the all-connector list', async () => {
  const all = [summaryItem('gmail', 'conn-work'), summaryItem('github', 'conn-gh')];
  const harness = buildHarness({
    allConnections: all,
    summaryForRoute: (routeId) => all.find((s) => s.connection_id === routeId) ?? null,
  });

  const envelope = await harness.invoke({ connection: 'conn-work' });

  // The whole point: the records-subpage hot path resolved ONE connection and
  // never ran the all-connector fan-out.
  assert.equal(harness.calls.listConnectorSummaries, 0, 'scoped request must NOT call the all-connector summarizer');
  assert.equal(
    harness.calls.reconcileDirtyConnectorSummaryEvidence,
    0,
    'the route no longer owns a redundant barrier call (Sol P1.2) — listConnectorSummaries/getConnectorSummaryForRoute each run their own barrier internally',
  );
  assert.deepEqual(harness.calls.getConnectorSummaryForRoute, ['conn-work']);

  assert.equal(envelope.object, 'list');
  assert.equal(envelope.data.length, 1, 'scoped request returns a 0-or-1 list');
  assert.equal(envelope.data[0].connection_id, 'conn-work');
});

test('scoped request that resolves nothing returns an empty list, not the full list', async () => {
  const all = [summaryItem('gmail', 'conn-work')];
  const harness = buildHarness({
    allConnections: all,
    summaryForRoute: () => null,
  });

  const envelope = await harness.invoke({ connection: 'does-not-exist' });

  assert.equal(harness.calls.listConnectorSummaries, 0, 'an empty resolution must not fall back to the full list');
  assert.equal(
    harness.calls.reconcileDirtyConnectorSummaryEvidence,
    0,
    'the route no longer owns a redundant barrier call (Sol P1.2) — listConnectorSummaries/getConnectorSummaryForRoute each run their own barrier internally',
  );
  assert.deepEqual(envelope, { object: 'list', data: [] });
});

test('unscoped request lists every connection exactly as before', async () => {
  const all = [summaryItem('gmail', 'conn-work'), summaryItem('github', 'conn-gh')];
  const harness = buildHarness({
    allConnections: all,
    summaryForRoute: () => assert.fail('unscoped request must not resolve a single connection'),
  });

  const envelope = await harness.invoke({});

  assert.equal(harness.calls.listConnectorSummaries, 1, 'unscoped request uses the all-connector summarizer');
  assert.equal(
    harness.calls.reconcileDirtyConnectorSummaryEvidence,
    0,
    'the route no longer owns a redundant barrier call (Sol P1.2) — listConnectorSummaries/getConnectorSummaryForRoute each run their own barrier internally',
  );
  assert.equal(harness.calls.getConnectorSummaryForRoute.length, 0);
  assert.equal(envelope.object, 'list');
  assert.deepEqual(
    envelope.data.map((item) => item.connection_id),
    ['conn-work', 'conn-gh'],
  );
});

test('empty/blank selector is treated as absent (full list), never as a connector named ""', async () => {
  const all = [summaryItem('gmail', 'conn-work')];
  const harness = buildHarness({
    allConnections: all,
    summaryForRoute: () => assert.fail('blank selector must not resolve a single connection'),
  });

  const envelope = await harness.invoke({ connection: '' });

  assert.equal(harness.calls.listConnectorSummaries, 1, 'blank selector falls through to the full list');
  assert.equal(
    harness.calls.reconcileDirtyConnectorSummaryEvidence,
    0,
    'the route no longer owns a redundant barrier call (Sol P1.2) — listConnectorSummaries/getConnectorSummaryForRoute each run their own barrier internally',
  );
  assert.equal(harness.calls.getConnectorSummaryForRoute.length, 0);
  assert.equal(envelope.data.length, 1);
});
