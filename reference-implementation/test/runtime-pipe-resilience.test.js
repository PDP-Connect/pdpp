import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isClosedPipeWriteError } from '../runtime/pipe-errors.js';
import { runConnector } from '../runtime/index.js';

// Regression coverage for
//   openspec/changes/harden-reference-runtime-reliability/
// A connector child that exits before reading START SHALL produce a typed
// runtime outcome, NOT an uncaughtException on the host process.

test('isClosedPipeWriteError classifies EPIPE write as downgradable', () => {
  const err = Object.assign(new Error('write EPIPE'), {
    code: 'EPIPE',
    syscall: 'write',
    errno: -32,
  });
  assert.equal(isClosedPipeWriteError(err), true);
});

test('isClosedPipeWriteError classifies ERR_STREAM_DESTROYED as downgradable', () => {
  const err = Object.assign(new Error('Cannot call write after a stream was destroyed'), {
    code: 'ERR_STREAM_DESTROYED',
  });
  assert.equal(isClosedPipeWriteError(err), true);
});

test('isClosedPipeWriteError classifies ERR_STREAM_WRITE_AFTER_END as downgradable', () => {
  const err = Object.assign(new Error('write after end'), {
    code: 'ERR_STREAM_WRITE_AFTER_END',
  });
  assert.equal(isClosedPipeWriteError(err), true);
});

test('isClosedPipeWriteError rejects unrelated TypeError', () => {
  assert.equal(isClosedPipeWriteError(new TypeError('not pipe')), false);
});

test('isClosedPipeWriteError rejects EPIPE on non-write syscall', () => {
  // A read-side EPIPE (rare, but Node can synthesize one) is not a
  // downgradable write-side condition.
  const err = Object.assign(new Error('read EPIPE'), {
    code: 'EPIPE',
    syscall: 'read',
  });
  assert.equal(isClosedPipeWriteError(err), false);
});

test('isClosedPipeWriteError rejects EPIPE-looking strings without code', () => {
  assert.equal(isClosedPipeWriteError(new Error('write EPIPE')), false);
});

test('isClosedPipeWriteError tolerates non-error inputs', () => {
  assert.equal(isClosedPipeWriteError(null), false);
  assert.equal(isClosedPipeWriteError(undefined), false);
  assert.equal(isClosedPipeWriteError('EPIPE'), false);
  assert.equal(isClosedPipeWriteError(42), false);
});

test('runConnector survives a connector that exits before reading START', async () => {
  // Write a stub connector that closes its stdin and exits immediately,
  // before the runtime can deliver START. Without per-stream error
  // listeners on proc.stdin, the runtime's proc.stdin.write would surface
  // an EPIPE 'error' event with no listener and crash the host process.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-pipe-test-'));
  const stubPath = join(tmpDir, 'stub-exits.js');
  writeFileSync(
    stubPath,
    [
      '#!/usr/bin/env node',
      "process.stdin.destroy();",
      "process.exit(7);",
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(stubPath, 0o755);

  const manifest = {
    connector_id: 'https://registry.pdpp.org/connectors/test-pipe-resilience-stub',
    version: '0.1.0',
    streams: [
      {
        name: 'noop',
        primary_key: 'id',
        schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    ],
    runtime_requirements: {},
  };

  // The runtime is async-fire-and-await here; we don't supply a real
  // RS URL because the connector exits before emitting any RECORD.
  // The test asserts:
  //   1. The host process does NOT see an uncaughtException, AND
  //   2. runConnector resolves or rejects with a STRUCTURED outcome.
  const uncaughtErrors = [];
  const onUncaught = (err) => {
    uncaughtErrors.push(err);
  };
  process.on('uncaughtException', onUncaught);

  let outcome = null;
  let outcomeError = null;
  try {
    outcome = await runConnector({
      connectorPath: stubPath,
      connectorId: manifest.connector_id,
      ownerToken: 'test-owner-token',
      manifest,
      state: null,
      collectionMode: 'full_refresh',
      rsUrl: 'http://127.0.0.1:1', // unreachable; connector never emits records
      onProgress: () => {},
      onInteraction: () => ({ type: 'INTERACTION_RESPONSE', status: 'cancelled' }),
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // No EPIPE / closed-pipe error should have escaped to the global
  // uncaught-exception handler.
  const epipeEscapes = uncaughtErrors.filter(isClosedPipeWriteError);
  assert.equal(
    epipeEscapes.length,
    0,
    `expected no closed-pipe uncaughtException, got ${epipeEscapes.length}: ${epipeEscapes.map((e) => `${e.code}/${e.syscall}`).join(', ')}`,
  );

  // Runtime SHALL produce a structured outcome — either a typed failure
  // resolution OR a typed rejection. Either is acceptable here; the
  // important contract is that a closed child stdin cannot crash the
  // host with an uncaught EPIPE.
  const surfaced = outcome ?? outcomeError;
  assert.ok(
    surfaced && typeof surfaced === 'object',
    'runConnector must resolve or reject with a structured value, not crash the process',
  );
});
