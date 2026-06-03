import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  readLocalOutboxDeadLetterErrorSummary,
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

test('bundled connector defaults request coverage_diagnostics so a drained run is never coverage_unknown', () => {
  // Local-device collectors push records from a device outbox and write no
  // spine run, so the connection-health rollup can only project a non-`unknown`
  // coverage axis from durable `coverage_diagnostics` records. If the published
  // default stream set omits that stream, every `pdpp-local-collector run`
  // emits zero coverage evidence and the dashboard is stuck at
  // `coverage_unknown` even after a healthy drain. See
  // openspec/changes/derive-local-collector-coverage-from-diagnostics.
  for (const id of BUNDLED_CONNECTOR_IDS) {
    const entry = getBundledConnector(id);
    assert.ok(entry, `entry for ${id}`);
    assert.ok(
      entry.streams.includes('coverage_diagnostics'),
      `${id} default streams must include coverage_diagnostics; got ${entry.streams.join(', ')}`
    );
  }
});

test('bundled connector default streams are all manifest-declared (no undeclared stream requested)', async () => {
  for (const id of BUNDLED_CONNECTOR_IDS) {
    const entry = getBundledConnector(id);
    assert.ok(entry, `entry for ${id}`);
    const manifestPath = join(
      import.meta.dirname,
      '..',
      '..',
      'polyfill-connectors',
      'manifests',
      `${id}.json`
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const declared = new Set(manifest.streams.map((stream) => stream.name));
    for (const stream of entry.streams) {
      assert.ok(declared.has(stream), `${id} default stream '${stream}' is not declared in the manifest`);
    }
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
      coverage_diagnostics: 'ok',
      expired_leases: 'warn',
      outbox_db: 'ok',
      outbox_failures: 'fail',
    });
    // Dead letters dominate the lifecycle state even though no coverage
    // diagnostic was observed: a lane that needs recovery is not first
    // labeled "coverage missing".
    assert.equal(doctor.lifecycle_state, 'dead_letter');
    assert.equal(doctor.outbox.counts.dead_letter, 1);
    assert.equal(doctor.outbox.counts.retrying, 1);
    assert.equal(doctor.outbox.expired_leases, 1);
    assert.doesNotMatch(
      JSON.stringify(doctor),
      /dead-letter-payload|expired-lease-payload|retrying-payload|dead-letter-id|expired-lease-id|retrying-id/
    );

    // When dead letters are present, doctor points the operator at the
    // recovery primitive (dry-run preview, then --apply with backup). This
    // scenario also has an expired lease, so doctor emits a distinct
    // self-heal hint for that — each non-ok check gets its own line.
    assert.ok(Array.isArray(doctor.remediation));
    const deadLetterHint = doctor.remediation.find((line) => /retry-dead-letters/.test(line));
    assert.ok(deadLetterHint, 'expected a dead-letter remediation hint');
    assert.match(deadLetterHint, /--apply/);
    const expiredLeaseHint = doctor.remediation.find((line) => /past expiry/.test(line));
    assert.ok(expiredLeaseHint, 'expected an expired-lease remediation hint');

    // When an error summary is supplied, doctor surfaces the top redacted
    // error class (the "why") and names it in the remediation hint.
    const doctorWithCause = buildLocalOutboxDoctor(
      inspectLocalOutboxStatus({
        baseUrl: 'http://127.0.0.1:7662',
        command: 'doctor',
        queuePath: path,
        sourceInstanceId: 'src-1',
      }),
      readLocalOutboxDeadLetterErrorSummary({
        baseUrl: 'http://127.0.0.1:7662',
        command: 'doctor',
        queuePath: path,
        sourceInstanceId: 'src-1',
      })
    );
    assert.ok(doctorWithCause.dead_letter_error_summary);
    assert.equal(doctorWithCause.dead_letter_error_summary.dead_letter_count, 1);
    assert.equal(doctorWithCause.dead_letter_error_summary.top_classes[0].error_class, 'bounded error');
    assert.match(doctorWithCause.remediation[0], /bounded error/);
    // Payloads/ids still never leak even with the cause surfaced.
    assert.doesNotMatch(
      JSON.stringify(doctorWithCause),
      /dead-letter-payload|expired-lease-payload|retrying-payload|dead-letter-id|expired-lease-id|retrying-id/
    );
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
  // Dry run previews the cause and points at the next step.
  assert.equal(dryRun.dead_letter_error_summary.top_classes[0].error_class, 'terminal');
  assert.match(dryRun.note, /dry run/);
  assert.match(dryRun.note, /--apply/);

  const applied = retryLocalOutboxDeadLetters({ ...parsed, apply: true });
  assert.equal(applied.dry_run, false);
  assert.equal(applied.matched, 1);
  assert.equal(applied.requeued, 1);
  assert.ok(applied.backup_path);
  assert.equal(existsSync(applied.backup_path), true);
  assert.equal(applied.status_before.dead_letter, 1);
  assert.equal(applied.status_after.dead_letter, 0);
  assert.equal(applied.status_after.pending, 1);
  // After requeue the note is explicit that a collector re-run drains it.
  assert.match(applied.note, /re-run the collector/);
  assert.match(applied.note, /does not ingest/);

  // Payloads and ids never leak; the redacted error class ("terminal") is
  // intentionally surfaced as the recovery cause.
  const rendered = JSON.stringify(applied);
  assert.doesNotMatch(rendered, /dead-letter-payload|dead-letter-id/);
});

test('local collector retry-dead-letters explains a state-read block when nothing matches', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A healthy (no dead-letter) outbox: nothing to requeue.
    outbox.enqueue({ id: 'ok-id', kind: 'record_batch', payload: { ok: true }, sourceInstanceId: 'src-1' });
  } finally {
    outbox.close();
  }
  const result = retryLocalOutboxDeadLetters(
    parseArgs(['retry-dead-letters', '--queue', path, '--connection-id', 'src-1'])
  );
  assert.equal(result.matched, 0);
  assert.equal(result.requeued, 0);
  assert.equal(result.dead_letter_error_summary, undefined);
  // The note distinguishes a state-read block (nothing to requeue, re-run to
  // clear) from a dead-letter backlog.
  assert.match(result.note, /state-read block/);
  assert.match(result.note, /re-run the collector/);
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

// --- Lifecycle state axis (Target 2/4): status/doctor must distinguish
// healthy_idle, draining, retryable_backlog, dead_letter, stale_lease, and
// coverage_missing from the durable outbox alone. ---

function statusFor(path, sourceInstanceId = 'src-1') {
  return inspectLocalOutboxStatus({
    baseUrl: 'http://127.0.0.1:7662',
    command: 'status',
    queuePath: path,
    sourceInstanceId,
  });
}

/** Enqueue a record_batch whose envelopes carry the given stream names. */
function enqueueRecordBatch(outbox, { id, sourceInstanceId = 'src-1', streams }) {
  outbox.enqueue({
    id,
    kind: 'record_batch',
    payload: {
      batchId: id,
      batchSeq: 1,
      connectorId: 'claude_code',
      deviceId: 'device-1',
      // Shape mirrors buildLocalDeviceRecordEnvelope output: the outbox's
      // coverage scan reads $.records[*].stream.
      records: streams.map((stream, index) => ({ data: { id: `${stream}-${index}` }, stream })),
      sourceInstanceId,
    },
    sourceInstanceId,
  });
}

/** Claim + acknowledge a row so it reaches status 'succeeded' (drained). */
function drainRow(outbox, id, sourceInstanceId = 'src-1') {
  const [claim] = outbox.claimReady({ holder: 'drainer', leaseMs: 60_000, sourceInstanceId });
  assert.ok(claim, `expected to claim a ready row for ${id}`);
  outbox.acknowledge({ holder: 'drainer', id: claim.id, leaseEpoch: claim.lease_epoch });
}

test('lifecycle_state is healthy_idle on an empty outbox (nothing collected, no coverage to miss)', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  outbox.close();
  const status = statusFor(path);
  assert.equal(status.lifecycle_state, 'healthy_idle');
  assert.deepEqual(status.coverage, { observed: false, record_batches: 0 });
  assert.equal(buildLocalOutboxDoctor(status).checks.coverage_diagnostics, 'ok');
});

test('lifecycle_state is draining when claimable-now record work exists', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: 'rb-1', streams: ['messages'] });
  } finally {
    outbox.close();
  }
  assert.equal(statusFor(path).lifecycle_state, 'draining');
});

test('lifecycle_state is retryable_backlog when all ready work is waiting on backoff', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A ready row whose next_attempt_at is in the future is "retrying":
    // nothing is claimable this instant, but work remains.
    outbox.enqueue({
      id: 'rb-backoff',
      kind: 'record_batch',
      nextAttemptAt: new Date('2099-01-01T00:00:00.000Z'),
      payload: { records: [{ data: { id: 'm-1' }, stream: 'messages' }] },
      sourceInstanceId: 'src-1',
    });
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.outbox.counts.retrying, 1);
  assert.equal(status.lifecycle_state, 'retryable_backlog');
});

test('lifecycle_state is dead_letter when a row exhausted retries', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: 'rb-dl', streams: ['messages'] });
    const [claim] = outbox.claimReady({ holder: 'w', leaseMs: 60_000, sourceInstanceId: 'src-1' });
    outbox.deadLetter({ error: 'terminal', holder: 'w', id: claim.id, leaseEpoch: claim.lease_epoch });
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.lifecycle_state, 'dead_letter');
  assert.equal(buildLocalOutboxDoctor(status).status, 'critical');
});

test('lifecycle_state is stale_lease when a lease is past expiry', async () => {
  const path = await tempOutboxPath();
  let now = new Date('2026-05-19T12:00:00.000Z');
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    enqueueRecordBatch(outbox, { id: 'rb-stale', streams: ['messages'] });
    outbox.claimReady({ holder: 'w', leaseMs: 1000, sourceInstanceId: 'src-1' });
    // Advance the clock past the lease so the lease is expired but not yet
    // recovered — exactly the "previous run crashed mid-drain" shape.
    now = new Date('2026-05-19T12:01:00.000Z');
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.outbox.expired_leases, 1);
  assert.equal(status.lifecycle_state, 'stale_lease');
  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.expired_leases, 'warn');
  assert.equal(doctor.status, 'warning');
  assert.ok(doctor.remediation.some((line) => /past expiry/.test(line)));
});

test('lifecycle_state is coverage_missing after a clean drain that never carried a coverage record', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // Collect and fully drain real records, but none on coverage_diagnostics.
    enqueueRecordBatch(outbox, { id: 'rb-content', streams: ['sessions', 'messages'] });
    drainRow(outbox, 'rb-content');
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.outbox.counts.pending, 0);
  assert.equal(status.outbox.counts.leased, 0);
  assert.equal(status.coverage.observed, false);
  assert.ok(status.coverage.record_batches >= 1);
  assert.equal(status.lifecycle_state, 'coverage_missing');

  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.coverage_diagnostics, 'warn');
  assert.equal(doctor.status, 'warning');
  assert.ok(doctor.remediation.some((line) => /coverage_unknown/.test(line)));
  assert.ok(doctor.remediation.some((line) => /default stream set/.test(line)));
});

test('lifecycle_state is healthy_idle once a drained lane has carried a coverage_diagnostics record', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: 'rb-content', streams: ['messages'] });
    drainRow(outbox, 'rb-content');
    enqueueRecordBatch(outbox, { id: 'rb-coverage', streams: ['coverage_diagnostics'] });
    drainRow(outbox, 'rb-coverage');
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.coverage.observed, true);
  assert.equal(status.lifecycle_state, 'healthy_idle');
  assert.equal(buildLocalOutboxDoctor(status).checks.coverage_diagnostics, 'ok');
});

test('coverage observation survives a clean drain and ignores dead-letter rows', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A coverage record that only ever dead-lettered was never durably
    // observed by the lane, so it must not count as coverage.
    enqueueRecordBatch(outbox, { id: 'rb-dl-coverage', streams: ['coverage_diagnostics'] });
    const [claim] = outbox.claimReady({ holder: 'w', leaseMs: 60_000, sourceInstanceId: 'src-1' });
    outbox.deadLetter({ error: 'terminal', holder: 'w', id: claim.id, leaseEpoch: claim.lease_epoch });
    // A separate, successfully drained content batch with no coverage.
    enqueueRecordBatch(outbox, { id: 'rb-content', streams: ['messages'] });
    drainRow(outbox, 'rb-content');
  } finally {
    outbox.close();
  }
  // dead_letter dominates the lifecycle verdict, but the coverage signal
  // itself still reports observed:false because the only coverage row
  // dead-lettered.
  const status = statusFor(path);
  assert.equal(status.coverage.observed, false);
  assert.equal(status.lifecycle_state, 'dead_letter');
});

test('lifecycle/coverage status leaks no payloads', async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: 'secret-row',
      kind: 'record_batch',
      payload: { records: [{ data: { id: 'do-not-print', token: 'nope' }, stream: 'coverage_diagnostics' }] },
      sourceInstanceId: 'src-1',
    });
    drainRow(outbox, 'secret-row');
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  const doctor = buildLocalOutboxDoctor(status);
  const rendered = JSON.stringify({ status, doctor });
  assert.doesNotMatch(rendered, /do-not-print|secret-row|nope/);
});

test('status/doctor stay bounded and report observed:null on a giant legacy (pre-index) outbox', async () => {
  // The performance flaw this lane fixes: doctor against a real ~35 GB Codex
  // outbox hung because coverage detection scanned every retained payload with
  // json_each. The fix moves coverage to a payload-light index; a pre-index
  // outbox whose unindexed backlog exceeds the bounded scan budget must report
  // observed:null (unknown) instead of launching an unbounded scan. We assert
  // the bounded behavior by timing a status/doctor pass over an over-budget
  // legacy DB and proving it answers null rather than a partial false negative.
  const path = await tempOutboxPath();
  const budget = 5000;
  seedLegacyV1Outbox(
    path,
    Array.from({ length: budget + 50 }, (_value, index) => ({
      id: `legacy-${index}`,
      sourceInstanceId: 'src-legacy',
      streams: ['messages'],
    }))
  );

  const status = inspectLocalOutboxStatus({
    baseUrl: 'http://127.0.0.1:7662',
    command: 'status',
    queuePath: path,
    sourceInstanceId: 'src-legacy',
  });
  // Unknown coverage suppresses the coverage_missing verdict (never guess from
  // a partial scan); the lane is fully drained otherwise, so it is healthy_idle.
  assert.equal(status.coverage.observed, null);
  assert.equal(status.lifecycle_state, 'healthy_idle');

  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.coverage_diagnostics, 'ok');
  // The whole pass leaks no payloads even on the legacy path.
  assert.doesNotMatch(JSON.stringify({ status, doctor }), /messages-\d/);
});

async function tempOutboxPath() {
  return join(await tempDir(), 'outbox.sqlite');
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'pdpp-local-collector-test-'));
}

/**
 * Seed a schema-v1 (pre-observed-stream-index) outbox file directly so the CLI
 * surface can be tested against the legacy bounded-scan fallback. Mirrors the
 * v1 table DDL and creates NO observed-stream index table, exactly as a
 * database created before this index existed would look.
 */
function seedLegacyV1Outbox(path, rows) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE local_device_outbox (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_holder TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        last_error TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', ?, 'hash', 0, ?, ?, ?)`
    );
    const stamp = '2026-05-19T12:00:00.000Z';
    for (const row of rows) {
      const payload = JSON.stringify({
        records: row.streams.map((stream, index) => ({ data: { id: `${stream}-${index}` }, stream })),
      });
      insert.run(row.id, row.sourceInstanceId, payload, stamp, stamp, stamp);
    }
  } finally {
    db.close();
  }
}
