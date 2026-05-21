import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isClosedPipeWriteError } from '../runtime/pipe-errors.js';
import { deriveTerminalReason } from '../runtime/terminal-reason.js';
import { runConnector } from '../runtime/index.js';

// Regression coverage for
//   openspec/changes/harden-reference-runtime-reliability/
//
// Three layers, in order of how directly they prove the contract:
//   1. Classifier unit tests   — what counts as a downgradable
//      closed-pipe write error.
//   2. deriveTerminalReason    — the production helper that maps
//      {doneMessage, finalStatus, childStdinClosedReason,
//      childStdinClosedAtPhase} to the run's terminal_reason. This is
//      the run-terminal contract; if it changes, run outcomes change.
//   3. Spawn smoke             — host-survives proof for the captured
//      EPIPE crash. Asserts no uncaughtException reaches the global
//      handler and the resolved outcome carries one of the typed
//      terminal_reason values the spec promises.

// ─── 1. Classifier ───────────────────────────────────────────────────────────

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

// ─── 2. deriveTerminalReason (run-terminal contract) ─────────────────────────

test('deriveTerminalReason: DONE succeeded → null reason', () => {
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: { status: 'succeeded', records_emitted: 5 },
      finalStatus: 'succeeded',
      childStdinClosedReason: null,
      childStdinClosedAtPhase: null,
    }),
    { reason: null, phase: null },
  );
});

test('deriveTerminalReason: DONE failed → connector_reported_failed', () => {
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: { status: 'failed', records_emitted: 0 },
      finalStatus: 'failed',
      childStdinClosedReason: null,
      childStdinClosedAtPhase: null,
    }),
    { reason: 'connector_reported_failed', phase: null },
  );
});

test('deriveTerminalReason: DONE cancelled → connector_reported_cancelled', () => {
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: { status: 'cancelled', records_emitted: 0 },
      finalStatus: 'failed',
      childStdinClosedReason: null,
      childStdinClosedAtPhase: null,
    }),
    { reason: 'connector_reported_cancelled', phase: null },
  );
});

test('deriveTerminalReason: failed without DONE, no stdin-close → connector_exit_without_done', () => {
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: null,
      finalStatus: 'failed',
      childStdinClosedReason: null,
      childStdinClosedAtPhase: null,
    }),
    { reason: 'connector_exit_without_done', phase: null },
  );
});

test('deriveTerminalReason: failed without DONE + stdin closed at start → connector_stdin_closed/start', () => {
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: null,
      finalStatus: 'failed',
      childStdinClosedReason: 'connector_stdin_closed',
      childStdinClosedAtPhase: 'start',
    }),
    { reason: 'connector_stdin_closed', phase: 'start' },
  );
});

test('deriveTerminalReason: failed without DONE + stdin closed at interaction_response → connector_stdin_closed/interaction_response', () => {
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: null,
      finalStatus: 'failed',
      childStdinClosedReason: 'connector_stdin_closed',
      childStdinClosedAtPhase: 'interaction_response',
    }),
    { reason: 'connector_stdin_closed', phase: 'interaction_response' },
  );
});

test('deriveTerminalReason: stdin-closed reason WITHOUT phase still resolves, with phase=unknown', () => {
  // Defensive: if the phase was somehow not recorded, the reason is
  // still load-bearing. We surface 'unknown' rather than dropping it.
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: null,
      finalStatus: 'failed',
      childStdinClosedReason: 'connector_stdin_closed',
      childStdinClosedAtPhase: null,
    }),
    { reason: 'connector_stdin_closed', phase: 'unknown' },
  );
});

test('deriveTerminalReason: DONE wins over a recorded stdin-close', () => {
  // If DONE arrived (the connector formally completed) AND a later
  // stdin write failed — for example, a runtime cleanup write — the
  // protocol-level DONE is the load-bearing terminal record. The
  // stdin-close is an artefact of teardown, not the run outcome.
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: { status: 'failed', records_emitted: 0 },
      finalStatus: 'failed',
      childStdinClosedReason: 'connector_stdin_closed',
      childStdinClosedAtPhase: 'interaction_response',
    }),
    { reason: 'connector_reported_failed', phase: null },
  );
});

test('deriveTerminalReason: succeeded run with no DONE and no stdin-close → null', () => {
  // Defensive shape: a non-failed run with no DONE shouldn't carry a
  // failure reason. The runtime never reaches this state in
  // production, but the helper SHALL be total.
  assert.deepEqual(
    deriveTerminalReason({
      doneMessage: null,
      finalStatus: 'succeeded',
      childStdinClosedReason: null,
      childStdinClosedAtPhase: null,
    }),
    { reason: null, phase: null },
  );
});

// ─── 3. Spawn smoke (host-survives proof) ────────────────────────────────────

test('runConnector: connector that exits before reading START does not crash the host', async () => {
  // Without per-stream error listeners on proc.stdin/stdout/stderr, an
  // EPIPE on the runtime's first stdin write would surface as an
  // unhandled 'error' event on the parent's stream and become an
  // uncaughtException — the captured Docker crash class.
  //
  // Note on race: depending on kernel pipe-buffer timing the parent's
  // synchronous START write may either fail with EPIPE (→
  // 'connector_stdin_closed') or be absorbed before the child closes (→
  // 'connector_exit_without_done'). Both are typed terminal values
  // declared in the spec; the load-bearing contract is that the host
  // survives and the outcome carries a typed reason. The
  // deriveTerminalReason unit tests above cover the precise mapping
  // regardless of which branch the kernel races into.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-pipe-test-'));
  const stubPath = join(tmpDir, 'stub-exits.js');
  writeFileSync(
    stubPath,
    [
      '#!/usr/bin/env node',
      "setImmediate(() => { try { process.stdin.destroy(); } catch {} process.exit(7); });",
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

  const uncaughtErrors = [];
  const onUncaught = (err) => uncaughtErrors.push(err);
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
      rsUrl: 'http://127.0.0.1:1',
      onProgress: () => {},
      onInteraction: () => ({ type: 'INTERACTION_RESPONSE', status: 'cancelled' }),
      // No server harness; supply an empty detail-gap store so the
      // runtime exercises only the pipe-resilience path under test.
      detailGapStore: {
        async listPendingGaps() { return []; },
        async upsertPendingGap() { return null; },
        async markGapStatus() { return null; },
      },
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const epipeEscapes = uncaughtErrors.filter(isClosedPipeWriteError);
  assert.equal(
    epipeEscapes.length,
    0,
    `expected no closed-pipe uncaughtException, got ${epipeEscapes.length}`,
  );

  const surfaced = outcome ?? outcomeError;
  assert.ok(surfaced && typeof surfaced === 'object', 'structured outcome');
  assert.equal(surfaced.status, 'failed', 'failed run when child exits before DONE');
  assert.ok(
    ['connector_stdin_closed', 'connector_exit_without_done'].includes(surfaced.terminal_reason),
    `expected terminal_reason in {connector_stdin_closed, connector_exit_without_done}, got ${JSON.stringify(surfaced.terminal_reason)}`,
  );
  if (surfaced.terminal_reason === 'connector_stdin_closed') {
    assert.ok(
      ['start', 'interaction_response'].includes(surfaced.stdin_closed_at_phase),
      `expected stdin_closed_at_phase in {start, interaction_response}, got ${JSON.stringify(surfaced.stdin_closed_at_phase)}`,
    );
  }
});
