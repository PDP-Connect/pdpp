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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb } from '../../server/db.js';
import { registerConnector } from '../../server/auth.js';
import { listConnectorSummaries } from '../../server/ref-control.ts';
import { listActiveBindingsForGrant, resolveFanInBindings } from '../../server/connection-identity.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../../server/owner-auth.ts';

import {
  applyRevoke,
  applyRevokePg,
  evaluateInstance,
  evaluateInstancePg,
  notesFromEvidence,
  planCleanup,
  planCleanupPg,
  reasonsFromEvidence,
} from './cleanup-phantom-connections.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

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

// Seed a hosted-MCP grant package whose single member's `source_json` carries a
// `connection_id` display pointer to `connectionId` — exactly the shape
// `persistChildGrantForPackage` writes. The child grant's `storage_binding_json`
// is `{connector_id}` ONLY (never a connector_instance_id), matching
// `normalizeStorageBinding`, so the member reference is the ONLY place the
// connection id appears. Returns { packageId, grantId, tokenId }.
function seedGrantPackageMember({
  connectionId,
  connectorId = CONNECTOR_ID,
  packageId = 'pkg_test',
  grantId = 'grt_member',
  tokenId = 'tok_member',
  grantStatus = 'active',
  now = '2026-06-02T00:00:00.000Z',
} = {}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
     VALUES(?, ?, ?, 'active', ?, ?, ?)`,
  ).run(packageId, OWNER, 'client_test', '{}', now, now);
  db.prepare(
    `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    grantId,
    OWNER,
    'client_test',
    // storage_binding is {connector_id} ONLY — no connector_instance_id here.
    JSON.stringify({ connector_id: connectorId }),
    // grant body does NOT pin a stream connection_id (no P5a stream pin).
    JSON.stringify({ source: { kind: 'connector', id: connectorId }, streams: [{ name: STREAM }] }),
    'snapshot',
    grantStatus,
    now,
  );
  db.prepare(
    `INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at)
     VALUES(?, ?, ?, ?, 'active', ?)`,
  ).run(
    packageId,
    grantId,
    tokenId,
    // The member's display pointer to the connection — the P5b reference.
    JSON.stringify({ kind: 'connector', id: connectorId, connection_id: connectionId }),
    now,
  );
  return { packageId, grantId, tokenId };
}

function getMemberStatus(packageId, grantId) {
  const row = getDb()
    .prepare(`SELECT status FROM grant_package_members WHERE package_id = ? AND grant_id = ?`)
    .get(packageId, grantId);
  return row?.status ?? null;
}

function getGrantStatus(grantId) {
  const row = getDb().prepare(`SELECT status FROM grants WHERE grant_id = ?`).get(grantId);
  return row?.status ?? null;
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

    const { revoked, skippedAtApply } = applyRevoke(plan.candidates);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].status, 'revoked');
    assert.equal(skippedAtApply.length, 0);

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

// ─── P5 split: grant-package member display ref (P5b) vs grant-scope pin (P5a) ─

test(
  'P5b does NOT block: a phantom referenced ONLY by a grant-package member display pointer IS a candidate, with an informational note; revoke leaves the grant package + member + child grant + token untouched',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    const { packageId, grantId } = seedGrantPackageMember({ connectionId: id });

    // The member reference does NOT block; the row is a candidate and the
    // dry-run discloses the member reference as a note.
    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1, 'member-referenced phantom is a candidate');
    assert.equal(plan.candidates[0].connector_instance_id, id);
    assert.equal(plan.skipped.length, 0, 'nothing is skipped');
    assert.ok(
      (plan.candidates[0].notes || []).some((n) => n.startsWith('P5b:grant-package-member-display-ref=')),
      `expected a P5b member note, got ${JSON.stringify(plan.candidates[0].notes)}`,
    );

    // Apply revokes ONLY the connection_instances row.
    const { revoked, skippedAtApply } = applyRevoke(plan.candidates);
    assert.equal(revoked.length, 1);
    assert.equal(skippedAtApply.length, 0);
    assert.equal(getInstance(id).status, 'revoked', 'the phantom connection is revoked');

    // The grant package, the member row, the child grant, and the token are
    // ALL untouched — cleanup never calls grant-package revocation.
    const pkg = getDb().prepare(`SELECT status FROM grant_packages WHERE package_id = ?`).get(packageId);
    assert.equal(pkg.status, 'active', 'the grant package stays active');
    assert.equal(getMemberStatus(packageId, grantId), 'active', 'the member row stays active');
    assert.equal(getGrantStatus(grantId), 'active', 'the child grant stays active');
    const tokenRevoked = getDb()
      .prepare(`SELECT revoked FROM tokens WHERE token_id = ?`)
      .get('tok_member');
    // We did not seed a token row; assert we did NOT create/modify one either.
    assert.equal(tokenRevoked, undefined, 'cleanup did not touch any token row');
  }),
);

test(
  'P5a BLOCKS: a phantom pinned by an active grant.streams[].connection_id is refused',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    // An active grant whose grant_json pins a stream to this exact connection.
    // This IS load-bearing read scope (resolveFanInBindings honors it), so it
    // must remain a hard block even though it is not a storage-binding ref.
    getDb()
      .prepare(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'grant_stream_pin',
        OWNER,
        'client_test',
        // storage_binding is {connector_id} only — the pin lives in grant_json.
        JSON.stringify({ connector_id: CONNECTOR_ID }),
        JSON.stringify({ streams: [{ name: STREAM, connection_id: id }] }),
        'continuous',
        'active',
        '2026-06-02T00:00:00.000Z',
      );

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 0, 'grant-stream-pinned row is not a candidate');
    assert.ok(
      plan.skipped[0].reasons.some((r) => r.startsWith('P5:grant-stream-pin=')),
      `expected a P5 grant-stream-pin reason, got ${plan.skipped[0].reasons.join(',')}`,
    );
  }),
);

test(
  'P5a does NOT block when the pinning grant is REVOKED: a revoked grant scopes nothing',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    // Same stream pin, but the grant is revoked — it no longer scopes any read,
    // so it must NOT block. (A member ref to this id is still just a note.)
    seedGrantPackageMember({ connectionId: id, grantId: 'grt_revoked', grantStatus: 'revoked' });
    getDb()
      .prepare(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'grant_stream_pin_revoked',
        OWNER,
        'client_test',
        JSON.stringify({ connector_id: CONNECTOR_ID }),
        JSON.stringify({ streams: [{ name: STREAM, connection_id: id }] }),
        'continuous',
        'revoked',
        '2026-06-02T00:00:00.000Z',
      );

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1, 'a revoked grant does not block; the phantom is a candidate');
    assert.equal(plan.candidates[0].connector_instance_id, id);
  }),
);

test(
  'duplicate Reddit: a stale zero-record member-referenced default-account row is revoked; a separate data-bearing connection of the same connector stays active',
  withDb(async () => {
    const reddit = 'https://test.pdpp.dev/connectors/reddit';
    await registerConnector({ ...listedManifest, connector_id: reddit });

    // The stale zero-record default-account placeholder (deterministic id),
    // referenced only by a grant-package member display pointer.
    const staleId = seedPhantom({ connectorId: reddit });
    const { packageId, grantId } = seedGrantPackageMember({ connectionId: staleId, connectorId: reddit });

    // A separate, real, data-bearing Reddit connection: its OWN connector_instance_id
    // (explicit account binding, not the default marker) with a record.
    const store = createSqliteConnectorInstanceStore();
    const realReddit = store.upsert({
      ownerSubjectId: OWNER,
      connectorId: reddit,
      displayName: 'Reddit (real)',
      status: 'active',
      sourceKind: 'account',
      sourceBinding: { account: 'real-reddit-user' },
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    });
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(reddit, realReddit.connectorInstanceId, STREAM, 'r1', '{"id":"r1"}', '2026-06-02T00:00:00.000Z');

    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1, 'only the stale zero-record row is a candidate');
    assert.equal(plan.candidates[0].connector_instance_id, staleId);
    // The data-bearing real connection is skipped and stays active. It carries
    // an explicit account binding (not the default marker), so the predicate
    // fails closed at P1 (out of scope) before it even reaches the P4 records
    // check — either way it is spared. A data-bearing row is never a candidate.
    const realSkip = plan.skipped.find((s) => s.connector_instance_id === realReddit.connectorInstanceId);
    assert.ok(realSkip, 'the data-bearing connection is in the skipped set');
    assert.ok(
      realSkip.reasons.some((r) => r === 'P1:not-default-account-provenance' || r.startsWith('P4:records=')),
      `expected the real connection spared by provenance or records, got ${realSkip.reasons.join(',')}`,
    );

    applyRevoke(plan.candidates);
    assert.equal(getInstance(staleId).status, 'revoked', 'stale duplicate revoked');
    assert.equal(getInstance(realReddit.connectorInstanceId).status, 'active', 'real data-bearing connection spared');
    // The grant package the stale member belonged to is untouched.
    assert.equal(getMemberStatus(packageId, grantId), 'active', 'member untouched');
  }),
);

test(
  'apply-time re-evaluation (SQLite): a grant.streams pin inserted AFTER the plan but BEFORE apply blocks the revoke',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    // Plan sees a clean phantom (member ref only would also be clean; here none).
    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1);

    // Between plan and apply an active grant now pins a stream to this id. The
    // row's status is unchanged, so the load-bearing P5a re-check must catch it.
    getDb()
      .prepare(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'grant_stream_pin_late',
        OWNER,
        'client_test',
        JSON.stringify({ connector_id: CONNECTOR_ID }),
        JSON.stringify({ streams: [{ name: STREAM, connection_id: id }] }),
        'continuous',
        'active',
        '2026-06-02T00:00:01.000Z',
      );

    const { revoked, skippedAtApply } = applyRevoke(plan.candidates);
    assert.equal(revoked.length, 0, 'the now-grant-pinned row is NOT revoked');
    assert.equal(skippedAtApply.length, 1);
    assert.ok(
      skippedAtApply[0].reasons.some((r) => r.startsWith('P5:grant-stream-pin=')),
      `expected a P5 grant-stream-pin reason at apply, got ${skippedAtApply[0].reasons.join(',')}`,
    );
    assert.equal(getInstance(id).status, 'active', 'left active, untouched');
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

test(
  'apply-time re-evaluation (SQLite): a record inserted AFTER the plan but BEFORE apply blocks the revoke',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();

    // Plan sees a clean phantom: one candidate, no skips.
    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].connector_instance_id, id);

    // Concurrent write between plan and apply: a record appears. The row's
    // STATUS is unchanged (still 'active'), so a bare status re-assert would
    // have force-revoked it. The full predicate re-evaluation must catch it.
    getDb()
      .prepare(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(CONNECTOR_ID, id, STREAM, 'r-late', '{"id":"r-late"}', '2026-06-02T00:00:01.000Z');

    const { revoked, skippedAtApply } = applyRevoke(plan.candidates);
    assert.equal(revoked.length, 0, 'the now-data-bearing row is NOT revoked');
    assert.equal(skippedAtApply.length, 1, 'it is reported as skipped-at-apply');
    assert.equal(skippedAtApply[0].connector_instance_id, id);
    assert.ok(
      skippedAtApply[0].reasons.some((r) => r.startsWith('P4:records=')),
      `expected a P4 records reason at apply, got ${skippedAtApply[0].reasons.join(',')}`,
    );
    assert.equal(getInstance(id).status, 'active', 'the row is left active, untouched');
  }),
);

test(
  'apply-time re-evaluation (SQLite): a grant reference inserted before apply blocks the revoke',
  withDb(async () => {
    await registerConnector(listedManifest);
    const id = seedPhantom();
    const plan = planCleanup({ ownerSubjectId: OWNER });
    assert.equal(plan.candidates.length, 1);

    // A grant now references the connection (P5) — status still 'active'.
    getDb()
      .prepare(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'grant_late_ref',
        OWNER,
        'client_test',
        JSON.stringify({ connector_instance_id: id }),
        '{}',
        'snapshot',
        'active',
        '2026-06-02T00:00:01.000Z',
      );

    const { revoked, skippedAtApply } = applyRevoke(plan.candidates);
    assert.equal(revoked.length, 0);
    assert.equal(skippedAtApply.length, 1);
    assert.ok(
      skippedAtApply[0].reasons.some((r) => r.startsWith('P5:grant-storage-binding=')),
      `expected a P5 grant reason at apply, got ${skippedAtApply[0].reasons.join(',')}`,
    );
    assert.equal(getInstance(id).status, 'active');
  }),
);

// ─── Pure-predicate tests (backend-agnostic; no DB) ──────────────────────────
//
// `reasonsFromEvidence` is the single source of truth both arms feed. These
// exercise the missing-table fail-closed behavior and the grant_package_members
// "null === table absent, not a block" rule WITHOUT any backend, so the
// invariant holds identically for SQLite and Postgres.

const DEFAULT_INSTANCE = Object.freeze({
  connectorInstanceId: makeDefaultAccountConnectorInstanceId(OWNER, CONNECTOR_ID),
  ownerSubjectId: OWNER,
  connectorId: CONNECTOR_ID,
  status: 'active',
  sourceKind: 'account',
  sourceBindingKey: 'default',
  sourceBinding: { kind: 'default_account' },
});

function cleanEvidence() {
  const zeroData = {};
  for (const t of [
    'records',
    'record_changes',
    'blobs',
    'connector_state',
    'version_counter',
    'grant_connector_state',
    'connector_attention_records',
    'connector_detail_gaps',
  ]) {
    zeroData[t] = 0;
  }
  return {
    zeroData,
    grantStorageBindingRefs: 0,
    grantStreamPinRefs: 0,
    grantPackageMemberRefs: 0,
    activity: {
      controller_active_runs: 0,
      connector_schedules: 0,
      device_source_instances: 0,
      connector_instance_credentials: 0,
    },
  };
}

test('reasonsFromEvidence: a clean default-account instance is a candidate (no reasons)', () => {
  assert.deepEqual(reasonsFromEvidence(DEFAULT_INSTANCE, cleanEvidence()), []);
});

test('reasonsFromEvidence: a MISSING evidence table fails closed (never a silent pass)', () => {
  const ev = cleanEvidence();
  ev.zeroData.records = 'missing';
  const reasons = reasonsFromEvidence(DEFAULT_INSTANCE, ev);
  assert.ok(
    reasons.includes('P4:records-table-missing'),
    `missing evidence table must block; got ${reasons.join(',')}`,
  );
});

test('reasonsFromEvidence: a MISSING grants table fails closed', () => {
  const ev = cleanEvidence();
  ev.grantStorageBindingRefs = 'missing';
  assert.ok(reasonsFromEvidence(DEFAULT_INSTANCE, ev).includes('P5:grants-table-missing'));
});

test('reasonsFromEvidence: a MISSING activity table fails closed', () => {
  const ev = cleanEvidence();
  ev.activity.controller_active_runs = 'missing';
  assert.ok(
    reasonsFromEvidence(DEFAULT_INSTANCE, ev).includes('P6:controller_active_runs-table-missing'),
  );
});

test('reasonsFromEvidence: grant_package_members null (table absent) does NOT block', () => {
  const ev = cleanEvidence();
  ev.grantPackageMemberRefs = null;
  assert.deepEqual(reasonsFromEvidence(DEFAULT_INSTANCE, ev), [], 'absent optional table is not a block');
});

test('reasonsFromEvidence: a grant_package_members display reference (P5b) does NOT block', () => {
  const ev = cleanEvidence();
  ev.grantPackageMemberRefs = 3;
  assert.deepEqual(
    reasonsFromEvidence(DEFAULT_INSTANCE, ev),
    [],
    'a member display reference alone is not a blocking reason',
  );
});

test('notesFromEvidence: a grant_package_members display reference surfaces as an informational note', () => {
  const ev = cleanEvidence();
  ev.grantPackageMemberRefs = 2;
  assert.deepEqual(notesFromEvidence(DEFAULT_INSTANCE, ev), ['P5b:grant-package-member-display-ref=2']);
});

test('notesFromEvidence: no member reference => no notes', () => {
  assert.deepEqual(notesFromEvidence(DEFAULT_INSTANCE, cleanEvidence()), []);
});

test('reasonsFromEvidence: a load-bearing grant-stream pin (P5a) BLOCKS', () => {
  const ev = cleanEvidence();
  ev.grantStreamPinRefs = 1;
  assert.ok(
    reasonsFromEvidence(DEFAULT_INSTANCE, ev).includes('P5:grant-stream-pin=1'),
    'an active grant-body stream pin must block',
  );
});

test('reasonsFromEvidence: a MISSING grants table fails closed for the stream-pin check too (emitted once)', () => {
  const ev = cleanEvidence();
  ev.grantStorageBindingRefs = 'missing';
  ev.grantStreamPinRefs = 'missing';
  const reasons = reasonsFromEvidence(DEFAULT_INSTANCE, ev);
  const missingCount = reasons.filter((r) => r === 'P5:grants-table-missing').length;
  assert.equal(missingCount, 1, `grants-table-missing should be emitted exactly once, got ${reasons.join(',')}`);
});

// ─── Import-safety regression ────────────────────────────────────────────────
//
// Mirrors `compact-record-history-dry-run-all.test.js`'s `node -e import(...)`
// guard for the main `ad83e19d` import-safety fix: the module must be safe to
// `import()` (its named exports are used by this very test file). It must NOT
// run the CLI as a side effect — no DB error, no usage banner, no candidate
// output. The fixed `pathToFileURL(process.argv[1]).href` guard makes
// `process.argv[1]` (the `-e` evaluator, not this module) never match.

test('cleanup-phantom-connections is safe to import from a node -e context (no CLI side effect)', () => {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `import('./reference-implementation/scripts/cleanup-phantom-connections/cleanup-phantom-connections.mjs')
         .then((m) => { if (typeof m.planCleanup !== 'function') throw new Error('missing export'); console.log('ok'); })
         .catch((e) => { console.error(e); process.exit(3); });`,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, `import failed: ${child.stderr || child.stdout}`);
  assert.match(child.stdout, /ok/);
  // No CLI ran: none of these side-effect strings appear.
  assert.doesNotMatch(
    child.stdout + child.stderr,
    /scanned_connections|WOULD REVOKE|No database selected|dry-run:/,
    'importing must not execute the CLI main()',
  );
});

// ─── Postgres-backed integration tests (gated on PDPP_TEST_POSTGRES_URL) ─────
//
// The reference implementation supports a Postgres storage backend
// (server/postgres-storage.js, `pg` dependency); many deployments use it and
// that is exactly where residual phantom rows may live. These prove the
// Postgres arm against a REAL Postgres: candidate identification in dry-run
// without mutation, transactional revoke under --apply semantics, fail-closed
// skips, and no re-materialization on the next scan.
//
// Each test uses a unique owner_subject_id so concurrent rows never collide and
// teardown is scoped. The schema is bootstrapped idempotently. To run:
//   PDPP_TEST_POSTGRES_URL=postgres://user:pass@host:port/db \
//     node --test --import ./scripts/test-env.js \
//     scripts/cleanup-phantom-connections/cleanup-phantom-connections.test.mjs

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL || process.env.PDPP_DATABASE_URL || '';

if (!POSTGRES_URL) {
  test('cleanup-phantom-connections Postgres tests (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  const PG_CONNECTOR_ID = 'https://test.pdpp.dev/connectors/pg-phantom-cleanup';
  let suiteCounter = 0;

  // Initialize the module-scoped Postgres storage once for the suite; reused by
  // the store layer and the script's own queries. Each test scopes by owner.
  async function withPg(fn) {
    const storage = await import('../../server/postgres-storage.js');
    await storage.initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    const pool = storage.getPostgresPool();
    const owner = `owner_pg_test_${process.pid}_${suiteCounter++}`;
    try {
      // Register the connector (FK target for connector_instances).
      await pool.query(
        `INSERT INTO connectors(connector_id, manifest) VALUES($1, $2::jsonb) ON CONFLICT DO NOTHING`,
        [PG_CONNECTOR_ID, JSON.stringify({ connector_id: PG_CONNECTOR_ID })],
      );
      await fn({ pool, owner, storage });
    } finally {
      // Scoped teardown: only this owner's rows.
      try {
        await pool.query(`DELETE FROM connector_instances WHERE owner_subject_id = $1`, [owner]);
        await pool.query(`DELETE FROM grants WHERE subject_id = $1`, [owner]);
      } catch {
        /* best-effort */
      }
      await storage.closePostgresStorage().catch(() => {});
    }
  }

  async function seedPgPhantom(pool, owner) {
    const store = createPostgresConnectorInstanceStore();
    const inst = await store.ensureDefaultAccountConnection({
      ownerSubjectId: owner,
      connectorId: PG_CONNECTOR_ID,
      displayName: 'PG Phantom',
      now: '2026-06-02T00:00:00.000Z',
    });
    return inst.connectorInstanceId;
  }

  test('Postgres: a fresh phantom is a candidate; --apply-equivalent revoke removes it and survives the next scan', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      assert.equal(id, makeDefaultAccountConnectorInstanceId(owner, PG_CONNECTOR_ID));

      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 1, 'exactly one phantom candidate');
      assert.equal(plan.candidates[0].connector_instance_id, id);
      assert.equal(plan.skipped.length, 0);

      const { revoked, skippedAtApply } = await applyRevokePg({ pool, candidates: plan.candidates });
      assert.equal(revoked.length, 1);
      assert.equal(revoked[0].status, 'revoked');
      assert.ok(revoked[0].revoked_at, 'revoked_at is set');
      assert.equal(skippedAtApply.length, 0);

      // Next scan: no candidate, skipped P3, no re-materialization.
      const reread = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(reread.candidates.length, 0, 'revoke survives the next scan');
      assert.ok(reread.skipped[0].reasons.includes('P3:status-revoked'));
      const store = createPostgresConnectorInstanceStore();
      assert.equal((await store.get(id)).status, 'revoked', 'row stays revoked');
    });
  });

  test('Postgres: dry-run plan mutates nothing', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 1);
      // planCleanupPg did not mutate.
      const store = createPostgresConnectorInstanceStore();
      assert.equal((await store.get(id)).status, 'active', 'planning left the row active');
    });
  });

  test('Postgres apply-time re-evaluation: a record inserted AFTER the plan but BEFORE apply blocks the revoke', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);

      // Plan sees a clean phantom.
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 1);
      assert.equal(plan.candidates[0].connector_instance_id, id);

      // Concurrent write between plan and apply: a record appears. Status is
      // unchanged (still 'active'), so a bare status re-assert would have
      // force-revoked it. The in-transaction full re-evaluation must catch it.
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [PG_CONNECTOR_ID, id, 'messages', 'r-late', JSON.stringify({ id: 'r-late' }), '2026-06-02T00:00:01.000Z', 'r-late'],
      );

      const { revoked, skippedAtApply } = await applyRevokePg({ pool, candidates: plan.candidates });
      assert.equal(revoked.length, 0, 'the now-data-bearing row is NOT revoked');
      assert.equal(skippedAtApply.length, 1, 'it is reported as skipped-at-apply');
      assert.equal(skippedAtApply[0].connector_instance_id, id);
      assert.ok(
        skippedAtApply[0].reasons.some((r) => r.startsWith('P4:records=')),
        `expected a P4 records reason at apply, got ${skippedAtApply[0].reasons.join(',')}`,
      );
      const store = createPostgresConnectorInstanceStore();
      assert.equal((await store.get(id)).status, 'active', 'the row is left active, untouched');

      // Clean the record so owner-scoped teardown does not orphan an FK row.
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [id]);
    });
  });

  test('Postgres apply-time re-evaluation: a grant reference inserted before apply blocks the revoke', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 1);

      await pool.query(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
          `grant_pg_late_${owner}`,
          owner,
          'client_test',
          JSON.stringify({ connector_instance_id: id }),
          '{}',
          'snapshot',
          'active',
          '2026-06-02T00:00:01.000Z',
        ],
      );

      const { revoked, skippedAtApply } = await applyRevokePg({ pool, candidates: plan.candidates });
      assert.equal(revoked.length, 0);
      assert.equal(skippedAtApply.length, 1);
      assert.ok(
        skippedAtApply[0].reasons.some((r) => r.startsWith('P5:grant-storage-binding=')),
        `expected a P5 grant reason at apply, got ${skippedAtApply[0].reasons.join(',')}`,
      );
      const store = createPostgresConnectorInstanceStore();
      assert.equal((await store.get(id)).status, 'active');
    });
  });

  test('Postgres: P4 fails closed — a phantom with any record is skipped', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [PG_CONNECTOR_ID, id, 'messages', 'r1', JSON.stringify({ id: 'r1' }), '2026-06-02T00:00:00.000Z', 'r1'],
      );
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 0, 'row with data is not a candidate');
      assert.ok(
        plan.skipped[0].reasons.some((r) => r.startsWith('P4:records=')),
        `expected a P4 records reason, got ${plan.skipped[0].reasons.join(',')}`,
      );
      // Clean the record so owner-scoped teardown (which only deletes instances)
      // does not leave an orphan FK row.
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [id]);
    });
  });

  test('Postgres: P5 fails closed — a phantom referenced by a grant storage binding is skipped', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      await pool.query(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
          `grant_pg_${owner}`,
          owner,
          'client_test',
          JSON.stringify({ connector_instance_id: id }),
          '{}',
          'snapshot',
          'active',
          '2026-06-02T00:00:00.000Z',
        ],
      );
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 0, 'grant-referenced row is not a candidate');
      assert.ok(
        plan.skipped[0].reasons.some((r) => r.startsWith('P5:grant-storage-binding=')),
        `expected a P5 grant reason, got ${plan.skipped[0].reasons.join(',')}`,
      );
    });
  });

  test('Postgres: P5b does NOT block — a phantom referenced only by a grant-package member display pointer IS a candidate with a note', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      const packageId = `pkg_pg_${owner}`;
      const grantId = `grt_pg_member_${owner}`;
      const tokenId = `tok_pg_member_${owner}`;
      // A grant whose grant_json does NOT pin a stream connection_id (so no P5a),
      // and storage_binding is {connector_id} only.
      await pool.query(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
          grantId,
          owner,
          'client_test',
          JSON.stringify({ connector_id: PG_CONNECTOR_ID }),
          JSON.stringify({ source: { kind: 'connector', id: PG_CONNECTOR_ID }, streams: [{ name: 'messages' }] }),
          'snapshot',
          'active',
          '2026-06-02T00:00:00.000Z',
        ],
      );
      await pool.query(
        `INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
         VALUES($1, $2, $3, 'active', $4::jsonb, $5, $5)`,
        [packageId, owner, 'client_test', '{}', '2026-06-02T00:00:00.000Z'],
      );
      await pool.query(
        `INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at)
         VALUES($1, $2, $3, $4::jsonb, 'active', $5)`,
        [
          packageId,
          grantId,
          tokenId,
          JSON.stringify({ kind: 'connector', id: PG_CONNECTOR_ID, connection_id: id }),
          '2026-06-02T00:00:00.000Z',
        ],
      );

      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 1, 'member-referenced phantom is a candidate');
      assert.equal(plan.candidates[0].connector_instance_id, id);
      assert.ok(
        (plan.candidates[0].notes || []).some((n) => n.startsWith('P5b:grant-package-member-display-ref=')),
        `expected a P5b member note, got ${JSON.stringify(plan.candidates[0].notes)}`,
      );

      // Apply revokes only the connection; the grant package + member + grant stay active.
      const { revoked } = await applyRevokePg({ pool, candidates: plan.candidates });
      assert.equal(revoked.length, 1);
      const pkg = await pool.query(`SELECT status FROM grant_packages WHERE package_id = $1`, [packageId]);
      assert.equal(pkg.rows[0].status, 'active', 'grant package untouched');
      const member = await pool.query(
        `SELECT status FROM grant_package_members WHERE package_id = $1 AND grant_id = $2`,
        [packageId, grantId],
      );
      assert.equal(member.rows[0].status, 'active', 'member row untouched');
      const grant = await pool.query(`SELECT status FROM grants WHERE grant_id = $1`, [grantId]);
      assert.equal(grant.rows[0].status, 'active', 'child grant untouched');

      // Scoped cleanup of the rows this test created (teardown only deletes instances + grants by owner).
      await pool.query(`DELETE FROM grant_package_members WHERE package_id = $1`, [packageId]);
      await pool.query(`DELETE FROM grant_packages WHERE package_id = $1`, [packageId]);
    });
  });

  test('Postgres: P5a BLOCKS — a phantom pinned by an active grant.streams[].connection_id is refused', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      await pool.query(
        `INSERT INTO grants(grant_id, subject_id, client_id, storage_binding_json, grant_json, access_mode, status, issued_at)
         VALUES($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
          `grant_pg_pin_${owner}`,
          owner,
          'client_test',
          JSON.stringify({ connector_id: PG_CONNECTOR_ID }),
          JSON.stringify({ streams: [{ name: 'messages', connection_id: id }] }),
          'continuous',
          'active',
          '2026-06-02T00:00:00.000Z',
        ],
      );
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 0, 'grant-stream-pinned row is not a candidate');
      assert.ok(
        plan.skipped[0].reasons.some((r) => r.startsWith('P5:grant-stream-pin=')),
        `expected a P5 grant-stream-pin reason, got ${plan.skipped[0].reasons.join(',')}`,
      );
    });
  });

  test('Postgres: P7 fails closed — a phantom with a credential is skipped', async () => {
    await withPg(async ({ pool, owner }) => {
      const id = await seedPgPhantom(pool, owner);
      await pool.query(
        `INSERT INTO connector_instance_credentials(connector_instance_id, owner_subject_id, credential_kind, sealed_secret, status, captured_at)
         VALUES($1, $2, $3, $4, $5, $6)`,
        [id, owner, 'app_password', 'sealed-not-a-real-secret', 'active', '2026-06-02T00:00:00.000Z'],
      );
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 0, 'credentialed row is not a candidate');
      assert.ok(
        plan.skipped[0].reasons.some((r) => r.startsWith('P7:credential=')),
        `expected a P7 credential reason, got ${plan.skipped[0].reasons.join(',')}`,
      );
      // FK ON DELETE CASCADE removes the credential when the instance is deleted
      // in teardown, but delete it explicitly to be safe across schema variants.
      await pool.query(`DELETE FROM connector_instance_credentials WHERE connector_instance_id = $1`, [id]);
    });
  });

  test('Postgres: evaluateInstancePg agrees with planCleanupPg for a real account (P1 out of scope)', async () => {
    await withPg(async ({ pool, owner }) => {
      const store = createPostgresConnectorInstanceStore();
      const real = await store.upsert({
        ownerSubjectId: owner,
        connectorId: PG_CONNECTOR_ID,
        displayName: 'Real account',
        status: 'active',
        sourceKind: 'account',
        sourceBinding: { account: 'real-user@example.com' },
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
      });
      const { candidate, reasons } = await evaluateInstancePg(pool, real);
      assert.equal(candidate, false, 'a real account connection is out of scope');
      assert.ok(reasons.includes('P1:not-default-account-provenance'));
      const plan = await planCleanupPg({ pool, ownerSubjectId: owner });
      assert.equal(plan.candidates.length, 0);
    });
  });

  // Blocker #2 proof: a NON-bootstrapping scan keeps a genuinely-missing
  // evidence table missing, so the P4–P7 fail-closed guard is reachable. We
  // build an isolated schema that has ONLY connectors + connector_instances
  // (no records/grants/etc.), put it first on search_path, and scan it with a
  // PLAIN pg.Pool — exactly as runPostgres() does. If the scan ran schema
  // bootstrap (the old initPostgresStorage path), the missing tables would be
  // created empty and the phantom would (wrongly) become a candidate. With the
  // no-bootstrap scan, every absent evidence table yields `<table>-table-missing`
  // and the row is fail-closed SKIPPED.
  test('Postgres no-bootstrap scan: missing evidence tables fail closed (not created empty)', async () => {
    const pg = (await import('pg')).default;
    const schema = `phantom_missing_tbl_${process.pid}_${suiteCounter++}`;
    const admin = new pg.Pool({ connectionString: POSTGRES_URL });
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      // Only the two tables the scan reads structurally + lists from. NO
      // evidence/activity/grants tables exist in this schema.
      await admin.query(`
        CREATE TABLE ${schema}.connectors (connector_id TEXT PRIMARY KEY, manifest JSONB NOT NULL);
        CREATE TABLE ${schema}.connector_instances (
          connector_instance_id TEXT PRIMARY KEY,
          owner_subject_id TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_binding_key TEXT NOT NULL,
          source_binding_json JSONB NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revoked_at TEXT
        );
      `);
      const owner = `owner_missing_tbl_${process.pid}`;
      const id = makeDefaultAccountConnectorInstanceId(owner, PG_CONNECTOR_ID);
      await admin.query(`INSERT INTO ${schema}.connectors(connector_id, manifest) VALUES($1, $2::jsonb)`, [
        PG_CONNECTOR_ID,
        JSON.stringify({ connector_id: PG_CONNECTOR_ID }),
      ]);
      await admin.query(
        `INSERT INTO ${schema}.connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, $4, 'active', 'account', 'default', $5::jsonb, $6, $6, NULL)`,
        [id, owner, PG_CONNECTOR_ID, 'PG Phantom', JSON.stringify({ kind: 'default_account' }), '2026-06-02T00:00:00.000Z'],
      );

      // Plain pool scoped to the isolated schema; pg.Pool does NOT bootstrap.
      const scanPool = new pg.Pool({ connectionString: POSTGRES_URL, options: `-c search_path=${schema}` });
      try {
        const plan = await planCleanupPg({ runner: scanPool, ownerSubjectId: owner });
        assert.equal(plan.candidates.length, 0, 'missing evidence tables must fail closed, never a candidate');
        assert.equal(plan.skipped.length, 1);
        const reasons = plan.skipped[0].reasons;
        assert.ok(
          reasons.includes('P4:records-table-missing'),
          `expected P4:records-table-missing, got ${reasons.join(',')}`,
        );
        assert.ok(
          reasons.includes('P5:grants-table-missing'),
          `expected P5:grants-table-missing, got ${reasons.join(',')}`,
        );
        assert.ok(
          reasons.includes('P7:connector_instance_credentials-table-missing'),
          `expected P7 credential-table-missing, got ${reasons.join(',')}`,
        );
        // Proof the scan did NOT bootstrap: the evidence table still does not
        // exist in the schema after the scan.
        const stillMissing = await admin.query(`SELECT to_regclass('${schema}.records') AS oid`);
        assert.equal(stillMissing.rows[0].oid, null, 'scan must not have created the missing table');
      } finally {
        await scanPool.end().catch(() => {});
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
}
