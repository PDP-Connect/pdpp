// Pure-logic oracle for the query_records/read response-envelope shapers in
// server/record-query-helpers.ts: mergeMetaCount, mergeMetaWindow,
// attachRequestWarningsToResponse, and decorateRecordWithConnectionIdentity.
// These assemble the public `meta.count` / `meta.window` / `meta.warnings`
// envelope and the per-record connection identity that SQLite and Postgres paths
// must produce identically. All pure, all previously untested by name. A
// mutation that clobbered a sibling meta member or dropped the connection alias
// would silently break the response contract. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeMetaCount,
  mergeMetaWindow,
  attachRequestWarningsToResponse,
  decorateRecordWithConnectionIdentity,
} from '../server/record-query-helpers.ts';

test('mergeMetaCount sets count while preserving other meta members', () => {
  assert.deepEqual(mergeMetaCount(null, { kind: 'exact', value: 5 }), { count: { kind: 'exact', value: 5 } });
  assert.deepEqual(
    mergeMetaCount({ warnings: ['w'], window: { x: 1 } }, { kind: 'exact', value: 5 }),
    { warnings: ['w'], window: { x: 1 }, count: { kind: 'exact', value: 5 } }
  );
  // A non-object (array) existing meta is treated as an empty base.
  assert.deepEqual(mergeMetaCount(['bad'], { kind: 'exact', value: 5 }), { count: { kind: 'exact', value: 5 } });
});

test('mergeMetaWindow sets window while preserving count and other members', () => {
  assert.deepEqual(mergeMetaWindow({ count: { v: 1 } }, { kind: 'exact' }), { count: { v: 1 }, window: { kind: 'exact' } });
});

test('attachRequestWarningsToResponse appends warnings after existing ones and no-ops on empties', () => {
  const fresh = { data: [] };
  attachRequestWarningsToResponse(fresh, [{ code: 'w1' }]);
  assert.deepEqual(fresh.meta, { warnings: [{ code: 'w1' }] });

  const withExisting = { meta: { warnings: [{ code: 'old' }], count: 5 } };
  attachRequestWarningsToResponse(withExisting, [{ code: 'new' }]);
  // Old warnings first, then new; count is preserved.
  assert.deepEqual(withExisting.meta, { warnings: [{ code: 'old' }, { code: 'new' }], count: 5 });

  // Empty warnings => response untouched (no meta added).
  const noWarn = { data: [] };
  attachRequestWarningsToResponse(noWarn, []);
  assert.deepEqual(noWarn, { data: [] });

  // A non-object response is a safe no-op.
  assert.doesNotThrow(() => attachRequestWarningsToResponse(null, [{ code: 'x' }]));
});

test('decorateRecordWithConnectionIdentity sets connection_id, the alias, and display_name (trimmed)', () => {
  const record = { id: 'r1' };
  decorateRecordWithConnectionIdentity(record, { connectionId: 'c1', displayName: 'My Src' });
  assert.equal(record.connection_id, 'c1');
  assert.equal(record.connector_instance_id, 'c1'); // deprecated alias carries the same value
  assert.equal(record.display_name, 'My Src');
});

test('decorateRecordWithConnectionIdentity skips a blank connection id and a null identity', () => {
  const blank = { id: 'r2' };
  decorateRecordWithConnectionIdentity(blank, { connectionId: '  ' });
  assert.ok(!('connection_id' in blank));

  const noIdentity = { id: 'r3' };
  decorateRecordWithConnectionIdentity(noIdentity, null);
  assert.deepEqual(noIdentity, { id: 'r3' });
});
