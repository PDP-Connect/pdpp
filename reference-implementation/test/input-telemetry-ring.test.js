// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the streaming input-telemetry ring buffer in
// server/streaming/input-telemetry.ts. No test imports this module by name.
// It is an in-process, bounded, per-session ring used by the streaming companion
// debug surface; its monotonic-seq + since-cursor + fixed-size-eviction semantics
// are what the viewer's incremental polling relies on.
//
// Mutation surface:
//   push      -- monotonic seq (starts at 1, increments), serverAtMs stamp,
//     ring eviction when records.length > bufferSize (oldest dropped), guards on
//     falsy session id / non-object record.
//   readSince -- returns only records with seq STRICTLY > since, plus the current
//     high-water seq; unknown session -> empty; non-finite since -> treated as 0.
//   drop      -- forgets a session's buffer.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createInputTelemetry } from '../server/streaming/input-telemetry.ts';

test('push: assigns a monotonic seq starting at 1 and stamps serverAtMs', () => {
  const t = createInputTelemetry();
  const a = t.push('sess', { kind: 'received' });
  const b = t.push('sess', { kind: 'dispatched' });
  assert.equal(a.seq, 1, 'first seq is 1');
  assert.equal(b.seq, 2, 'seq increments');
  assert.equal(typeof a.serverAtMs, 'number', 'serverAtMs stamped');
  assert.equal(a.kind, 'received', 'caller record fields preserved');
});

test('push: ignores falsy session id or non-object record (never throws)', () => {
  const t = createInputTelemetry();
  assert.equal(t.push('', { k: 1 }), undefined, 'empty session id ignored');
  assert.equal(t.push('sess', null), undefined, 'null record ignored');
  assert.equal(t.push('sess', 'string'), undefined, 'non-object record ignored');
  // none of the above should have created a buffer / advanced seq
  assert.deepEqual(t.readSince('sess', 0), { seq: 0, records: [] });
});

test('push: seq is per-session (independent counters)', () => {
  const t = createInputTelemetry();
  t.push('A', { k: 1 });
  t.push('A', { k: 2 });
  const b1 = t.push('B', { k: 1 });
  assert.equal(b1.seq, 1, 'session B starts its own seq at 1');
  assert.equal(t.readSince('A', 0).seq, 2, 'session A high-water is 2');
});

test('push: ring evicts oldest when the buffer exceeds bufferSize; seq keeps climbing', () => {
  const t = createInputTelemetry({ bufferSize: 3 });
  for (let i = 1; i <= 5; i += 1) t.push('sess', { i });
  const { seq, records } = t.readSince('sess', 0);
  assert.equal(seq, 5, 'high-water seq reflects all 5 pushes');
  assert.equal(records.length, 3, 'only the last bufferSize records are retained');
  assert.deepEqual(records.map((r) => r.i), [3, 4, 5], 'oldest (1,2) evicted, newest kept in order');
  assert.deepEqual(records.map((r) => r.seq), [3, 4, 5], 'retained records keep their original seq');
});

test('readSince: returns only records with seq STRICTLY greater than `since`', () => {
  const t = createInputTelemetry();
  for (let i = 1; i <= 4; i += 1) t.push('sess', { i });
  const afterTwo = t.readSince('sess', 2);
  assert.deepEqual(afterTwo.records.map((r) => r.seq), [3, 4], 'since=2 excludes seq 2 (strict >)');
  assert.equal(afterTwo.seq, 4, 'high-water seq returned regardless of the since filter');
  const afterAll = t.readSince('sess', 4);
  assert.deepEqual(afterAll.records, [], 'since at the high-water yields no records');
});

test('readSince: unknown session yields an empty, zero-seq window', () => {
  const t = createInputTelemetry();
  assert.deepEqual(t.readSince('never', 0), { seq: 0, records: [] });
});

test('readSince: non-finite `since` is treated as 0 (returns everything)', () => {
  const t = createInputTelemetry();
  t.push('sess', { i: 1 });
  t.push('sess', { i: 2 });
  const out = t.readSince('sess', Number.NaN);
  assert.deepEqual(out.records.map((r) => r.seq), [1, 2], 'NaN since -> from the start');
});

test('drop: forgets a session buffer (subsequent read is empty)', () => {
  const t = createInputTelemetry();
  t.push('sess', { i: 1 });
  assert.equal(t.readSince('sess', 0).records.length, 1);
  t.drop('sess');
  assert.deepEqual(t.readSince('sess', 0), { seq: 0, records: [] }, 'dropped session reads empty');
});
