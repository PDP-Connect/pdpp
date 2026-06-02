/**
 * Tests for the phantom-connection cleanup primitive.
 *
 * Proves the safety predicate (`evaluateInstance` / `planCleanup`) and the
 * revoke action (`applyRevoke`):
 *   - a fresh-DB phantom default-account row IS a candidate, and revoking it
 *     removes it from the dashboard projection AND from grant fan-in (fails
 *     closed) without re-materializing on the next read;
 *   - dry-run (plan only) mutates nothing;
 *   - EVERY predicate clause fails closed: data present, grant reference,
 *     credential, schedule, active run, device source instance, non-default
 *     provenance, non-deterministic id, and non-active status all SKIP the row.
 *
 * SQLite, in-process — the same harness shape as
 * `grant-fan-in-fail-closed-no-phantom.test.js`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, getDb, initDb } from '../../server/db.js';
import { registerConnector } from '../../server/auth.js';
import { listConnectorSummaries } from '../../server/ref-control.ts';
import { listActiveBindingsForGrant, resolveFanInBindings } from '../../server/connection-identity.js';
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../../server/owner-auth.ts';

import { applyRevoke, evaluateInstance, planCleanup } from './cleanup-phantom-connections.mjs';

const OWNER = OWNER_AUTH_DEFAULT_SUBJECT_ID;
const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/phantom-cleanup';
const STREAM = 'messages';

const listedManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Phantom Cleanup Connector',
  capabilities: { public_listing: { listed: true, status: 'test' } },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  ],
};

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-phantom-cleanup-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// Materialize a phantom default-account row exactly as the (now-removed)
// read-time fan-out did, then return its deterministic id.
function seedPhantom({ connectorId = CONNECTOR_ID, now = '2026-06-02T00:00:00.000Z' } = {}) {
  const store = createSqliteConnectorInstanceStore();
  const instance = store.ensureDefaultAccountConnection({
    ownerSubjectId: OWNER,
    connectorId,
    displayName: connectorId,
    now,
  });
  return instance.connectorInstanceId;
}

function getInstance(id) {
  return createSqliteConnectorInstanceStore().get(id);
}

test(
  'a fresh phantom default-account row is a candidate; revoke removes it from dashboard + grant fan-in and survives the next read',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    assert.equal(id, makeDefaultAccountConnectorInstanceId(OWNER, CONNECTOR_ID));

    // Pre-condition: phantom is an active connection visible in the projection.
    const before = await listConnectorSummaries();
    assert.equal(before.length, 1, 'phantom is visible as a connection before cleanup');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1, 'exactly one phantom candidate');
    assert.equal(plan.candidates[0].connector_instance_id, id);
    assert.equal(plan.skipped.length, 0);

    const revoked = applyRevoke(plan.candidates);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].status, 'revoked');

    // Removed from the owner connection projection.
    const after = await listConnectorSummaries();
    assert.equal(after.length, 0, 'revoked phantom no longer projects as a connection');

    // Grant fan-in fails closed.
    const active = await listActiveBindingsForGrant({ ownerSubjectId: OWNER, connectorId: CONNECTOR_ID });
    assert.deepEqual(active, [], 'no active binding after revoke');
    const { bindings } = await resolveFanInBindings({ ownerSubjectId: OWNER, connectorId: CONNECTOR_ID });
    assert.deepEqual(bindings, [], 'fan-in fails closed after revoke');

    // Durability: a subsequent dashboard read must NOT resurrect the row.
    const reread = await listConnectorSummaries();
    assert.equal(reread.length, 0, 'revoke survives the next read (no re-materialization)');
    assert.equal(getInstance(id).status, 'revoked', 'row stays revoked');
  }),
);

test(
  'dry-run (plan only) mutates nothing',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1);
    // Plan does not mutate.
    assert.equal(getInstance(id).status, 'active', 'planning left the row active');
    const summaries = await listConnectorSummaries();
    assert.equal(summaries.length, 1, 'dry-run leaves the connection visible');
  }),
);

test(
  'P4 fails closed: a default-account row with any record is skipped',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(CONNECTOR_ID, id, STREAM, 'r1', '{"id":"r1"}', '2026-06-02T00:00:00.000Z');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'row with data is not a candidate');
    assert.equal(plan.skipped.length, 1);
    assert.ok(
      plan.skipped[0].reasons.some((r) => r.startsWith('P4:records=')),
      `expected a P4 records reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'P5 fails closed: a default-account row referenced by a grant storage binding is skipped',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    getDb()
      .prepare(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'grant_phantom_ref',
        OWNER,
        'client_test',
        JSON.stringify({ connector_instance_id: id }),
        '{}',
        'snapshot',
        'active',
        '2026-06-02T00:00:00.000Z',
      );

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'grant-referenced row is not a candidate');
    assert.ok(
      plan.skipped[0].reasons.some((r) => r.startsWith('P5:grant-storage-binding=')),
      `expected a P5 grant reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'P6 fails closed: a default-account row with a schedule is skipped',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    getDb()
      .prepare(
        `INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, enabled, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(id, CONNECTOR_ID, 3600, 1, '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'scheduled row is not a candidate');
    assert.ok(
      plan.skipped[0].reasons.some((r) => r.startsWith('P6:schedule=')),
      `expected a P6 schedule reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'P6 fails closed: a default-account row with an active run is skipped',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    getDb()
      .prepare(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(id, CONNECTOR_ID, 'run_1', 'trace_1', 'scenario_1', '2026-06-02T00:00:00.000Z');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'active-run row is not a candidate');
    assert.ok(
      plan.skipped[0].reasons.some((r) => r.startsWith('P6:active-run=')),
      `expected a P6 active-run reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'P7 fails closed: a default-account row with a credential is skipped',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    getDb()
      .prepare(
        `INSERT INTO connector_instance_credentials(connector_instance_id, owner_subject_id, credential_kind, sealed_secret, status, captured_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(id, OWNER, 'app_password', 'sealed-not-a-real-secret', 'active', '2026-06-02T00:00:00.000Z');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'credentialed row is not a candidate');
    assert.ok(
      plan.skipped[0].reasons.some((r) => r.startsWith('P7:credential=')),
      `expected a P7 credential reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'P1 fails closed: a non-default-account (real account) connection is never a candidate',
  withDb(async () => {
    await registerConnector(listedManifest);
    const store = createSqliteConnectorInstanceStore();
    // An explicit (non-default) account connection: real binding key, not the
    // 'default' marker — the owner genuinely created this.
    const real = store.upsert({
      ownerSubjectId: OWNER,
      connectorId: CONNECTOR_ID,
      displayName: 'Real account',
      status: 'active',
      sourceKind: 'account',
      sourceBinding: { account: 'real-user@example.com' },
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    const { candidate, reasons } = evaluateInstance(getDb(), real);
    assert.equal(candidate, false, 'a real account connection is out of scope');
    assert.ok(reasons.includes('P1:not-default-account-provenance'));

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0);
  }),
);

test(
  'P3 fails closed: an already-revoked default-account row is left untouched',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    createSqliteConnectorInstanceStore().updateStatus(id, {
      status: 'revoked',
      updatedAt: '2026-06-02T00:00:00.000Z',
      revokedAt: '2026-06-02T00:00:00.000Z',
    });

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'revoked row is not re-processed');
    assert.ok(
      plan.skipped[0].reasons.some((r) => r === 'P3:status-revoked'),
      `expected a P3 status reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'multiple connectors: only the zero-evidence phantoms are revoked; data-bearing ones are spared',
  withDb(async () => {
    await registerConnector(listedManifest);
    const otherConnector = 'https://test.pdpp.dev/connectors/phantom-cleanup-2';
    await registerConnector({ ...listedManifest, connector_id: otherConnector });

    const phantomId = seedPhantom();
    const dataId = seedPhantom({ connectorId: otherConnector });
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(otherConnector, dataId, STREAM, 'r1', '{"id":"r1"}', '2026-06-02T00:00:00.000Z');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1, 'only the empty phantom is a candidate');
    assert.equal(plan.candidates[0].connector_instance_id, phantomId);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].connector_instance_id, dataId);

    applyRevoke(plan.candidates);
    assert.equal(getInstance(phantomId).status, 'revoked');
    assert.equal(getInstance(dataId).status, 'active', 'the data-bearing connection is spared');
  }),
);
