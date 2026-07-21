// Pure, no-DB unit tests for the process-local remote-telemetry sink registry in
// server/streaming/remote-telemetry-registry.ts. No test imports this module by
// name. It is a module-level singleton (the `sinks` Map is shared), so each test
// uses a UNIQUE runId to stay isolated.
//
// Mutation surface:
//   registerRemoteTelemetrySink -- returns an unsubscribe fn; guards falsy runId /
//     non-function callback with a no-op unsubscribe; multiple callbacks per runId;
//     unsubscribe deletes only its own callback and prunes the empty set.
//   emitRemoteTelemetry -- fans a payload out to every registered callback for the
//     runId and SWALLOWS callback throws (never re-enters the page binding).
//   dropRemoteTelemetry -- forgets a runId's sinks entirely.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dropRemoteTelemetry,
  emitRemoteTelemetry,
  registerRemoteTelemetrySink,
} from '../server/streaming/remote-telemetry-registry.ts';

let counter = 0;
function uniqueRunId(label) {
  counter += 1;
  return `run-${label}-${counter}-${Math.random().toString(36).slice(2)}`;
}

test('register + emit: a registered callback receives the payload', () => {
  const runId = uniqueRunId('basic');
  const received = [];
  registerRemoteTelemetrySink(runId, (p) => received.push(p));
  emitRemoteTelemetry(runId, { event: 'click' });
  assert.deepEqual(received, [{ event: 'click' }]);
  dropRemoteTelemetry(runId);
});

test('emit: fans out to EVERY callback registered for the runId', () => {
  const runId = uniqueRunId('fanout');
  const a = [];
  const b = [];
  registerRemoteTelemetrySink(runId, (p) => a.push(p));
  registerRemoteTelemetrySink(runId, (p) => b.push(p));
  emitRemoteTelemetry(runId, { n: 1 });
  assert.deepEqual(a, [{ n: 1 }], 'first callback fired');
  assert.deepEqual(b, [{ n: 1 }], 'second callback fired');
  dropRemoteTelemetry(runId);
});

test('unsubscribe: removes only its own callback, leaving siblings live', () => {
  const runId = uniqueRunId('unsub');
  const a = [];
  const b = [];
  const offA = registerRemoteTelemetrySink(runId, (p) => a.push(p));
  registerRemoteTelemetrySink(runId, (p) => b.push(p));
  offA();
  emitRemoteTelemetry(runId, { n: 2 });
  assert.deepEqual(a, [], 'unsubscribed callback no longer fires');
  assert.deepEqual(b, [{ n: 2 }], 'sibling callback still fires');
  dropRemoteTelemetry(runId);
});

test('emit: no registered sink is a silent no-op (does not throw)', () => {
  const runId = uniqueRunId('empty');
  assert.doesNotThrow(() => emitRemoteTelemetry(runId, { anything: true }));
});

test('emit: a throwing callback is swallowed and does not block sibling callbacks', () => {
  const runId = uniqueRunId('throw');
  const delivered = [];
  registerRemoteTelemetrySink(runId, () => {
    throw new Error('page-side callback blew up');
  });
  registerRemoteTelemetrySink(runId, (p) => delivered.push(p));
  assert.doesNotThrow(() => emitRemoteTelemetry(runId, { n: 3 }), 'emit must never re-throw into the page binding');
  assert.deepEqual(delivered, [{ n: 3 }], 'a later callback still receives the payload after an earlier throw');
  dropRemoteTelemetry(runId);
});

test('register: falsy runId or non-function callback returns a no-op unsubscribe and registers nothing', () => {
  const off1 = registerRemoteTelemetrySink('', () => {});
  const off2 = registerRemoteTelemetrySink(uniqueRunId('badcb'), 'not-a-function');
  assert.equal(typeof off1, 'function', 'still returns a callable unsubscribe');
  assert.equal(typeof off2, 'function');
  assert.doesNotThrow(() => {
    off1();
    off2();
  }, 'the no-op unsubscribe is safe to call');
});

test('unsubscribe after drop is safe (registry already pruned)', () => {
  const runId = uniqueRunId('dropfirst');
  const off = registerRemoteTelemetrySink(runId, () => {});
  dropRemoteTelemetry(runId);
  assert.doesNotThrow(() => off(), 'unsubscribe tolerates an already-dropped runId');
});

test('drop: forgets all sinks for a runId so subsequent emit is a no-op', () => {
  const runId = uniqueRunId('drop');
  const got = [];
  registerRemoteTelemetrySink(runId, (p) => got.push(p));
  dropRemoteTelemetry(runId);
  emitRemoteTelemetry(runId, { after: 'drop' });
  assert.deepEqual(got, [], 'dropped runId delivers nothing');
});
