import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  buildLocalDeviceOutboxId,
  getBundledConnector,
} from '../src/runner.ts';
import {
  buildConnectorSpec,
  buildLocalOutboxDoctor,
  inspectLocalOutboxStatus,
  parseArgs,
  resolveLocalCollectorPackageVersion,
  retryLocalOutboxDeadLetters,
  scopedDefaultQueuePath,
  summarizeRunResultForCli,
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

test('local collector CLI resolves the installed package manifest version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdpp-local-collector-version-'));
  const binPath = join(root, 'dist', 'local-collector', 'bin', 'pdpp-local-collector.js');
  await mkdir(join(root, 'dist', 'local-collector', 'bin'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: '@pdpp/local-collector', version: '0.1.0-beta.99' })
  );

  assert.equal(resolveLocalCollectorPackageVersion(binPath), '0.1.0-beta.99');
});

test('local collector package no longer ships the temporary legacy JSON queue migration bridge', async () => {
  const files = [
    '../tsconfig.build.json',
    '../scripts/postbuild.mjs',
    '../src/runner.ts',
    '../../polyfill-connectors/src/runner/index.ts',
  ];

  for (const file of files) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /local-device-queue-migration|LegacyLocalDeviceQueue|importLegacyLocalDeviceQueue|inspectLegacyLocalDeviceQueue/);
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
    assert.deepEqual(status.source, {
      connection_id: 'src-1',
      source_instance_id: 'src-1',
    });
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

    // When dead letters are present, doctor points the operator at the
    // recovery primitive (dry-run preview, then --apply with backup).
    assert.ok(Array.isArray(doctor.remediation));
    assert.equal(doctor.remediation.length, 1);
    assert.match(doctor.remediation[0], /retry-dead-letters/);
    assert.match(doctor.remediation[0], /--apply/);
  } finally {
    outbox.close();
  }
});

test('local collector doctor omits remediation when the outbox is healthy', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: 'healthy-id',
      kind: 'record_batch',
      payload: { ok: true },
      sourceInstanceId: 'src-1',
    });
    const doctor = buildLocalOutboxDoctor(
      inspectLocalOutboxStatus({
        baseUrl: 'http://127.0.0.1:7662',
        command: 'doctor',
        queuePath: path,
        sourceInstanceId: 'src-1',
      })
    );
    assert.equal(doctor.checks.outbox_failures, 'ok');
    assert.equal(doctor.remediation, undefined);
  } finally {
    outbox.close();
  }
});

test('local collector retry-dead-letters is dry-run by default and backs up before apply', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: 'dead-letter-id',
      kind: 'record_batch',
      payload: { secret: 'dead-letter-payload' },
      sourceInstanceId: 'src-1',
    });
    const [claim] = outbox.claimReady({ holder: 'worker-a', leaseMs: 60_000, sourceInstanceId: 'src-1' });
    assert.ok(claim);
    outbox.deadLetter({
      error: 'terminal',
      holder: 'worker-a',
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });
  } finally {
    outbox.close();
  }

  const parsed = parseArgs([
    'retry-dead-letters',
    '--queue', path,
    '--connection-id', 'src-1',
    '--kind', 'record_batch',
    '--limit', '10',
  ]);
  assert.equal(parsed.apply, undefined);
  assert.equal(parsed.deadLetterKind, 'record_batch');
  assert.equal(parsed.limit, 10);

  const dryRun = retryLocalOutboxDeadLetters(parsed);
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.matched, 1);
  assert.equal(dryRun.requeued, 0);
  assert.equal(dryRun.backup_path, null);
  assert.equal(dryRun.status_before.dead_letter, 1);
  assert.equal(dryRun.status_after.dead_letter, 1);

  const applied = retryLocalOutboxDeadLetters({ ...parsed, apply: true });
  assert.equal(applied.dry_run, false);
  assert.equal(applied.matched, 1);
  assert.equal(applied.requeued, 1);
  assert.ok(applied.backup_path);
  assert.equal(existsSync(applied.backup_path), true);
  assert.equal(applied.status_before.dead_letter, 1);
  assert.equal(applied.status_after.dead_letter, 0);
  assert.equal(applied.status_after.pending, 1);

  const rendered = JSON.stringify(applied);
  assert.doesNotMatch(rendered, /dead-letter-payload|dead-letter-id|terminal/);
});

test('local collector run output summarizes state cursors without dumping payload maps', () => {
  const output = summarizeRunResultForCli({
    done: { records_emitted: 1, status: 'succeeded', type: 'DONE' },
    enqueuedBatches: 1,
    flushedState: {
      messages: {
        fetched_at: '2026-05-20T00:00:00.000Z',
        file_mtimes: {
          '/private/path/a.jsonl': 1,
          '/private/path/b.jsonl': 2,
        },
      },
    },
    outboxSummary: {
      deadLetter: 0,
      leased: 0,
      oldestReadyAt: null,
      ready: 0,
      retrying: 0,
      staleLeases: 0,
      succeeded: 1,
      total: 1,
    },
    priorState: {
      messages: {
        fetched_at: '2026-05-19T00:00:00.000Z',
        file_mtimes: {
          '/private/path/a.jsonl': 1,
        },
      },
    },
    recordsQueued: 1,
    recoveredLeases: 0,
    satisfiedBindings: ['filesystem'],
    sentBatches: 1,
    skippedScanForBacklog: false,
    scanBudgetExceeded: false,
    statePutFailed: false,
    streamingBufferHighWaterMark: 1,
  });

  assert.equal(output.flushedState.streams.messages.file_mtimes_count, 2);
  assert.deepEqual(output.flushedState.streams.messages.keys, ['fetched_at', 'file_mtimes']);
  assert.equal(output.priorState.streams.messages.file_mtimes_count, 1);
  const rendered = JSON.stringify(output);
  assert.equal(rendered.includes('/private/path'), false);
  assert.equal(rendered.includes('a.jsonl'), false);
  assert.equal(rendered.includes('b.jsonl'), false);
});

// --- Connector adoption (tasks 5.1-5.4) ---

test('pdpp-local-collector run --connector claude_code resolves to the bundled durable-outbox entrypoint', () => {
  const options = parseArgs([
    'run',
    '--base-url', 'http://127.0.0.1:7662',
    '--connector', 'claude_code',
    '--device-id', 'device-1',
    '--device-token', 'token-1',
    '--connection-id', 'src-claude',
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, 'claude_code');
  assert.equal(spec.command, BUNDLED_CONNECTORS.claude_code.command);
  assert.deepEqual([...spec.args], [...BUNDLED_CONNECTORS.claude_code.args]);
  assert.deepEqual([...spec.streams].sort(), [...BUNDLED_CONNECTORS.claude_code.streams].sort());
  assert.equal(spec.runtime_requirements.bindings.filesystem?.required, true);
});

test('pdpp-local-collector run reads connector id from PDPP_COLLECTOR_CONNECTOR', () => {
  const previous = process.env.PDPP_COLLECTOR_CONNECTOR;
  process.env.PDPP_COLLECTOR_CONNECTOR = 'claude_code';
  try {
    const options = parseArgs([
      'run',
      '--base-url', 'http://127.0.0.1:7662',
      '--device-id', 'device-1',
      '--device-token', 'token-1',
      '--connection-id', 'src-claude',
    ]);
    const spec = buildConnectorSpec(options);
    assert.equal(spec.connector_id, 'claude_code');
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_COLLECTOR_CONNECTOR;
    } else {
      process.env.PDPP_COLLECTOR_CONNECTOR = previous;
    }
  }
});

test('pdpp-local-collector run --connector codex resolves to the bundled durable-outbox entrypoint', () => {
  const options = parseArgs([
    'run',
    '--base-url', 'http://127.0.0.1:7662',
    '--connector', 'codex',
    '--device-id', 'device-1',
    '--device-token', 'token-1',
    '--connection-id', 'src-codex',
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, 'codex');
  assert.equal(spec.command, BUNDLED_CONNECTORS.codex.command);
  assert.deepEqual([...spec.args], [...BUNDLED_CONNECTORS.codex.args]);
  assert.deepEqual([...spec.streams].sort(), [...BUNDLED_CONNECTORS.codex.streams].sort());
  assert.equal(spec.runtime_requirements.bindings.filesystem?.required, true);
});

test('pdpp-local-collector run refuses unbundled connector ids without the dev opt-in env', () => {
  // Tasks 5.1 / 5.2 / 5.3 are gated by the bundled connector registry. Any
  // non-bundled --connector id must refuse before reaching the durable
  // outbox path, so an arbitrary binary cannot be paired with a device
  // token via the published CLI.
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
  try {
    const options = parseArgs([
      'run',
      '--base-url', 'http://127.0.0.1:7662',
      '--connector', 'gmail',
      '--device-id', 'device-1',
      '--device-token', 'token-1',
      '--connection-id', 'src-1',
    ]);
    assert.throws(() => buildConnectorSpec(options), CollectorUsageError);
  } finally {
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
});

test('pdpp-local-collector run refuses --command <bin> without the dev opt-in env', () => {
  // Even for a bundled connector id, an arbitrary --command override must
  // refuse so the device-token supply chain stays narrow. This is the
  // compatibility flag guard tying 5.1 to the published surface.
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
  try {
    const options = parseArgs([
      'run',
      '--base-url', 'http://127.0.0.1:7662',
      '--connector', 'claude_code',
      '--device-id', 'device-1',
      '--device-token', 'token-1',
      '--connection-id', 'src-claude',
      '--command', '/bin/cat',
    ]);
    assert.throws(() => buildConnectorSpec(options), CollectorCustomCommandRefusedError);
  } finally {
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
});

test('scopedDefaultQueuePath namespaces the default queue path by connection-id', () => {
  // Task 5.4: two distinct connection-ids must resolve to two distinct
  // default outbox paths so concurrent local collection across devices
  // and sources can not collide via a shared SQLite file.
  const defaultPath = '/var/pdpp/.pdpp-data/collector-runner-queue.json';
  const a = scopedDefaultQueuePath(defaultPath, defaultPath, 'src-A');
  const b = scopedDefaultQueuePath(defaultPath, defaultPath, 'src-B');
  assert.notEqual(a, b, 'distinct connection-ids must produce distinct default queue paths');
  assert.ok(a.includes('src-A'), `expected ${a} to encode connection-id`);
  assert.ok(b.includes('src-B'), `expected ${b} to encode connection-id`);
  assert.equal(a.endsWith('.json'), true);
  assert.equal(b.endsWith('.json'), true);

  // An operator-supplied --queue path is honored verbatim (single-tenant case).
  const explicit = '/operator/explicit-queue.sqlite';
  assert.equal(
    scopedDefaultQueuePath(explicit, defaultPath, 'src-A'),
    explicit,
    'operator-supplied queue path must be used as-is'
  );
});

test('scopedDefaultQueuePath encodes path-separator characters in connection-ids', () => {
  // Real connection-ids include separators and unicode; the scoped queue
  // segment must not let one connection-id escape into another's path.
  const defaultPath = '/var/pdpp/.pdpp-data/collector-runner-queue.json';
  const tricky = scopedDefaultQueuePath(defaultPath, defaultPath, '../escape/../etc/passwd');
  assert.equal(tricky.startsWith('/var/pdpp/.pdpp-data/'), true);
  assert.equal(tricky.includes('/../'), false, 'must not include path traversal segments');
});

test('buildLocalDeviceOutboxId namespaces ids by source instance so identical payload parts do not collide', () => {
  // Task 5.4: when the same connector emits the same logical work on two
  // devices / source instances, the durable outbox id must differ. This
  // protects the unique-key constraint on the local outbox row and keeps
  // multi-device local collection collision-safe.
  const partsA = ['claude_code', 1, 'batch-shared-id'];
  const partsB = ['claude_code', 1, 'batch-shared-id'];
  const idA = buildLocalDeviceOutboxId({ kind: 'record_batch', parts: partsA, sourceInstanceId: 'src-A' });
  const idB = buildLocalDeviceOutboxId({ kind: 'record_batch', parts: partsB, sourceInstanceId: 'src-B' });
  assert.notEqual(idA, idB, 'same parts under different source instances must yield different ids');

  // Determinism: same inputs yield byte-identical ids so re-observing the
  // same work on a re-run is idempotent (no duplicate row creation).
  const idAagain = buildLocalDeviceOutboxId({ kind: 'record_batch', parts: ['claude_code', 1, 'batch-shared-id'], sourceInstanceId: 'src-A' });
  assert.equal(idA, idAagain);
});

test('LocalDeviceOutbox isolates rows across connection-scoped source instances', async () => {
  // Tasks 5.2 / 5.3 / 5.4: two source instances pointed at the same outbox
  // file must each see only their own work via the per-source filters
  // even when row ids differ only by source_instance_id.
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({ kind: 'record_batch', parts: ['claude_code', 1, 'batch-A'], sourceInstanceId: 'src-A' }),
      kind: 'record_batch',
      payload: { ok: 'A' },
      sourceInstanceId: 'src-A',
    });
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({ kind: 'record_batch', parts: ['claude_code', 1, 'batch-B'], sourceInstanceId: 'src-B' }),
      kind: 'record_batch',
      payload: { ok: 'B' },
      sourceInstanceId: 'src-B',
    });

    const summaryA = outbox.summary({ sourceInstanceId: 'src-A' });
    const summaryB = outbox.summary({ sourceInstanceId: 'src-B' });
    assert.equal(summaryA.total, 1);
    assert.equal(summaryB.total, 1);
    assert.equal(summaryA.ready, 1);
    assert.equal(summaryB.ready, 1);

    const listA = outbox.list({ sourceInstanceId: 'src-A' });
    const listB = outbox.list({ sourceInstanceId: 'src-B' });
    assert.equal(listA.length, 1);
    assert.equal(listB.length, 1);
    assert.equal(listA[0].source_instance_id, 'src-A');
    assert.equal(listB[0].source_instance_id, 'src-B');
  } finally {
    outbox.close();
  }
});

test('inspectLocalOutboxStatus reads connection-scoped counts from the scoped default queue path', async () => {
  // Operator-facing proof of 5.4 from the published CLI angle: the
  // status surface, when given a connection-id, only reports work
  // belonging to that connection-scoped source instance and reads from
  // the connection-scoped default queue file.
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({ kind: 'record_batch', parts: ['claude_code', 1, 'batch-A'], sourceInstanceId: 'src-only-A' }),
      kind: 'record_batch',
      payload: {},
      sourceInstanceId: 'src-only-A',
    });
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({ kind: 'record_batch', parts: ['codex', 1, 'batch-B'], sourceInstanceId: 'src-only-B' }),
      kind: 'record_batch',
      payload: {},
      sourceInstanceId: 'src-only-B',
    });
  } finally {
    outbox.close();
  }

  const aOnly = inspectLocalOutboxStatus({
    baseUrl: 'http://127.0.0.1:7662',
    command: 'status',
    queuePath: path,
    sourceInstanceId: 'src-only-A',
  });
  assert.equal(aOnly.outbox.counts.pending, 1);
  assert.equal(aOnly.outbox.counts.total, 1);
  assert.equal(aOnly.source.source_instance_id, 'src-only-A');

  const bOnly = inspectLocalOutboxStatus({
    baseUrl: 'http://127.0.0.1:7662',
    command: 'status',
    queuePath: path,
    sourceInstanceId: 'src-only-B',
  });
  assert.equal(bOnly.outbox.counts.pending, 1);
  assert.equal(bOnly.outbox.counts.total, 1);
});

async function tempOutboxPath() {
  return join(await tempDir(), 'outbox.sqlite');
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'pdpp-local-collector-test-'));
}
