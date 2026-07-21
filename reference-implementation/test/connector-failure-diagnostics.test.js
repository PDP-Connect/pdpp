import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConnector } from '../runtime/index.js';
import {
  createStderrTailBuffer,
  STDERR_TAIL_DEFAULT_CAP_BYTES,
} from '../runtime/stderr-tail.ts';
import { redactStderrTail } from '../runtime/stderr-redact.ts';

// Regression coverage for
//   openspec/changes/persist-connector-failure-diagnostics
//
// The runtime previously accumulated child stderr into memory for the
// lifetime of a run and discarded it before persisting the terminal
// `run.failed` event, leaving the owner unable to diagnose connector
// exits after the fact. These tests pin the new behavior:
//
//   1. The bounded stderr tail buffer keeps memory bounded and reports
//      truncation metadata.
//   2. The redaction policy strips recognized credential markers, OTPs,
//      and long opaque tokens before persistence.
//   3. A spawn-level run for a stub that writes stderr and exits 1
//      surfaces `failure_origin`, `failure_message`, `exit_code`, and
//      `connector_diagnostics.stderr_tail` on the resolved outcome.

// ─── 1. Tail buffer (memory-bounded capture) ─────────────────────────────────

test('createStderrTailBuffer: short writes are kept verbatim', () => {
  const tail = createStderrTailBuffer();
  tail.append(Buffer.from('hello\n'));
  tail.append(Buffer.from('world\n'));
  const out = tail.finalize();
  assert.equal(out.text, 'hello\nworld\n');
  assert.equal(out.bytes_observed, 12);
  assert.equal(out.bytes_captured, 12);
  assert.equal(out.truncated, false);
});

test('createStderrTailBuffer: tail is bounded when stderr exceeds the cap', () => {
  const cap = 256;
  const tail = createStderrTailBuffer({ capBytes: cap });
  // Write 4x the cap as ASCII bytes so the count is unambiguous.
  const chunk = Buffer.alloc(cap, 0x41); // 'A'
  for (let i = 0; i < 4; i += 1) {
    tail.append(chunk);
  }
  // Then a trailing marker so we can assert the final bytes are kept.
  const trailer = Buffer.from('TRAILER');
  tail.append(trailer);

  const out = tail.finalize();
  assert.equal(out.bytes_observed, cap * 4 + trailer.length);
  assert.equal(out.bytes_captured <= cap, true, `bytes_captured ${out.bytes_captured} should be <= cap ${cap}`);
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith('TRAILER'), `expected trailing marker preserved, got ${JSON.stringify(out.text.slice(-20))}`);
});

test('createStderrTailBuffer: bytes_observed accounts for evicted prefix', () => {
  const cap = 16;
  const tail = createStderrTailBuffer({ capBytes: cap });
  tail.append(Buffer.from('a'.repeat(50)));
  const out = tail.finalize();
  assert.equal(out.bytes_observed, 50);
  assert.equal(out.bytes_captured, cap);
  assert.equal(out.truncated, true);
});

test('STDERR_TAIL_DEFAULT_CAP_BYTES is the documented 16 KiB target', () => {
  assert.equal(STDERR_TAIL_DEFAULT_CAP_BYTES, 16 * 1024);
});

// ─── 2. Redaction policy ─────────────────────────────────────────────────────

test('redactStderrTail: scrubs labelled credentials', () => {
  const input = 'Auth failed: token=abc123def456 password=hunter2';
  const { text, redacted } = redactStderrTail(input);
  assert.equal(redacted, true);
  assert.ok(!text.includes('abc123def456'), `token value leaked: ${text}`);
  assert.ok(!text.includes('hunter2'), `password leaked: ${text}`);
  assert.ok(text.includes('token=[REDACTED]'));
  assert.ok(text.includes('password=[REDACTED]'));
});

test('redactStderrTail: scrubs OTP-shaped 6-digit numbers', () => {
  const input = 'Enter the code 482913 to continue';
  const { text, redacted } = redactStderrTail(input);
  assert.equal(redacted, true);
  assert.ok(!text.includes('482913'));
  assert.ok(text.includes('[REDACTED_OTP]'));
});

test('redactStderrTail: scrubs long opaque tokens without explicit labels', () => {
  // 32-char opaque-looking string — like a raw API key or signed JWT
  // segment that appears in a stack trace without a `key=` prefix.
  const input = 'failed to call api with key abcdefghij1234567890abcdefghij1234';
  const { text, redacted } = redactStderrTail(input);
  assert.equal(redacted, true);
  assert.ok(!text.includes('abcdefghij1234567890abcdefghij1234'));
  assert.ok(text.includes('[REDACTED]'));
});

test('redactStderrTail: leaves benign text intact', () => {
  const input = 'Connector failed: HTTP 500 from upstream';
  const { text, redacted } = redactStderrTail(input);
  assert.equal(redacted, false);
  assert.equal(text, input);
});

test('redactStderrTail: tolerates empty/null input', () => {
  assert.deepEqual(redactStderrTail(''), { text: '', redacted: false });
  assert.deepEqual(redactStderrTail(null), { text: '', redacted: false });
});

// ─── 3. Spawn proof — runtime persists the diagnostic on connector exit ──────

const TEST_MANIFEST = {
  connector_id: 'https://registry.pdpp.org/connectors/test-failure-diagnostics-stub',
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

function makeStub({ stderrText, exitCode = 1 }) {
  // Stubs accept the START message on stdin, write `stderrText` to
  // stderr, and exit with `exitCode` BEFORE emitting DONE. This is the
  // exact failure shape the openspec change targets: connector_exit_without_done.
  const lines = [
    '#!/usr/bin/env node',
    "process.stdin.resume();",
    "process.stdin.once('data', () => {",
    `  process.stderr.write(${JSON.stringify(stderrText)});`,
    `  process.exit(${exitCode});`,
    "});",
    '',
  ];
  return lines.join('\n');
}

async function runStub({ stderrText, exitCode = 1 }) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-failure-diagnostics-'));
  const stubPath = join(tmpDir, 'stub.js');
  writeFileSync(stubPath, makeStub({ stderrText, exitCode }), 'utf8');
  chmodSync(stubPath, 0o755);

  let outcome = null;
  let outcomeError = null;
  try {
    outcome = await runConnector({
      connectorPath: stubPath,
      connectorId: TEST_MANIFEST.connector_id,
      ownerToken: 'test-owner-token',
      manifest: TEST_MANIFEST,
      state: null,
      collectionMode: 'full_refresh',
      // Pointed at an unreachable host so any stray ingest attempt
      // fails closed; this stub never emits records anyway.
      rsUrl: 'http://127.0.0.1:1',
      onProgress: () => {},
      onInteraction: () => ({ type: 'INTERACTION_RESPONSE', status: 'cancelled' }),
      // No server harness; runConnector reads pending detail gaps at
      // start, which would otherwise hit a closed DB. Provide an empty
      // store so the runtime exercises only the stderr-diagnostic path
      // these tests are meant to verify.
      detailGapStore: {
        async listPendingGaps() { return []; },
        async upsertPendingGap() { return null; },
        async markGapStatus() { return null; },
      },
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return outcome ?? outcomeError;
}

test('runConnector: stderr-bearing exit before DONE surfaces failure_origin/message and stderr_tail', async () => {
  const stderrText = 'Boom: connector hit an unhandled exception\n  at thing (file.js:42)\n';
  const surfaced = await runStub({ stderrText, exitCode: 1 });

  assert.ok(surfaced && typeof surfaced === 'object', 'expected structured outcome');
  assert.equal(surfaced.status, 'failed');
  assert.equal(surfaced.exit_code, 1);
  assert.ok(
    ['connector_exit_without_done', 'connector_stdin_closed'].includes(surfaced.terminal_reason),
    `unexpected terminal_reason ${JSON.stringify(surfaced.terminal_reason)}`,
  );
  assert.equal(surfaced.failure_origin, 'connector');
  assert.equal(typeof surfaced.failure_message, 'string');
  assert.ok(surfaced.failure_message.length > 0, 'failure_message should be non-empty');

  const diag = surfaced.connector_diagnostics?.stderr_tail;
  assert.ok(diag, 'expected connector_diagnostics.stderr_tail on outcome');
  assert.equal(diag.object, 'connector_stderr_tail');
  assert.equal(diag.encoding, 'utf-8');
  assert.equal(typeof diag.text, 'string');
  assert.ok(diag.text.includes('Boom'), `stderr text not preserved: ${diag.text}`);
  assert.equal(diag.truncated, false);
  assert.equal(diag.redacted, false);
  assert.equal(diag.bytes_observed, Buffer.byteLength(stderrText, 'utf8'));
  assert.equal(diag.bytes_captured, Buffer.byteLength(stderrText, 'utf8'));
});

test('runConnector: oversized stderr is truncated and metadata reflects truncation', async () => {
  // Write more than the default 16 KiB cap. We separate the bulk and
  // the trailing marker with a newline so the redaction policy's long
  // opaque-token rule does not coalesce the bulk and the marker into a
  // single run that gets scrubbed.
  const big = 'X'.repeat(STDERR_TAIL_DEFAULT_CAP_BYTES * 2);
  const trailerLine = 'connector exited cleanly per its own opinion\n';
  const stderrText = `${big}\n${trailerLine}`;

  const surfaced = await runStub({ stderrText, exitCode: 1 });
  assert.equal(surfaced.status, 'failed');

  const diag = surfaced.connector_diagnostics?.stderr_tail;
  assert.ok(diag, 'expected stderr_tail');
  assert.equal(diag.truncated, true);
  assert.ok(
    diag.bytes_observed > diag.bytes_captured,
    `expected bytes_observed > bytes_captured, got ${diag.bytes_observed} vs ${diag.bytes_captured}`,
  );
  assert.ok(
    diag.bytes_captured <= STDERR_TAIL_DEFAULT_CAP_BYTES,
    `expected bytes_captured <= cap, got ${diag.bytes_captured}`,
  );
  assert.ok(
    diag.text.includes('connector exited cleanly'),
    `expected the tail end of stderr to be preserved, got: ${JSON.stringify(diag.text.slice(-200))}`,
  );
});

test('runConnector: secret-shaped stderr is redacted before persistence', async () => {
  const secret = ['sk','live','ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('_'); // runtime-constructed so secret scanners don't flag the synthetic fixture
  const stderrText = `request failed: token=${secret}\nupstream returned 401\n`;

  const surfaced = await runStub({ stderrText, exitCode: 1 });
  assert.equal(surfaced.status, 'failed');

  const diag = surfaced.connector_diagnostics?.stderr_tail;
  assert.ok(diag, 'expected stderr_tail');
  assert.equal(diag.redacted, true);
  assert.ok(!diag.text.includes(secret), `raw secret leaked into persisted diagnostic: ${diag.text}`);
  assert.ok(diag.text.includes('[REDACTED]'));
  // Surrounding context is still intact so the owner can see what
  // happened, just not the credential value.
  assert.ok(diag.text.includes('upstream returned 401'));
});
