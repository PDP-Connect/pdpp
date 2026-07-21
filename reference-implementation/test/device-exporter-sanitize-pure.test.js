// Pure, no-DB unit tests for the device-exporter diagnostic SANITIZERS in
// server/routes/ref-device-exporter-sanitize.ts. The device-exporter route
// integration suites exercise these through HTTP; neither pure function was
// pinned by name. These are SECURITY-relevant: they strip secrets, tokens, and
// local filesystem paths out of operator-facing diagnostics before they leave
// the box, and cap recursion/size to bound the output.
//
// Mutation surface:
//   sanitizeDeviceExporterDiagnostic -- recursive: sensitive KEY redaction
//     (authorization/token/secret/... -> [REDACTED]), array truncation to 20,
//     depth cap at 4 (-> [REDACTED_DEPTH]), scalar passthrough, /home|/Users|/root
//     path redaction -> [REDACTED_PATH].
//   sanitizeLocalCollectorGapDetails -- non-string/blank -> null, whitespace
//     collapse, 300-char cap with an ellipsis.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeDeviceExporterDiagnostic,
  sanitizeLocalCollectorGapDetails,
} from '../server/routes/ref-device-exporter-sanitize.ts';

// ---------------------------------------------------------------------------
// sanitizeDeviceExporterDiagnostic
// ---------------------------------------------------------------------------

test('sanitizeDeviceExporterDiagnostic: sensitive keys are redacted (recursively)', () => {
  const out = sanitizeDeviceExporterDiagnostic({
    authorization: 'Bearer secret-abc',
    token: 'tok_123',
    api_key: 'k',
    'api-key': 'k2',
    password: 'p',
    cookie: 'c',
    secret: 's',
    otp: '000000',
    safe_field: 'keep-me',
    nested: { token: 'nested-tok', harmless: 42 },
  });
  for (const key of ['authorization', 'token', 'api_key', 'api-key', 'password', 'cookie', 'secret', 'otp']) {
    assert.equal(out[key], '[REDACTED]', `${key} must be redacted`);
  }
  assert.equal(out.safe_field, 'keep-me', 'non-sensitive keys pass through');
  assert.equal(out.nested.token, '[REDACTED]', 'nested sensitive key redacted');
  assert.equal(out.nested.harmless, 42, 'nested non-sensitive scalar preserved');
});

test('sanitizeDeviceExporterDiagnostic: scalars pass through, null-ish -> null', () => {
  assert.equal(sanitizeDeviceExporterDiagnostic(42), 42);
  assert.equal(sanitizeDeviceExporterDiagnostic(true), true);
  assert.equal(sanitizeDeviceExporterDiagnostic(null), null);
  assert.equal(sanitizeDeviceExporterDiagnostic(undefined), null);
});

test('sanitizeDeviceExporterDiagnostic: arrays are truncated to 20 items', () => {
  const out = sanitizeDeviceExporterDiagnostic(Array.from({ length: 25 }, (_, i) => i));
  assert.equal(out.length, 20, 'array capped at 20 elements');
  assert.deepEqual(out.slice(0, 3), [0, 1, 2], 'first elements preserved in order');
});

test('sanitizeDeviceExporterDiagnostic: depth is capped at 4 with [REDACTED_DEPTH]', () => {
  const out = sanitizeDeviceExporterDiagnostic({ a: { b: { c: { d: { e: 'too deep' } } } } });
  // a(1) -> b(2) -> c(3) -> d(4) hits the cap and is replaced.
  assert.equal(out.a.b.c.d, '[REDACTED_DEPTH]', 'depth-4 nesting is redacted');
});

test('sanitizeDeviceExporterDiagnostic: unix home/user/root paths are redacted in strings', () => {
  const out = sanitizeDeviceExporterDiagnostic('open failed at /home/tim/.ssh/id_rsa please check');
  assert.ok(out.includes('[REDACTED_PATH]'), 'home path redacted');
  assert.ok(!out.includes('/home/tim'), 'raw home path must not survive');
});

test('sanitizeDeviceExporterDiagnostic: a redacted key wins even when its value is an object', () => {
  const out = sanitizeDeviceExporterDiagnostic({ token: { nested: 'still-secret' } });
  assert.equal(out.token, '[REDACTED]', 'sensitive key redacts the whole subtree, not just recurses into it');
});

// ---------------------------------------------------------------------------
// sanitizeLocalCollectorGapDetails
// ---------------------------------------------------------------------------

test('sanitizeLocalCollectorGapDetails: non-string or blank input yields null', () => {
  assert.equal(sanitizeLocalCollectorGapDetails(42), null);
  assert.equal(sanitizeLocalCollectorGapDetails(null), null);
  assert.equal(sanitizeLocalCollectorGapDetails(undefined), null);
  assert.equal(sanitizeLocalCollectorGapDetails('   '), null, 'whitespace-only -> null');
  assert.equal(sanitizeLocalCollectorGapDetails(''), null);
});

test('sanitizeLocalCollectorGapDetails: short text passes through, whitespace collapsed', () => {
  assert.equal(sanitizeLocalCollectorGapDetails('short message'), 'short message');
  assert.equal(sanitizeLocalCollectorGapDetails('multi   space\n\ttext'), 'multi space text', 'runs of whitespace collapse to one space');
});

test('sanitizeLocalCollectorGapDetails: long text is capped at 300 chars with an ellipsis', () => {
  // 100 words -> ~500 chars after collapse -> capped to 300 (299 + ellipsis).
  const long = `error: ${'word '.repeat(100)}`;
  const out = sanitizeLocalCollectorGapDetails(long);
  assert.equal(out.length, 300, 'output capped at 300 chars');
  assert.equal(out.charCodeAt(out.length - 1), 0x2026, 'terminated with a horizontal-ellipsis (…)');
});

test('sanitizeLocalCollectorGapDetails: text at/under 300 chars is NOT ellipsized', () => {
  const exactlyShort = 'a diagnostic that is comfortably under three hundred characters';
  const out = sanitizeLocalCollectorGapDetails(exactlyShort);
  assert.equal(out, exactlyShort);
  assert.notEqual(out.charCodeAt(out.length - 1), 0x2026, 'no ellipsis when under the cap');
});
