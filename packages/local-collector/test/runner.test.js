import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

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
  LocalDeviceOutbox,
  getBundledConnector,
} from '../src/runner.ts';
import {
  buildLocalOutboxDoctor,
  inspectLocalOutboxStatus,
  parseArgs,
} from '../bin/pdpp-local-collector.ts';
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

test('runner exports the durable local outbox substrate without private package imports', () => {
  assert.equal(typeof LocalDeviceOutbox, 'function');
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

test('local collector status reports aggregate durable outbox health without payloads', async () => {
  const path = await tempOutboxPath();
  let now = new Date('2026-05-19T12:00:00.000Z');
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    outbox.enqueue({
      id: 'pending-secret-id',
      kind: 'record_batch',
      payload: { secret: 'do-not-print', token: 'nope' },
      sourceInstanceId: 'src-1',
    });
    outbox.enqueue({
      id: 'leased-secret-id',
      kind: 'checkpoint',
      payload: { private: 'leased-payload' },
      sourceInstanceId: 'src-1',
    });
    const [leased] = outbox.claimReady({ holder: 'worker-a', leaseMs: 1000, sourceInstanceId: 'src-1' });
    assert.ok(leased);
    now = new Date('2026-05-19T12:00:02.000Z');

    const status = inspectLocalOutboxStatus({
      baseUrl: 'http://127.0.0.1:7662',
      command: 'status',
      deviceId: 'device-1',
      deviceToken: 'device-token-secret',
      queuePath: path,
      sourceInstanceId: 'src-1',
    });

    assert.equal(status.db.path, path);
    assert.equal(status.db.exists, true);
    assert.equal(status.configured_device.device_id_configured, true);
    assert.equal(status.configured_device.device_token_configured, true);
    assert.deepEqual(status.outbox.counts, {
      dead_letter: 0,
      leased: 1,
      pending: 1,
      retrying: 0,
      sent: 0,
      total: 2,
    });
    assert.equal(status.outbox.expired_leases, 1);
    assert.equal(status.outbox.oldest_pending_at, '2026-05-19T12:00:00.000Z');

    const rendered = JSON.stringify(status);
    assert.doesNotMatch(rendered, /do-not-print|device-token-secret|leased-payload|pending-secret-id|leased-secret-id/);
  } finally {
    outbox.close();
  }
});

test('local collector doctor flags missing db, expired leases, and dead letters', async () => {
  const missing = inspectLocalOutboxStatus(parseArgs(['doctor', '--queue', join(await tempDir(), 'missing.sqlite')]));
  const missingDoctor = buildLocalOutboxDoctor(missing);
  assert.equal(missingDoctor.checks.outbox_db, 'missing');
  assert.equal(missingDoctor.status, 'warning');

  const path = await tempOutboxPath();
  let now = new Date('2026-05-19T12:00:00.000Z');
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    outbox.enqueue({
      id: 'dead-letter-id',
      kind: 'gap',
      payload: { secret: 'dead-letter-payload' },
      sourceInstanceId: 'src-1',
    });
    const [claim] = outbox.claimReady({ holder: 'worker-a', leaseMs: 60_000, sourceInstanceId: 'src-1' });
    assert.ok(claim);
    outbox.deadLetter({
      error: 'bounded error',
      holder: 'worker-a',
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });

    outbox.enqueue({
      id: 'expired-lease-id',
      kind: 'checkpoint',
      payload: { secret: 'expired-lease-payload' },
      sourceInstanceId: 'src-1',
    });
    outbox.claimReady({ holder: 'worker-a', leaseMs: 1000, sourceInstanceId: 'src-1' });
    outbox.enqueue({
      id: 'retrying-id',
      kind: 'record_batch',
      nextAttemptAt: new Date('2099-05-19T12:05:00.000Z'),
      payload: { secret: 'retrying-payload' },
      sourceInstanceId: 'src-1',
    });
    now = new Date('2026-05-19T12:00:02.000Z');

    const doctor = buildLocalOutboxDoctor(
      inspectLocalOutboxStatus({
        baseUrl: 'http://127.0.0.1:7662',
        command: 'doctor',
        queuePath: path,
        sourceInstanceId: 'src-1',
      })
    );

    assert.equal(doctor.status, 'critical');
    assert.deepEqual(doctor.checks, {
      expired_leases: 'warn',
      outbox_db: 'ok',
      outbox_failures: 'fail',
    });
    assert.equal(doctor.outbox.counts.dead_letter, 1);
    assert.equal(doctor.outbox.counts.retrying, 1);
    assert.equal(doctor.outbox.expired_leases, 1);
    assert.doesNotMatch(
      JSON.stringify(doctor),
      /dead-letter-payload|expired-lease-payload|retrying-payload|dead-letter-id|expired-lease-id|retrying-id/
    );
  } finally {
    outbox.close();
  }
});

async function tempOutboxPath() {
  return join(await tempDir(), 'outbox.sqlite');
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'pdpp-local-collector-test-'));
}
