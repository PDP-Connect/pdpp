/**
 * Storage fan-in / public-read multi-connection contract regression suite.
 *
 * Closes the deferred runtime tranche under
 * `openspec/changes/expose-connection-identity-on-public-read/tasks.md`:
 *
 *   - records list, aggregate, and streams list fan in across the granted
 *     connections when `connection_id` is omitted;
 *   - exactly-one matching connection auto-selects without raising;
 *   - record detail emits `ambiguous_connection` with `available_connections`
 *     when the identifier resolves to more than one connection;
 *   - grant scope `streams[].connection_id` narrows reads to one connection
 *     and preserves cross-connection (fan-in) semantics when absent;
 *   - owner `setDisplayName` mutates `display_name` and surfaces it on the
 *     subsequent records-list response;
 *   - deprecated `connector_instance_id` request alias keeps working;
 *     conflicting `connection_id` vs `connector_instance_id` values are
 *     rejected with typed `invalid_argument`.
 *
 * Stays on the SQLite reference path; Postgres parity is exercised by the
 * existing per-binding tests under `public-read-connection-id-decoration.test.js`
 * for the single-binding case and by the same fan-in helpers' Postgres-aware
 * delegation in `records.js` / `connection-identity.js`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  aggregateRecordsAcrossBindings,
  getRecordAcrossBindings,
  listStreamsAcrossBindings,
  queryRecordsAcrossBindings,
  resolveReadRequestBindings,
  ingestRecord,
  validateConnectionAlias,
} from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import {
  AmbiguousConnectionError,
  resolveFanInBindings,
} from '../server/connection-identity.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/storage-fan-in';
const STREAM = 'messages';

const INSTANCE_A = 'cin_fanin_account_a';
const INSTANCE_B = 'cin_fanin_account_b';

const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Fan-in Test Connector',
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
        aggregations: {
          count: true,
          group_by: ['subject'],
          group_by_time: ['received_at'],
          count_distinct: ['subject'],
        },
      },
    },
  ],
};

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'subject', 'received_at'] }],
};

function target(instanceId) {
  return {
    connector_id: CONNECTOR_ID,
    connector_instance_id: instanceId,
  };
}

function recordPayload(id, subject, receivedAt) {
  return {
    stream: STREAM,
    key: id,
    data: { id, subject, received_at: receivedAt },
    emitted_at: receivedAt,
  };
}

async function seedInstance(instanceId, displayName, sourceBindingKey) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account: sourceBindingKey },
    createdAt: now,
    updatedAt: now,
  });
}

async function withDualConnectionDb(testFn) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
    await ingestRecord(target(INSTANCE_A), recordPayload('rec-a-1', 'A first', '2026-05-18T12:00:00.000Z'));
    await ingestRecord(target(INSTANCE_A), recordPayload('shared-id', 'A shared', '2026-05-18T12:01:00.000Z'));
    await ingestRecord(target(INSTANCE_B), recordPayload('rec-b-1', 'B first', '2026-05-18T12:02:00.000Z'));
    await ingestRecord(target(INSTANCE_B), recordPayload('shared-id', 'B shared', '2026-05-18T12:03:00.000Z'));
    await testFn();
  } finally {
    closeDb();
  }
}

async function withSingleConnectionDb(testFn) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Sole Account', 'a@example.com');
    await ingestRecord(target(INSTANCE_A), recordPayload('rec-a-1', 'A first', '2026-05-18T12:00:00.000Z'));
    await ingestRecord(target(INSTANCE_A), recordPayload('rec-a-2', 'A second', '2026-05-18T12:01:00.000Z'));
    await testFn();
  } finally {
    closeDb();
  }
}

// ─── Binding resolver ──────────────────────────────────────────────────────

test('resolveFanInBindings returns both active bindings when no narrowing is requested', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const ids = bindings.map((b) => b.connectorInstanceId).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  });
});

test('resolveFanInBindings narrows to a single binding when request supplies connection_id', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
      requestConnectionId: INSTANCE_B,
    });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].connectorInstanceId, INSTANCE_B);
  });
});

test('resolveFanInBindings rejects connection_id outside the grant with connection_not_found', async () => {
  await withDualConnectionDb(async () => {
    await assert.rejects(
      () => resolveFanInBindings({
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId: CONNECTOR_ID,
        requestConnectionId: 'cin_does_not_exist',
      }),
      (err) => err.code === 'connection_not_found' && err.param === 'connection_id',
    );
  });
});

test('resolveFanInBindings honors grant-scope connection_id constraint', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
      grantStreamConnectionId: INSTANCE_A,
    });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].connectorInstanceId, INSTANCE_A);
  });
});

test('resolveReadRequestBindings forwards deprecated_alias_used warning when alias is sent', async () => {
  await withDualConnectionDb(async () => {
    const { bindings, warnings } = await resolveReadRequestBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      storageBinding: { connector_id: CONNECTOR_ID },
      grant,
      requestParams: { connector_instance_id: INSTANCE_A },
      streamName: STREAM,
    });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].connectorInstanceId, INSTANCE_A);
    assert.ok(warnings.find((w) => w.code === 'deprecated_alias_used'));
  });
});

// ─── Records list fan-in ───────────────────────────────────────────────────

test('queryRecordsAcrossBindings fans in records across two granted connections', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.object, 'list');
    assert.equal(response.data.length, 4, 'expected union of records across both connections');

    const idsByConnection = {};
    for (const record of response.data) {
      const cid = record.connection_id;
      assert.ok(cid, 'every record SHALL carry connection_id');
      assert.equal(record.connector_instance_id, cid, 'deprecated alias mirrors canonical');
      idsByConnection[cid] = (idsByConnection[cid] || 0) + 1;
    }
    assert.equal(idsByConnection[INSTANCE_A], 2);
    assert.equal(idsByConnection[INSTANCE_B], 2);
  });
});

test('queryRecordsAcrossBindings narrows to one binding when bindings list is filtered', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
      requestConnectionId: INSTANCE_A,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.data.length, 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_A);
      assert.equal(record.display_name, 'Account A');
    }
  });
});

test('queryRecordsAcrossBindings auto-selects exactly-one binding without raising', async () => {
  await withSingleConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(bindings.length, 1);
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.data.length, 2);
    for (const record of response.data) {
      assert.equal(record.connection_id, INSTANCE_A);
    }
  });
});

// ─── Records detail ambiguity / auto-select ────────────────────────────────

test('getRecordAcrossBindings emits ambiguous_connection when identifier resolves to multiple bindings', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    await assert.rejects(
      () => getRecordAcrossBindings(bindings, STREAM, 'shared-id', grant, baseManifest, {}),
      (err) => {
        assert.ok(err instanceof AmbiguousConnectionError, 'expected AmbiguousConnectionError');
        assert.equal(err.code, 'ambiguous_connection');
        assert.equal(err.retry_with, 'connection_id');
        const ids = err.available_connections.map((c) => c.connection_id).sort();
        assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
        const labels = err.available_connections.map((c) => c.display_name).sort();
        assert.deepEqual(labels, ['Account A', 'Account B']);
        return true;
      },
    );
  });
});

test('getRecordAcrossBindings auto-selects the only binding holding a unique identifier', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const record = await getRecordAcrossBindings(bindings, STREAM, 'rec-a-1', grant, baseManifest, {});
    assert.equal(record.connection_id, INSTANCE_A);
    assert.equal(record.display_name, 'Account A');
  });
});

test('getRecordAcrossBindings narrows successfully with explicit connection_id on ambiguous identifier', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
      requestConnectionId: INSTANCE_B,
    });
    const record = await getRecordAcrossBindings(
      bindings,
      STREAM,
      'shared-id',
      grant,
      baseManifest,
      { connection_id: INSTANCE_B },
    );
    assert.equal(record.connection_id, INSTANCE_B);
    assert.equal(record.data.subject, 'B shared');
  });
});

test('getRecordAcrossBindings returns not_found when identifier is absent from every binding', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    await assert.rejects(
      () => getRecordAcrossBindings(bindings, STREAM, 'missing', grant, baseManifest, {}),
      (err) => err.code === 'not_found',
    );
  });
});

// ─── Aggregate fan-in ──────────────────────────────────────────────────────

test('aggregateRecordsAcrossBindings sums counts across granted connections', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await aggregateRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { metric: 'count' },
      baseManifest,
    );
    assert.equal(response.object, 'aggregation');
    assert.equal(response.stream, STREAM);
    assert.equal(response.metric, 'count');
    assert.equal(response.field, null);
    assert.equal(response.group_by, null);
    assert.equal(response.group_by_time, null);
    assert.equal(response.granularity, null);
    assert.equal(response.time_zone, null);
    assert.equal(response.approximate, false);
    assert.equal(response.filtered_record_count, 4);
    assert.equal(response.value, 4);
  });
});

test('aggregateRecordsAcrossBindings merges scalar group_by buckets across granted connections', async () => {
  await withDualConnectionDb(async () => {
    await ingestRecord(target(INSTANCE_B), recordPayload('rec-b-2', 'A first', '2026-05-18T12:04:00.000Z'));
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await aggregateRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { metric: 'count', group_by: 'subject', limit: '10' },
      baseManifest,
    );
    assert.equal(response.object, 'aggregation');
    assert.equal(response.stream, STREAM);
    assert.equal(response.metric, 'count');
    assert.equal(response.group_by, 'subject');
    assert.equal(response.filtered_record_count, 5);
    assert.equal(response.limit, 10);
    assert.deepEqual(response.groups, [
      { key: 'A first', count: 2 },
      { key: 'A shared', count: 1 },
      { key: 'B first', count: 1 },
      { key: 'B shared', count: 1 },
    ]);
  });
});

test('aggregateRecordsAcrossBindings merges group_by_time buckets across granted connections', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await aggregateRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { metric: 'count', group_by_time: 'received_at', granularity: 'day' },
      baseManifest,
    );
    assert.equal(response.object, 'aggregation');
    assert.equal(response.stream, STREAM);
    assert.equal(response.metric, 'count');
    assert.equal(response.group_by_time, 'received_at');
    assert.equal(response.granularity, 'day');
    assert.equal(response.time_zone, 'UTC');
    assert.equal(response.filtered_record_count, 4);
    assert.deepEqual(response.groups, [{ key: '2026-05-18', count: 4 }]);
  });
});

test('aggregateRecordsAcrossBindings rejects exact count_distinct across multiple connections', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    await assert.rejects(
      () => aggregateRecordsAcrossBindings(
        bindings,
        STREAM,
        grant,
        { metric: 'count_distinct', field: 'subject' },
        baseManifest,
      ),
      (err) => err.code === 'invalid_request'
        && /scope with connection_id/.test(err.message),
    );
  });
});

// ─── Streams list fan-in ───────────────────────────────────────────────────

test('listStreamsAcrossBindings emits one summary per (stream, connection_id)', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const summaries = await listStreamsAcrossBindings(bindings, grant, baseManifest);
    assert.equal(summaries.length, 2);
    const ids = summaries.map((s) => s.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
    for (const summary of summaries) {
      assert.equal(summary.name, STREAM);
      assert.equal(summary.connector_instance_id, summary.connection_id);
      assert.ok(['Account A', 'Account B'].includes(summary.display_name));
    }
  });
});

// ─── Owner-mode setDisplayName ─────────────────────────────────────────────

test('store.setDisplayName updates the display_name and rejects empty / non-owner / missing', async () => {
  await withSingleConnectionDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    const updated = await store.setDisplayName(INSTANCE_A, {
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      displayName: 'My Renamed Account',
    });
    assert.equal(updated.displayName, 'My Renamed Account');

    assert.throws(
      () => store.setDisplayName(INSTANCE_A, {
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        displayName: '   ',
      }),
      (err) => err.code === 'invalid_request' && err.param === 'display_name',
    );

    assert.throws(
      () => store.setDisplayName('cin_missing_instance', {
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        displayName: 'X',
      }),
      (err) => err.code === 'connector_instance_not_found',
    );

    // Owner mismatch: a different subject id must not be able to rename.
    assert.throws(
      () => store.setDisplayName(INSTANCE_A, {
        ownerSubjectId: 'someone_else',
        displayName: 'Stolen',
      }),
      (err) => err.code === 'connector_instance_not_found',
    );
  });
});

test('renamed display_name surfaces on the next records-list fan-in response', async () => {
  await withDualConnectionDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    await store.setDisplayName(INSTANCE_B, {
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      displayName: 'Account B (Personal)',
    });

    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    const fromB = response.data.find((r) => r.connection_id === INSTANCE_B);
    assert.equal(fromB?.display_name, 'Account B (Personal)');
  });
});

// ─── Alias compatibility regression (re-pinned for this tranche) ───────────

test('validateConnectionAlias accepts canonical, accepts alias, rejects conflicts', () => {
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: 'cin_x' }));
  assert.doesNotThrow(() => validateConnectionAlias({ connector_instance_id: 'cin_x' }));
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: 'cin_x', connector_instance_id: 'cin_x' }));
  assert.throws(
    () => validateConnectionAlias({ connection_id: 'cin_x', connector_instance_id: 'cin_y' }),
    (err) => err.code === 'invalid_argument' && err.param === 'connector_instance_id',
  );
});

// ─── Owner-review revision: P1/P2/P3 regression coverage ───────────────────
//
// All tests below pin the fan-in-branch-revision behavior the owner-review
// memo at `tmp/workstreams/fan-in-branch-owner-review-report.md` flagged.
// The corresponding fixes live in `server/records.js` (helpers) and
// `server/index.js` (route adapters).

test('queryRecordsAcrossBindings rejects changes_since under multi-binding fan-in with retry guidance', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(bindings.length, 2);
    await assert.rejects(
      () => queryRecordsAcrossBindings(bindings, STREAM, grant, { changes_since: 'beginning' }, baseManifest),
      (err) => {
        assert.equal(err.code, 'invalid_argument');
        assert.equal(err.param, 'changes_since');
        assert.equal(err.retry_with, 'connection_id');
        assert.ok(Array.isArray(err.available_connections), 'expected available_connections list');
        const ids = err.available_connections.map((c) => c.connection_id).sort();
        assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
        return true;
      },
    );
  });
});

test('queryRecordsAcrossBindings honors changes_since on the single-binding fast path', async () => {
  await withSingleConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(bindings.length, 1);
    const response = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { changes_since: 'beginning' },
      baseManifest,
    );
    assert.equal(response.object, 'list');
    assert.ok(typeof response.next_changes_since === 'string' && response.next_changes_since.length > 0,
      'single-binding changes_since must still emit a forward-progress cursor');
  });
});

test('queryRecordsAcrossBindings emits partial_results warning when fan-in collapses pagination', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    // limit=1 forces each binding to report has_more=true so the fan-in
    // wrapper must surface the partial-results warning instead of
    // silently dropping the cursor.
    const response = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { limit: 1 },
      baseManifest,
    );
    assert.equal(response.has_more, true);
    assert.equal(response.next_cursor, undefined,
      'multi-binding fan-in must NOT synthesize next_cursor');
    const warnings = response.meta?.warnings || [];
    const partial = warnings.find((w) => w.code === 'partial_results');
    assert.ok(partial, `expected partial_results warning, got ${JSON.stringify(warnings)}`);
    assert.equal(partial.param, 'connection_id');
  });
});

test('queryRecordsAcrossBindings sums exact counts honestly across bindings', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { count: 'exact' },
      baseManifest,
    );
    assert.equal(response.data.length, 4);
    assert.deepEqual(response.meta?.count, { kind: 'exact', value: 4 },
      'multi-binding count=exact must sum per-binding exact counts, not echo whichever ran last');
  });
});

test('queryRecordsAcrossBindings threads resolver warnings (deprecated alias) into multi-binding meta.warnings', async () => {
  await withDualConnectionDb(async () => {
    const { bindings, warnings } = await resolveReadRequestBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      storageBinding: { connector_id: CONNECTOR_ID },
      grant,
      requestParams: {},
      streamName: STREAM,
    });
    // Simulate the route's deprecated-alias resolver warnings being
    // threaded into the helper. The two-binding fan-in path strips
    // connection_id/alias per-binding, so without this thread-through the
    // warning would be lost.
    const fakeAliasWarning = {
      code: 'deprecated_alias_used',
      param: 'connector_instance_id',
      message: '`connector_instance_id` is deprecated; send `connection_id` instead.',
    };
    const response = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      {},
      baseManifest,
      { extraWarnings: [...warnings, fakeAliasWarning] },
    );
    const surfaced = (response.meta?.warnings || []).find((w) => w.code === 'deprecated_alias_used');
    assert.ok(surfaced,
      `deprecated_alias_used warning must surface on multi-binding fan-in; got ${JSON.stringify(response.meta?.warnings)}`);
  });
});

test('aggregateRecordsAcrossBindings threads resolver warnings into multi-binding meta.warnings', async () => {
  await withDualConnectionDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await aggregateRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { metric: 'count' },
      baseManifest,
      { extraWarnings: [
        {
          code: 'deprecated_alias_used',
          param: 'connector_instance_id',
          message: '`connector_instance_id` is deprecated; send `connection_id` instead.',
        },
      ] },
    );
    const surfaced = (response.meta?.warnings || []).find((w) => w.code === 'deprecated_alias_used');
    assert.ok(surfaced,
      `aggregate fan-in must carry deprecated_alias_used; got ${JSON.stringify(response.meta?.warnings)}`);
  });
});

test('listStreamsAcrossBindings honors per-stream grant connection_id when resolver is supplied', async () => {
  // Two-stream grant where each stream pins a different connection_id.
  // Without per-stream resolution, the route would resolve bindings for
  // grant.streams[0] only and count stream B against binding A's storage.
  await withDualConnectionDb(async () => {
    // Re-seed: add a second stream "tasks" so each connection has its own
    // records under different streams. We seed records via direct ingest
    // for both streams.
    const tasksStream = 'tasks';
    const taskManifest = {
      ...baseManifest,
      streams: [
        ...baseManifest.streams,
        {
          name: tasksStream,
          primary_key: ['id'],
          cursor_field: 'received_at',
          consent_time_field: 'received_at',
          schema: {
            type: 'object',
            required: ['id', 'received_at'],
            properties: {
              id: { type: 'string' },
              received_at: { type: 'string', format: 'date-time' },
            },
          },
          query: { aggregations: { count: true } },
        },
      ],
    };
    // Records exist on both connections for `messages`; add tasks-specific
    // records only on connection B so we can detect mis-counted fan-in.
    await ingestRecord(target(INSTANCE_B), {
      stream: tasksStream,
      key: 'task-1',
      data: { id: 'task-1', received_at: '2026-05-19T00:00:00.000Z' },
      emitted_at: '2026-05-19T00:00:00.000Z',
    });

    // Pinned grant: messages → connection A, tasks → connection B.
    const pinnedGrant = {
      streams: [
        { name: STREAM, fields: ['id', 'subject', 'received_at'], connection_id: INSTANCE_A },
        { name: tasksStream, fields: ['id', 'received_at'], connection_id: INSTANCE_B },
      ],
    };

    // Sanity: the default-resolver shape (no per-stream resolver) would
    // resolve bindings against firstStream=messages → connection A only,
    // miss the tasks records on connection B, and emit zero entries for
    // tasks. The per-stream resolver path must show both summaries with
    // honest counts.
    const ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID;
    const resolverFor = async (streamGrant) => {
      const { bindings } = await resolveReadRequestBindings({
        ownerSubjectId,
        storageBinding: { connector_id: CONNECTOR_ID },
        grant: pinnedGrant,
        requestParams: {},
        streamName: streamGrant.name,
      });
      return bindings;
    };
    const firstStreamBindings = await resolverFor({ name: STREAM });
    const summaries = await listStreamsAcrossBindings(
      firstStreamBindings,
      pinnedGrant,
      taskManifest,
      { resolveBindingsForStream: resolverFor },
    );
    const messagesA = summaries.find((s) => s.name === STREAM && s.connection_id === INSTANCE_A);
    const tasksB = summaries.find((s) => s.name === tasksStream && s.connection_id === INSTANCE_B);
    assert.ok(messagesA, `expected messages@A summary; got ${JSON.stringify(summaries)}`);
    assert.ok(tasksB, `expected tasks@B summary; got ${JSON.stringify(summaries)}`);
    assert.equal(tasksB.record_count, 1,
      'tasks records under connection B must be counted from B, not borrowed from A');

    // Cross-validation: there should be NO tasks summary under connection A
    // because A is not authorized to read tasks.
    const tasksA = summaries.find((s) => s.name === tasksStream && s.connection_id === INSTANCE_A);
    assert.equal(tasksA, undefined,
      'tasks must not surface under A when grant pins tasks → B');
  });
});
