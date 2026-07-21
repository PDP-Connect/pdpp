// Unit tests for the process-local remote-telemetry sink registry
// (server/streaming/remote-telemetry-registry.ts).
//
// The registry is stateful but deterministic: register returns an unsubscribe
// that removes the callback (and prunes the empty set); emit fans a payload to
// every registered sink and swallows any sink throw so a page-side binding can
// never crash the process; drop clears a runId. Each guard/branch is pinned
// below. Tests use unique runIds and always clean up so the shared Map stays
// isolated between cases.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  dropRemoteTelemetry,
  emitRemoteTelemetry,
  registerRemoteTelemetrySink,
} from '../server/streaming/remote-telemetry-registry.ts';

test('register + emit delivers the payload to the registered sink', () => {
  const runId = 'run-deliver';
  const received = [];
  const unsub = registerRemoteTelemetrySink(runId, (p) => received.push(p));
  emitRemoteTelemetry(runId, { a: 1 });
  emitRemoteTelemetry(runId, { a: 2 });
  assert.deepEqual(received, [{ a: 1 }, { a: 2 }]);
  unsub();
});

test('emit fans out to every sink registered for a runId', () => {
  const runId = 'run-fanout';
  const first = [];
  const second = [];
  const u1 = registerRemoteTelemetrySink(runId, (p) => first.push(p));
  const u2 = registerRemoteTelemetrySink(runId, (p) => second.push(p));
  emitRemoteTelemetry(runId, 'x');
  assert.deepEqual(first, ['x']);
  assert.deepEqual(second, ['x']);
  u1();
  u2();
});

test('the returned unsubscribe removes only its own callback', () => {
  const runId = 'run-unsub';
  const kept = [];
  const dropped = [];
  const uKeep = registerRemoteTelemetrySink(runId, (p) => kept.push(p));
  const uDrop = registerRemoteTelemetrySink(runId, (p) => dropped.push(p));
  uDrop();
  emitRemoteTelemetry(runId, 'after-drop');
  assert.deepEqual(kept, ['after-drop']);
  assert.deepEqual(dropped, []); // dropped sink no longer receives
  uKeep();
});

test('emit is a no-op after the last sink unsubscribes (empty set pruned)', () => {
  const runId = 'run-empty';
  const received = [];
  const unsub = registerRemoteTelemetrySink(runId, (p) => received.push(p));
  unsub();
  // No throw and nothing delivered once the set is empty/pruned.
  assert.doesNotThrow(() => emitRemoteTelemetry(runId, 'ignored'));
  assert.deepEqual(received, []);
});

test('register rejects a falsy runId or non-function callback with a no-op unsubscribe', () => {
  const noopA = registerRemoteTelemetrySink('', () => {});
  const noopB = registerRemoteTelemetrySink('run-x', 'not-a-function');
  const noopC = registerRemoteTelemetrySink(null, () => {});
  // Each returns a callable no-op that does not throw.
  assert.equal(typeof noopA, 'function');
  assert.doesNotThrow(() => noopA());
  assert.doesNotThrow(() => noopB());
  assert.doesNotThrow(() => noopC());
  // And nothing was registered for 'run-x'.
  const received = [];
  const unsub = registerRemoteTelemetrySink('run-x', (p) => received.push(p));
  emitRemoteTelemetry('run-x', 'v');
  assert.deepEqual(received, ['v']); // only the real sink fires
  unsub();
});

test('emit swallows a throwing sink and still reaches the others', () => {
  const runId = 'run-throws';
  const good = [];
  const uBad = registerRemoteTelemetrySink(runId, () => {
    throw new Error('page-side boom');
  });
  const uGood = registerRemoteTelemetrySink(runId, (p) => good.push(p));
  assert.doesNotThrow(() => emitRemoteTelemetry(runId, 'payload'));
  assert.deepEqual(good, ['payload']); // good sink still received despite the throw
  uBad();
  uGood();
});

test('emit on an unknown runId is a no-op', () => {
  assert.doesNotThrow(() => emitRemoteTelemetry('never-registered', {}));
});

test('drop removes all sinks for a runId', () => {
  const runId = 'run-drop';
  const received = [];
  registerRemoteTelemetrySink(runId, (p) => received.push(p));
  dropRemoteTelemetry(runId);
  emitRemoteTelemetry(runId, 'after-drop');
  assert.deepEqual(received, []);
});
