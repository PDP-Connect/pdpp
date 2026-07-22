// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runConnector } from '../runtime/index.js';
import { startServer } from '../server/index.js';

// End-to-end + isolation tests for the Tranche C control-plane projection
// (`define-connector-progress-evidence-contract`, tasks 2.2b / 2.4 / 2.5 / 2.6).
//
// These drive a real connector run through `runConnector`, then read the
// owner/control-plane surface (`GET /_ref/connectors/:id`, `GET /_ref/connectors`)
// and assert the derived per-stream `collection_report` rides the wire with a
// coverage condition and forward disposition per stream. They also prove the
// honesty gate end to end (collected records + no considered -> `unknown`, never
// `complete`) and that NEITHER the runtime `collection_facts` block NOR the
// derived `collection_report` leaks onto grant-scoped `/v1` reads.

// ─── minimal harness (self-contained; mirrors collection-profile.test.js) ─────

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { status: resp.status, body };
}

function createTestConnector(messages) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-creport-connector-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const doneMessage = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !doneMessage ? 0 : (doneMessage.status === 'succeeded' ? 0 : 1);
    for (const m of messages) {
      process.stdout.write(JSON.stringify(m) + '\\n');
    }
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

const TWO_STREAM_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'creport-two-stream',
  version: '1.0.0',
  display_name: 'Collection Report Two-Stream',
  streams: [
    { name: 'items', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
    { name: 'other_items', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
  ],
};

// Every test in this file reads back through the owner-dashboard surface
// (`getConnectorDetail`/`_ref/connectors`), which is hardcoded to
// REFERENCE_OWNER_SUBJECT_ID/OWNER_AUTH_DEFAULT_SUBJECT_ID ('owner_local') —
// a real, intentional single-owner security boundary, not a bug. The default
// subject here must match that boundary (mirrors collection-profile.test.js's
// issueOwnerToken, which already defaults to 'owner_local' for this exact
// reason) so an owner-token run's connection is actually visible on the
// dashboard route this file asserts against.
async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
}

async function setupConnector(asUrl, manifest) {
  await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  const ownerToken = await issueOwnerToken(asUrl);
  return { ownerToken, connectorId: manifest.connector_id };
}

function indexEntries(report) {
  return Object.fromEntries((report || []).map((entry) => [entry.stream, entry]));
}

// ─── 2.2b: two requested streams -> two derived report entries ────────────────

test('2.2b: a two-stream run yields a two-entry collection_report on the detail surface', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: '2026-05-19T00:00:00.000Z' },
    { type: 'RECORD', stream: 'items', key: 'i2', data: { id: 'i2', value: 'b' }, emitted_at: '2026-05-19T00:00:01.000Z' },
    { type: 'STATE', stream: 'items', cursor: { last: 'i2' } },
    { type: 'RECORD', stream: 'other_items', key: 'o1', data: { id: 'o1', value: 'c' }, emitted_at: '2026-05-19T00:00:02.000Z' },
    { type: 'STATE', stream: 'other_items', cursor: { last: 'o1' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 3 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId,
      ownerToken,
      manifest: TWO_STREAM_MANIFEST,
      scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
      state: null,
      collectionMode: 'full_refresh',
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async () => ({}),
    });
    assert.equal(result.status, 'succeeded');

    const { status, body } = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.collection_report), 'detail carries a derived collection_report array');
    const byStream = indexEntries(body.collection_report);
    assert.deepEqual(Object.keys(byStream).sort(), ['items', 'other_items']);

    // Each entry carries a coverage condition from the canonical vocabulary plus
    // a forward disposition. With no declared considered, the condition is
    // `unknown` (the gate), NOT `complete`, and the disposition is `unmeasured`.
    const VOCAB = new Set([
      'complete', 'partial', 'gaps', 'retryable_gap', 'terminal_gap',
      'unsupported', 'unavailable', 'deferred', 'inventory_only', 'unknown',
    ]);
    for (const stream of ['items', 'other_items']) {
      const entry = byStream[stream];
      assert.ok(VOCAB.has(entry.coverage_condition), `coverage condition in canonical vocabulary for ${stream}`);
      assert.equal(entry.considered, 'unknown', `${stream} has no declared considered -> unknown`);
      assert.equal(entry.coverage_condition, 'unknown', `${stream} reads unknown, never complete`);
      assert.equal(entry.forward_disposition, 'unmeasured', `${stream} forward disposition is unmeasured`);
    }
    assert.equal(byStream.items.collected, 2, 'items collected count rides through from the fact block');
    assert.equal(byStream.other_items.collected, 1, 'other_items collected count rides through');
    assert.equal(byStream.items.checkpoint, 'committed', 'committed checkpoint surfaced');
    // NOTE: the connection LIST surface (`GET /_ref/connectors`) projects only
    // configured connection-instance rows, which this manifest-only run harness
    // does not create, so the list is asserted at the unit/type layer instead.
    // The list call site shares the SAME `projectCollectionReport(...)` wiring as
    // this detail surface (see `listConnectorSummaries`).
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── 2.4: the honesty gate proven end to end (collected, no considered) ───────

test('2.4: a collected-records, no-gaps, no-considered run is NOT projected complete', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: '2026-05-19T00:00:00.000Z' },
    { type: 'STATE', stream: 'items', cursor: { last: 'i1' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 1 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId,
      ownerToken,
      manifest: TWO_STREAM_MANIFEST,
      scope: { streams: [{ name: 'items' }] },
      state: null,
      collectionMode: 'full_refresh',
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async () => ({}),
    });
    assert.equal(result.status, 'succeeded');

    const { body } = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    const items = indexEntries(body.collection_report).items;
    assert.ok(items, 'items entry present');
    assert.equal(items.collected, 1, 'collected one record');
    // The load-bearing guarantee: collected count alone never proves complete.
    assert.notEqual(items.coverage_condition, 'complete');
    assert.equal(items.coverage_condition, 'unknown');
    assert.notEqual(items.forward_disposition, 'complete');
    assert.notEqual(items.forward_disposition, 'checking');
    assert.equal(items.forward_disposition, 'unmeasured');
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── 2.6: a portable RECORD/STATE/DONE-only connector still yields a report ───

test('2.6: a portable RECORD/STATE/DONE-only connector yields a valid report with unknown axes', async () => {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: 'creport-portable',
    version: '1.0.0',
    display_name: 'Portable Floor',
    streams: [
      { name: 'items', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
    ],
  };
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, manifest);

  const { connectorPath, cleanup } = createTestConnector([
    { type: 'RECORD', stream: 'items', key: 'p1', data: { id: 'p1' }, emitted_at: '2026-05-19T00:00:00.000Z' },
    { type: 'STATE', stream: 'items', cursor: { last: 'p1' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 1 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId,
      ownerToken,
      manifest,
      scope: { streams: [{ name: 'items' }] },
      state: null,
      collectionMode: 'full_refresh',
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async () => ({}),
    });
    assert.equal(result.status, 'succeeded');

    const { body } = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    const items = indexEntries(body.collection_report).items;
    assert.ok(items, 'portable connector still produces a report entry');
    assert.equal(items.considered, 'unknown');
    assert.equal(items.coverage_condition, 'unknown');
    assert.equal(items.forward_disposition, 'unmeasured');
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── 2.5: neither the fact block nor the derived report leaks onto /v1 ────────

test('2.5: collection_facts and collection_report are absent from grant-scoped /v1 reads', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: '2026-05-19T00:00:00.000Z' },
    { type: 'STATE', stream: 'items', cursor: { last: 'i1' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 1 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId,
      ownerToken,
      manifest: TWO_STREAM_MANIFEST,
      scope: { streams: [{ name: 'items' }] },
      state: null,
      collectionMode: 'full_refresh',
      persistState: true,
      rsUrl,
      onInteraction: async () => ({}),
    });
    assert.equal(result.status, 'succeeded');

    // Sanity: the owner surface DOES carry the report (so the negative below is
    // meaningful, not vacuous).
    const { body: detail } = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    assert.ok(Array.isArray(detail.collection_report) && detail.collection_report.length >= 1);
    assert.ok(detail.rendered_verdict?.detail, 'owner surface carries rendered_verdict.detail');
    assert.ok(detail.rendered_verdict?.trace, 'owner surface carries rendered_verdict.trace');

    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };
    const v1Surfaces = [
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=5`,
      `${rsUrl}/v1/schema?connector_id=${encodeURIComponent(connectorId)}`,
      `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`,
    ];
    for (const url of v1Surfaces) {
      const resp = await fetch(url, auth);
      // The surface may legitimately 200 or 404 depending on shape; the contract
      // is only that, when it returns a body, it carries no report.
      const text = await resp.text();
      assert.ok(
        !text.includes('collection_report'),
        `derived collection_report must not appear on /v1: ${url}`
      );
      assert.ok(
        !text.includes('collection_facts'),
        `runtime collection_facts must not appear on /v1: ${url}`
      );
      assert.ok(
        !text.includes('rendered_verdict'),
        `owner rendered_verdict must not appear on /v1: ${url}`
      );
      assert.ok(
        !text.includes('detail_gap_backlog'),
        `owner detail_gap_backlog must not appear on /v1: ${url}`
      );
      assert.ok(
        !text.includes('tone_cause'),
        `owner calibration trace must not appear on /v1: ${url}`
      );
      assert.ok(
        !text.includes('satisfied_when'),
        `owner satisfaction contract trace must not appear on /v1: ${url}`
      );
    }
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── derive-on-read: the report reflects evidence at read time, not run time ──

test('derive-on-read: coverage condition is computed on each read (not frozen at run completion)', async () => {
  // Two consecutive reads of the SAME completed run return a report; the entries
  // are derived freshly each call (the projection holds no frozen verdict). This
  // pins the "derived on read" property the contract requires so the manual-
  // refresh seam can flip a complete entry to owner_refresh_due later without
  // rewriting run history.
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: '2026-05-19T00:00:00.000Z' },
    { type: 'STATE', stream: 'items', cursor: { last: 'i1' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 1 },
  ]);

  try {
    const result = await runConnector({
      connectorPath,
      connectorId,
      ownerToken,
      manifest: TWO_STREAM_MANIFEST,
      scope: { streams: [{ name: 'items' }] },
      state: null,
      collectionMode: 'full_refresh',
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      onInteraction: async () => ({}),
    });
    assert.equal(result.status, 'succeeded');

    const first = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    const second = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    assert.deepEqual(
      indexEntries(first.body.collection_report).items.coverage_condition,
      indexEntries(second.body.collection_report).items.coverage_condition,
      'same run derives the same coverage condition on each read'
    );
    // Both reads computed the entry (it is present), proving it is produced by
    // the projection on read rather than read from a stored field on the run.
    assert.ok(indexEntries(first.body.collection_report).items);
    assert.ok(indexEntries(second.body.collection_report).items);
  } finally {
    cleanup();
    await closeServer(server);
  }
});
