import assert from 'node:assert/strict';
import { test } from 'node:test';

// Use a tsx-loader-style import indirectly: the runner module is .ts, so
// these tests exercise the same path the bin uses. Node 22+ supports
// loading .ts via tsx; the package's `verify` script runs with the
// monorepo's tsx loader.
import {
  BUNDLED_CONNECTOR_IDS,
  BUNDLED_CONNECTOR_VERSIONS,
  BUNDLED_CONNECTORS,
  COLLECTOR_PROTOCOL_VERSION,
  COLLECTOR_RUNTIME_CAPABILITIES,
  getBundledConnector,
} from '../src/runner.ts';
import {
  ALLOW_CUSTOM_COMMAND_ENV,
  CollectorCustomCommandRefusedError,
  CollectorUsageError,
} from '../src/errors.ts';

test('runner exports the collector runtime capability profile with collector id', () => {
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.id, 'collector');
  const bindings = [...COLLECTOR_RUNTIME_CAPABILITIES.bindings].sort();
  assert.deepEqual(bindings, ['filesystem', 'local_device', 'network']);
});

test('runner exports a stable COLLECTOR_PROTOCOL_VERSION string', () => {
  assert.equal(typeof COLLECTOR_PROTOCOL_VERSION, 'string');
  assert.match(COLLECTOR_PROTOCOL_VERSION, /^\d+$/);
});

test('bundled connectors registry contains claude_code and codex only', () => {
  assert.deepEqual([...BUNDLED_CONNECTOR_IDS].sort(), ['claude_code', 'codex']);
  assert.ok(BUNDLED_CONNECTORS.claude_code);
  assert.ok(BUNDLED_CONNECTORS.codex);
});

test('bundled connector entries declare filesystem binding as required', () => {
  for (const id of BUNDLED_CONNECTOR_IDS) {
    const entry = getBundledConnector(id);
    assert.ok(entry, `entry for ${id}`);
    assert.equal(entry.connector_id, id);
    assert.equal(entry.bindings.filesystem?.required, true);
    assert.ok(Array.isArray(entry.streams) && entry.streams.length > 0);
  }
});

test('bundled connector versions map covers every bundled id', () => {
  for (const id of BUNDLED_CONNECTOR_IDS) {
    assert.equal(typeof BUNDLED_CONNECTOR_VERSIONS[id], 'string');
  }
});

test('getBundledConnector returns null for non-bundled ids', () => {
  assert.equal(getBundledConnector('gmail'), null);
  assert.equal(getBundledConnector('whatever'), null);
});

test('CollectorUsageError carries an exit code', () => {
  const err = new CollectorUsageError('bad usage');
  assert.equal(err.exitCode, 64);
  assert.equal(err.name, 'CollectorUsageError');

  const overridden = new CollectorUsageError('bad usage', { exitCode: 65 });
  assert.equal(overridden.exitCode, 65);
});

test('CollectorCustomCommandRefusedError names the opt-in env var', () => {
  const err = new CollectorCustomCommandRefusedError();
  assert.equal(err.code, 'custom_command_refused');
  assert.match(err.message, new RegExp(ALLOW_CUSTOM_COMMAND_ENV));
});
