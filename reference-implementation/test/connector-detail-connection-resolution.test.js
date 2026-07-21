/**
 * `getConnectorDetail` connection-resolution tests.
 *
 * design.md "Central consumer and cache boundary": a connector-keyed
 * catalog detail (`GET /_ref/connectors/:connectorId`, no
 * `connectorInstanceId`) with zero or multiple visible connections must
 * omit connection health/counts rather than merging/summing sibling
 * evidence, and must expose a typed `connection_resolution` field instead
 * of silently picking (or blending) a connection.
 *
 * `getConnectorDetail` now resolves its connection using the same shared
 * `resolveUnambiguousConnectionForConnectorId` helper `getConnectorSummaryForRoute`
 * uses (exact instance id match first, connector_id fallback only when
 * exactly one connection exists — always exercised here via the
 * connector_id fallback branch, since this route only ever receives a
 * connector_id, never a connector_instance_id), and — when unambiguous —
 * routes connection_health/total_records/streams through the SAME
 * barrier-backed `projectConnectorSummaryForInstance` projection every other
 * owner-facing surface uses, instead of the old connector-wide
 * `getConnectorRecordProjection(connectorId)` (no instance id) merge.
 *
 * Home: this is a new cross-cutting behavior of `getConnectorDetail` itself
 * (not connector-summary-route projection, which
 * `ref-connectors-connection-projection.test.js` already owns, and not the
 * `ref.connectors.detail` operation envelope, which
 * `ref-connectors-detail-operation.test.js` already owns with a fully
 * mocked dependency) — a new file keeps this focused and mirrors the
 * seeding pattern `ref-connectors-connection-projection.test.js` already
 * established for the sibling `getConnectorSummaryForRoute` tests.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { getConnectorDetail } from '../server/ref-control.ts';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/detail-connection-resolution';
const WORK_INSTANCE_ID = 'cin_test_detail_resolution_work';
const PERSONAL_INSTANCE_ID = 'cin_test_detail_resolution_personal';
const NOW = '2026-05-20T12:00:00.000Z';

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-connector-detail-resolution-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function manifestStream(name) {
  return {
    name,
    semantics: 'mutable_state',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    primary_key: ['id'],
  };
}

function seedConnector() {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Detail Connection Resolution',
    capabilities: {
      public_listing: { listed: true, status: 'test' },
    },
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [manifestStream('messages'), manifestStream('files')],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function seedInstance({
  connectorInstanceId,
  displayName,
  sourceBindingKey,
  status = 'active',
}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId: 'owner_local',
    connectorId: CONNECTOR_ID,
    displayName,
    status,
    sourceKind: 'manual',
    sourceBindingKey,
    sourceBinding: { kind: 'manual', device: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedRecord({ connectorInstanceId, stream, key, data, emittedAt, version }) {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(CONNECTOR_ID, connectorInstanceId, stream, key, JSON.stringify(data), emittedAt, version);
  getDb()
    .prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(CONNECTOR_ID, connectorInstanceId, stream, key, version, JSON.stringify(data), emittedAt);
}

// ─── (a) exactly-one-connection: full detail, barrier-backed, not stale ──────

test('getConnectorDetail: exactly one connection resolves to full detail via the barrier-backed projection, reflecting a just-repaired evidence row', withTmpDb(async () => {
  seedConnector();
  await seedInstance({ connectorInstanceId: WORK_INSTANCE_ID, displayName: 'Work', sourceBindingKey: 'work' });
  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'msg_1',
    data: { id: 'msg_1', text: 'hello' },
    emittedAt: '2026-05-20T12:01:00.000Z',
    version: 1,
  });
  await rebuildRetainedSize();
  // Simulate a write landing after the last rebuild but before the next
  // reconcile pass: the connection's retained-size row is mid-flight dirty.
  // `getConnectorDetail` must still report the CURRENT canonical count (via
  // the barrier's reconcile-before-read), not a stale pre-repair snapshot —
  // proving it goes through `loadConnectorSummaryProjectionDeps`'s barrier,
  // not a cached/stale read.
  getDb()
    .prepare('UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = ?')
    .run(WORK_INSTANCE_ID);

  const detail = await getConnectorDetail(CONNECTOR_ID);

  assert.equal(detail.connection_resolution, 'resolved');
  assert.equal(detail.connection_id, WORK_INSTANCE_ID, 'connection_id is the resolved instance, not the connector id');
  assert.equal(detail.total_records, 1, 'reflects the just-repaired canonical count, not a stale/zero read');
  const messages = detail.streams.find((s) => s.name === 'messages');
  const files = detail.streams.find((s) => s.name === 'files');
  assert.ok(messages, 'messages stream present');
  assert.equal(messages.record_count, 1);
  assert.ok(files, 'files stream present');
  assert.equal(files.record_count, 0, 'declared stream with no records reads exact zero, not merged/omitted');
}));

// ─── ambiguous also covers "one active + one revoked" (revoked stays real) ───

test('getConnectorDetail: a connector_id shared by one active and one revoked connection is ambiguous (revoked rows remain real, owner-visible connections)', withTmpDb(async () => {
  seedConnector();
  await seedInstance({ connectorInstanceId: WORK_INSTANCE_ID, displayName: 'Work', sourceBindingKey: 'work' });
  await seedInstance({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    displayName: 'Personal',
    sourceBindingKey: 'personal',
    status: 'revoked',
  });
  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'work_msg',
    data: { id: 'work_msg', text: 'work' },
    emittedAt: '2026-05-20T12:01:00.000Z',
    version: 1,
  });
  await rebuildRetainedSize();

  // A revoked instance row still counts as a real, owner-visible connection
  // (`listConnectorInstanceRowsForDashboard` keeps it resolvable by its own
  // route id — see `reference connector summaries keep revoked connections
  // visible for owner manageability` in
  // ref-connectors-connection-projection.test.js) — so a bare connector_id
  // lookup with one active + one revoked connection is genuinely ambiguous,
  // not silently resolved to the active one.
  const detail = await getConnectorDetail(CONNECTOR_ID);

  assert.equal(detail.connection_resolution, 'ambiguous');
  // Per-connection evidence is omitted, never a fabricated zero:
  // `total_records`/`connection_health` read `null` — a real count claim
  // (0) would be just as dishonest as summing/merging siblings would have
  // been. Declared stream NAMES are connector-level catalog facts owned by
  // the registered manifest, not per-connection evidence, so they still
  // appear — each with its own per-connection `record_count`/`last_updated`
  // honestly `null`, the same unobserved shape a resolved connection's
  // never-observed stream uses.
  assert.equal(detail.total_records, null, 'ambiguous omits total_records entirely rather than presenting either connection\'s count as authoritative');
  assert.equal(detail.connection_health, null, 'ambiguous omits connection_health entirely');
  assert.equal(detail.next_action, null, 'ambiguous connector detail must not invent a connection-scoped repair action');
  assert.equal(detail.rendered_verdict, null, 'ambiguous connector detail must not select either sibling\'s verdict');
  assert.deepEqual(
    detail.streams.map((s) => s.name).sort(),
    ['files', 'messages'],
    'ambiguous still surfaces the manifest\'s declared stream names — a connector-level catalog fact, not per-connection evidence',
  );
  assert.ok(detail.streams.every((s) => s.record_count === null), 'every stream\'s per-connection record_count is honestly null, not merged/summed/zeroed');
}));

// ─── (b) zero connections: unresolved, evidence omitted not fabricated ───────

test('getConnectorDetail: zero connections resolves to connection_resolution "unresolved" with connection health/counts omitted, not fabricated', withTmpDb(async () => {
  seedConnector();

  const detail = await getConnectorDetail(CONNECTOR_ID);

  assert.equal(detail.connection_resolution, 'unresolved');
  assert.equal(detail.total_records, null, 'unresolved omits total_records — 0 would be a real (false) count claim');
  assert.equal(detail.connection_health, null, 'unresolved omits connection_health entirely, not a synthesized unknown snapshot');
  assert.equal(detail.next_action, null, 'unresolved connector detail has no connection-scoped repair target');
  assert.equal(detail.rendered_verdict, null, 'unresolved connector detail has no connection-scoped verdict');
  // Declared stream names are a connector-level catalog fact (owned by the
  // registered manifest), knowable with zero connections — distinct from
  // the per-connection record_count/last_updated facts, which stay null.
  assert.deepEqual(
    detail.streams.map((s) => s.name).sort(),
    ['files', 'messages'],
    'unresolved still surfaces the manifest\'s declared stream names',
  );
  assert.ok(detail.streams.every((s) => s.record_count === null), 'every stream\'s per-connection record_count is honestly null, not a fabricated zero');
  // Still a real detail object for a registered connector — never a 404.
  assert.equal(detail.object, 'ref_connector_detail');
  assert.equal(detail.connector_id, CONNECTOR_ID);
}));

// ─── (c) two connections for the same connector_id: ambiguous, no merge ──────

test('getConnectorDetail: two connections for the same connector_id resolves to "ambiguous" with total_records omitted, never summed or either sibling\'s count', withTmpDb(async () => {
  seedConnector();
  await seedInstance({ connectorInstanceId: WORK_INSTANCE_ID, displayName: 'Work', sourceBindingKey: 'work' });
  await seedInstance({ connectorInstanceId: PERSONAL_INSTANCE_ID, displayName: 'Personal', sourceBindingKey: 'personal' });

  // Seed 3 records on WORK and 5 on PERSONAL — distinct, known counts.
  // `record_changes`' primary key is (connector_instance_id, stream,
  // version), so each record within one connection/stream needs its own
  // version.
  for (let i = 0; i < 3; i += 1) {
    seedRecord({
      connectorInstanceId: WORK_INSTANCE_ID,
      stream: 'messages',
      key: `work_msg_${i}`,
      data: { id: `work_msg_${i}` },
      emittedAt: `2026-05-20T12:0${i}:00.000Z`,
      version: i + 1,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    seedRecord({
      connectorInstanceId: PERSONAL_INSTANCE_ID,
      stream: 'messages',
      key: `personal_msg_${i}`,
      data: { id: `personal_msg_${i}` },
      emittedAt: `2026-05-20T13:0${i}:00.000Z`,
      version: i + 1,
    });
  }
  await rebuildRetainedSize();

  const detail = await getConnectorDetail(CONNECTOR_ID);

  assert.equal(detail.connection_resolution, 'ambiguous');
  // The crux of the fix: NOT the sum (8), NOT either sibling's real count
  // (3 or 5) presented as authoritative, and NOT a fabricated 0 either —
  // `null` (omitted) is the only honest value here.
  assert.notEqual(detail.total_records, 8, 'must not sum sibling connections\' records');
  assert.notEqual(detail.total_records, 3, 'must not present one sibling\'s count as authoritative');
  assert.notEqual(detail.total_records, 5, 'must not present the other sibling\'s count as authoritative');
  assert.equal(detail.total_records, null, 'ambiguous omits total_records — a fabricated 0 is still a false count claim, not an honest omission');
  // Declared stream names are a connector-level catalog fact, not
  // per-connection evidence — they still surface, but neither sibling's
  // real per-connection record_count (3 or 5) is presented as authoritative.
  assert.deepEqual(
    detail.streams.map((s) => s.name).sort(),
    ['files', 'messages'],
    'ambiguous still surfaces the manifest\'s declared stream names',
  );
  assert.ok(detail.streams.every((s) => s.record_count === null), 'neither sibling\'s real record_count (3 or 5) is presented as authoritative');
  assert.equal(detail.object, 'ref_connector_detail');
}));

test('getConnectorDetail: unresolved/ambiguous still throws not_found only for a truly unregistered connector', withTmpDb(async () => {
  seedConnector();

  await assert.rejects(
    getConnectorDetail('https://test.pdpp.dev/connectors/does-not-exist'),
    (err) => {
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
}));
