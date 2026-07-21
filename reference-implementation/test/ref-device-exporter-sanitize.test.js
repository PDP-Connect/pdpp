// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure device-exporter diagnostic sanitizers.
 *
 * ref-device-exporter-sanitize.ts is a pure transformation module (its own
 * header notes "no route registration, no auth, no state writes"). It is
 * covered only end-to-end today; neither exported function is unit-pinned.
 * These tests OBSERVE the redaction behavior — they never change it — which
 * is exactly the kind of security-load-bearing logic worth pinning. Coverage:
 *   - sensitive key redaction (authorization/token/…) at nesting,
 *   - home/secret-dir path-fragment redaction in strings,
 *   - array/object depth capping + array element cap passthrough,
 *   - scalar/null passthrough,
 *   - sanitizeLocalCollectorGapDetails whitespace collapse, blank→null,
 *     and the 300-char truncation with an ellipsis.
 *
 * Observed expected values were captured from the current implementation and
 * the source is restored byte-clean after any seed-mutant verification.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeDeviceExporterDiagnostic,
  sanitizeLocalCollectorGapDetails,
} from '../server/routes/ref-device-exporter-sanitize.ts';

test('sanitizeDeviceExporterDiagnostic redacts sensitive keys at every depth', () => {
  const out = sanitizeDeviceExporterDiagnostic({
    authorization: 'Bearer xyz',
    note: 'ok',
    nested: { token: 'abc', keep: 1 },
  });
  assert.deepEqual(out, {
    authorization: '[REDACTED]',
    note: 'ok',
    nested: { token: '[REDACTED]', keep: 1 },
  });
});

test('sanitizeDeviceExporterDiagnostic redacts home/secret paths in strings', () => {
  assert.equal(
    sanitizeDeviceExporterDiagnostic('failed reading /home/tim/.ssh/id_rsa now'),
    'failed reading [REDACTED_PATH] now',
  );
  assert.equal(
    sanitizeDeviceExporterDiagnostic('open /home/tim/logs/app.log failed'),
    'open [REDACTED_PATH] failed',
  );
});

test('sanitizeDeviceExporterDiagnostic passes scalars through and maps null', () => {
  assert.equal(sanitizeDeviceExporterDiagnostic(42), 42);
  assert.equal(sanitizeDeviceExporterDiagnostic(true), true);
  assert.equal(sanitizeDeviceExporterDiagnostic(null), null);
  assert.equal(sanitizeDeviceExporterDiagnostic(undefined), null);
});

test('sanitizeDeviceExporterDiagnostic caps object nesting depth at 4', () => {
  let root = {};
  let cur = root;
  for (let i = 0; i < 6; i += 1) {
    cur.child = {};
    cur = cur.child;
  }
  const out = sanitizeDeviceExporterDiagnostic(root);
  // Four levels of child, then the depth guard fires.
  assert.deepEqual(out, { child: { child: { child: { child: '[REDACTED_DEPTH]' } } } });
});

test('sanitizeDeviceExporterDiagnostic caps arrays at 20 elements and recurses', () => {
  const arr = Array.from({ length: 25 }, (_, i) => i);
  const out = sanitizeDeviceExporterDiagnostic(arr);
  assert.equal(out.length, 20);
  assert.deepEqual(out.slice(0, 3), [0, 1, 2]);
  // A deeply-nested array hits the depth guard.
  assert.equal(sanitizeDeviceExporterDiagnostic([[[[[1]]]]]).length, 1);
});

test('sanitizeLocalCollectorGapDetails collapses whitespace and rejects blanks', () => {
  assert.equal(sanitizeLocalCollectorGapDetails('hello   world'), 'hello world');
  assert.equal(sanitizeLocalCollectorGapDetails('   '), null);
  assert.equal(sanitizeLocalCollectorGapDetails(42), null);
  assert.equal(sanitizeLocalCollectorGapDetails(null), null);
});

test('sanitizeLocalCollectorGapDetails redacts secret-dir path fragments', () => {
  assert.equal(
    sanitizeLocalCollectorGapDetails('reading ~/.codex/config.toml failed'),
    'reading [REDACTED_PATH] failed',
  );
});

test('sanitizeLocalCollectorGapDetails truncates to 300 chars with an ellipsis', () => {
  const long = 'word '.repeat(120); // 600 chars that survive redaction
  const out = sanitizeLocalCollectorGapDetails(long);
  assert.equal(out.length, 300);
  assert.ok(out.endsWith('…'));
  // A short survivor is returned untruncated.
  const short = sanitizeLocalCollectorGapDetails('a short line');
  assert.equal(short, 'a short line');
});
