// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: record-bearing public-read responses (records list, records
 * detail, changes_since list, aggregate) SHALL carry the canonical
 * `connection_id` and the deprecated `connector_instance_id` alias on every
 * item the runtime can pin without guessing.
 *
 * The deprecated-alias-usage warning SHALL also flow through to the
 * canonical `meta.warnings[]` slot on records list / aggregate responses.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       Tasks 3.1 + 3.6 of the change.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, initDb } from '../server/db.js';
import {
  aggregateRecords,
  getRecord,
  ingestRecord,
  queryRecords,
} from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'connection-id-decoration';
const INSTANCE_ID = 'cin_test_decoration_main';
const STREAM = 'messages';

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'subject', 'received_at'] }],
};

const manifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Decoration Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'subject', 'received_at'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
        },
      },
      query: {
        aggregations: { count: true },
      },
    },
  ],
};

function target() {
  return {
    connector_id: CONNECTOR_ID,
    connector_instance_id: INSTANCE_ID,
  };
}

function recordPayload(id, subject, receivedAt) {
  return {
    stream: STREAM,
    key: id,
    data: {
      id,
      subject,
      received_at: receivedAt,
    },
    emitted_at: receivedAt,
  };
}

// Distinct received_at values let sort-direction tests observe the result
// order. Other tests in this file ignore ordering and only assert membership /
// counts / metadata, so the values are safe to differentiate.
const REC_1_RECEIVED_AT = '2026-05-18T12:00:00.000Z';
const REC_2_RECEIVED_AT = '2026-05-19T12:00:00.000Z';

async function withDb(testFn) {
  initDb();
  try {
    await registerConnector(manifest);
    await ingestRecord(target(), recordPayload('rec-1', 'first', REC_1_RECEIVED_AT));
    await ingestRecord(target(), recordPayload('rec-2', 'second', REC_2_RECEIVED_AT));
    await testFn();
  } finally {
    closeDb();
  }
}

// ─── Records list ───────────────────────────────────────────────────────────

test('records list decorates every record with connection_id + deprecated alias', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, {}, manifest);
    assert.equal(response.object, 'list');
    assert.equal(response.data.length, 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_ID);
      assert.equal(record.connector_instance_id, INSTANCE_ID);
    }
    // No alias warning because the request was clean.
    assert.equal(response.meta, undefined);
  });
});

test('records list emits meta.warnings deprecated_alias_used when the deprecated alias was sent', async () => {
  await withDb(async () => {
    const response = await queryRecords(
      target(),
      STREAM,
      grant,
      { connector_instance_id: INSTANCE_ID },
      manifest,
    );
    assert.ok(response.meta, 'expected response.meta to be present');
    assert.equal(response.meta.warnings.length, 1);
    assert.equal(response.meta.warnings[0].code, 'deprecated_alias_used');
    assert.equal(response.meta.warnings[0].param, 'connector_instance_id');
  });
});

test('records list does not emit meta.warnings when only canonical connection_id is sent', async () => {
  await withDb(async () => {
    const response = await queryRecords(
      target(),
      STREAM,
      grant,
      { connection_id: INSTANCE_ID },
      manifest,
    );
    assert.equal(response.meta, undefined);
  });
});

test('records list rejects connection_id outside the grant storage binding', async () => {
  await withDb(async () => {
    await assert.rejects(
      () => queryRecords(
        target(),
        STREAM,
        grant,
        { connection_id: 'cin_other_connection' },
        manifest,
      ),
      (err) => {
        assert.equal(err.code, 'connection_not_found');
        assert.equal(err.param, 'connection_id');
        return true;
      },
    );
  });
});

// ─── Records list (changes_since branch) ───────────────────────────────────

test('records list changes_since branch decorates each emitted record with connection_id', async () => {
  await withDb(async () => {
    const response = await queryRecords(
      target(),
      STREAM,
      grant,
      { changes_since: 'beginning' },
      manifest,
    );
    assert.equal(response.object, 'list');
    assert.ok(response.data.length >= 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_ID);
      assert.equal(record.connector_instance_id, INSTANCE_ID);
    }
    // next_changes_since cursor still flows through.
    assert.ok(response.next_changes_since);
  });
});

// ─── Records detail ─────────────────────────────────────────────────────────

test('records detail decorates the returned record with connection_id + deprecated alias', async () => {
  await withDb(async () => {
    const record = await getRecord(target(), STREAM, 'rec-1', grant, manifest);
    assert.equal(record.object, 'record');
    assert.equal(record.id, 'rec-1');
    assert.equal(record.connection_id, INSTANCE_ID);
    assert.equal(record.connector_instance_id, INSTANCE_ID);
  });
});

test('records detail emits meta.warnings when the deprecated alias was sent', async () => {
  await withDb(async () => {
    const record = await getRecord(
      target(),
      STREAM,
      'rec-1',
      grant,
      manifest,
      { connector_instance_id: INSTANCE_ID },
    );
    assert.ok(record.meta);
    assert.equal(record.meta.warnings[0].code, 'deprecated_alias_used');
  });
});

test('records detail rejects connection_id outside the grant storage binding', async () => {
  await withDb(async () => {
    await assert.rejects(
      () => getRecord(
        target(),
        STREAM,
        'rec-1',
        grant,
        manifest,
        { connection_id: 'cin_other_connection' },
      ),
      (err) => {
        assert.equal(err.code, 'connection_not_found');
        assert.equal(err.param, 'connection_id');
        return true;
      },
    );
  });
});

// ─── Records aggregate ──────────────────────────────────────────────────────

test('records aggregate emits meta.warnings when the deprecated alias was sent', async () => {
  await withDb(async () => {
    const response = await aggregateRecords(
      target(),
      STREAM,
      grant,
      { metric: 'count', connector_instance_id: INSTANCE_ID },
      manifest,
    );
    assert.equal(response.object, 'aggregation');
    assert.equal(response.value, 2);
    assert.ok(response.meta);
    assert.equal(response.meta.warnings[0].code, 'deprecated_alias_used');
  });
});

test('records aggregate omits meta.warnings when no alias is sent', async () => {
  await withDb(async () => {
    const response = await aggregateRecords(
      target(),
      STREAM,
      grant,
      { metric: 'count' },
      manifest,
    );
    assert.equal(response.meta, undefined);
  });
});

test('records aggregate rejects connection_id outside the grant storage binding', async () => {
  await withDb(async () => {
    await assert.rejects(
      () => aggregateRecords(
        target(),
        STREAM,
        grant,
        { metric: 'count', connection_id: 'cin_other_connection' },
        manifest,
      ),
      (err) => {
        assert.equal(err.code, 'connection_not_found');
        assert.equal(err.param, 'connection_id');
        return true;
      },
    );
  });
});

// ─── Strict validation regression ───────────────────────────────────────────

test('records list rejects unsupported query params with invalid_request', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(
        target(),
        STREAM,
        grant,
        { not_a_real_param: 'foo' },
        manifest,
      ),
      (err) => err.code === 'invalid_request' && /Unsupported query parameter/.test(err.message),
    );
  });
});

test('records list rejects unsupported expand relation with invalid_expand', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(
        target(),
        STREAM,
        grant,
        { expand: 'nonexistent_relation' },
        manifest,
      ),
      (err) => err.code === 'invalid_expand',
    );
  });
});

test('records list rejects conflicting connection_id / connector_instance_id with invalid_argument', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(
        target(),
        STREAM,
        grant,
        { connection_id: 'cin_a', connector_instance_id: 'cin_b' },
        manifest,
      ),
      (err) => err.code === 'invalid_argument' && err.param === 'connector_instance_id',
    );
  });
});

// ─── display_name decoration ────────────────────────────────────────────────

async function seedConnectorInstance({ displayName, sourceBindingKey = 'work-1' }) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: INSTANCE_ID,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account: 'work@example.com' },
    createdAt: now,
    updatedAt: now,
  });
}

test('records list decorates records with display_name when the store has an owner-meaningful label', async () => {
  await withDb(async () => {
    await seedConnectorInstance({ displayName: 'Work Mailbox' });
    const response = await queryRecords(target(), STREAM, grant, {}, manifest);
    assert.equal(response.data.length, 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_ID);
      assert.equal(record.display_name, 'Work Mailbox');
    }
  });
});

test('records list omits display_name when the store only has a connector-id placeholder', async () => {
  await withDb(async () => {
    // displayName defaulting to connector_id is the documented placeholder.
    await seedConnectorInstance({ displayName: CONNECTOR_ID });
    const response = await queryRecords(target(), STREAM, grant, {}, manifest);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_ID);
      assert.equal(record.display_name, undefined);
    }
  });
});

test('records detail decorates display_name when the store has an owner-meaningful label', async () => {
  await withDb(async () => {
    await seedConnectorInstance({ displayName: 'Work Mailbox' });
    const record = await getRecord(target(), STREAM, 'rec-1', grant, manifest);
    assert.equal(record.connection_id, INSTANCE_ID);
    assert.equal(record.display_name, 'Work Mailbox');
  });
});

test('records list omits display_name when no connector-instance row exists for the binding', async () => {
  // Default withDb path: ingestRecord auto-materializes a default-account
  // instance whose displayName equals the connector_id (placeholder). Verify
  // the projection treats that as missing and omits display_name on the wire.
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, {}, manifest);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_ID);
      assert.equal(record.display_name, undefined);
    }
  });
});

// ─── Graded counts ──────────────────────────────────────────────────────────

test('records list omits meta.count when count is not requested', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, {}, manifest);
    assert.equal(response.meta, undefined);
  });
});

test('records list emits meta.count = { kind: none } when count=none is requested', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, { count: 'none' }, manifest);
    // count=none is the default; runtime omits meta.count to keep the wire
    // payload small. canonical envelope normalization happens at the route
    // layer, so the operation result is still envelope-light here.
    assert.equal(response.meta, undefined);
  });
});

test('records list emits meta.count.kind=exact with the visible-row count when count=exact', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, { count: 'exact' }, manifest);
    assert.ok(response.meta);
    assert.equal(response.meta.count.kind, 'exact');
    assert.equal(response.meta.count.value, 2);
  });
});

test('records list returns exact for count=estimated without a downgrade warning', async () => {
  // exact is a higher grade than estimated; returning exact for an
  // estimated request is an upgrade, not a downgrade. The canonical rule
  // is that `count_downgraded` is emitted only when the server returns a
  // *lower* grade than requested (e.g. exact → estimated / none). The
  // reference runtime always computes exact cheaply on the SQLite path, so
  // the wire payload has `meta.count.kind = exact` and NO warning.
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, { count: 'estimated' }, manifest);
    assert.ok(response.meta);
    assert.equal(response.meta.count.kind, 'exact');
    assert.equal(response.meta.count.value, 2);
    assert.equal(response.meta.warnings, undefined, 'no warnings expected: upgrade is not a downgrade');
  });
});

test('records list rejects unknown count grade with invalid_request', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(target(), STREAM, grant, { count: 'planned' }, manifest),
      (err) => err.code === 'invalid_request' && /count must be one of/.test(err.message),
    );
  });
});

// ─── Canonical sort validation ──────────────────────────────────────────────

test('records list accepts sort over the manifest cursor field', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, { sort: '-received_at' }, manifest);
    assert.equal(response.object, 'list');
    assert.equal(response.data.length, 2);
  });
});

test('records list rejects sort fields that are not advertised as sortable', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(target(), STREAM, grant, { sort: 'subject' }, manifest),
      (err) => err.code === 'invalid_sort' && err.param === 'sort' && /not advertised as sortable/.test(err.message),
    );
  });
});

test('records list rejects an empty sort entry', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(target(), STREAM, grant, { sort: '-' }, manifest),
      (err) => err.code === 'invalid_sort' && err.param === 'sort',
    );
  });
});

// Sort direction MUST control output order. The canonical sign prefix is
// not a no-op: `sort=-received_at` is DESC; `sort=received_at` is ASC.
// These tests fail if the runtime silently ignores the sign and falls
// back to legacy `order` defaults.
test('records list sort=-received_at returns records in DESC order', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, { sort: '-received_at' }, manifest);
    assert.equal(response.data.length, 2);
    assert.equal(response.data[0].id, 'rec-2');
    assert.equal(response.data[0].data.received_at, REC_2_RECEIVED_AT);
    assert.equal(response.data[1].id, 'rec-1');
    assert.equal(response.data[1].data.received_at, REC_1_RECEIVED_AT);
  });
});

test('records list sort=received_at returns records in ASC order', async () => {
  await withDb(async () => {
    const response = await queryRecords(target(), STREAM, grant, { sort: 'received_at' }, manifest);
    assert.equal(response.data.length, 2);
    assert.equal(response.data[0].id, 'rec-1');
    assert.equal(response.data[0].data.received_at, REC_1_RECEIVED_AT);
    assert.equal(response.data[1].id, 'rec-2');
    assert.equal(response.data[1].data.received_at, REC_2_RECEIVED_AT);
  });
});

test('records list rejects when sort and order disagree', async () => {
  await withDb(async () => {
    await assert.rejects(
      queryRecords(target(), STREAM, grant, { sort: '-received_at', order: 'asc' }, manifest),
      (err) => err.code === 'invalid_sort' && /disagree/.test(err.message),
    );
  });
});

test('records changes_since rejects list-only sort, count, and order params', async () => {
  await withDb(async () => {
    for (const params of [
      { changes_since: 'beginning', sort: '-received_at' },
      { changes_since: 'beginning', count: 'exact' },
      { changes_since: 'beginning', order: 'asc' },
    ]) {
      await assert.rejects(
        queryRecords(target(), STREAM, grant, params, manifest),
        (err) => err.code === 'invalid_request' && /not supported with changes_since/.test(err.message),
      );
    }
  });
});
