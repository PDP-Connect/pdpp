import assert from 'node:assert/strict';
import test from 'node:test';

import { redactStderrTail } from '../runtime/stderr-redact.ts';

test('redactStderrTail passes through safe text unchanged', () => {
  const result = redactStderrTail('Connection refused: example.com:443');
  assert.equal(result.text, 'Connection refused: example.com:443');
  assert.equal(result.redacted, false);
});

test('redactStderrTail handles empty and non-string input', () => {
  assert.deepEqual(redactStderrTail(''), { text: '', redacted: false });
  assert.deepEqual(redactStderrTail(null), { text: '', redacted: false });
  assert.deepEqual(redactStderrTail(undefined), { text: '', redacted: false });
});

test('redactStderrTail redacts keyed credential markers', () => {
  const cases = [
    ['token=abc123secret', 'token=[REDACTED]'],
    ['password: "hunter2"', 'password=[REDACTED]'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'Authorization=[REDACTED]'],
    ['api_key=sk_live_abc123', 'api_key=[REDACTED]'],
    ['api-key: supersecret', 'api-key=[REDACTED]'],
    ['cookie=sessionid=abcdef', 'cookie=[REDACTED]'],
    ['secret=mysecretvalue', 'secret=[REDACTED]'],
    ['otp=123456 was invalid', 'otp=[REDACTED] was invalid'],
  ];
  for (const [input, expected] of cases) {
    const { text, redacted } = redactStderrTail(input);
    assert.ok(text.includes(expected), `Expected "${text}" to include "${expected}" (input: "${input}")`);
    assert.equal(redacted, true, `Expected redacted=true for input: "${input}"`);
  }
});

test('redactStderrTail redacts 6-digit OTP-shaped numbers', () => {
  const { text, redacted } = redactStderrTail('OTP verification failed with code 482910');
  assert.equal(text, 'OTP verification failed with code [REDACTED_OTP]');
  assert.equal(redacted, true);
});

test('redactStderrTail redacts long opaque strings (>=24 chars)', () => {
  const longToken = 'sk_live_abcdefghijklmnopqrstuvwxyz1234567890';
  const { text, redacted } = redactStderrTail(`API call failed with key ${longToken}`);
  assert.ok(!text.includes(longToken), 'Long token should be redacted');
  assert.equal(redacted, true);
});

test('redactStderrTail redacts URL-embedded credentials', () => {
  const cases = [
    // https with user:pass
    'fetch failed: https://myuser:mysecretpassword@api.example.com/endpoint',
    // http with user:pass
    'connecting to http://admin:p@ssw0rd@internal.host/path',
    // only user (no password)
    'error at https://serviceaccount@storage.example.com/bucket',
  ];
  for (const input of cases) {
    const { text, redacted } = redactStderrTail(input);
    assert.ok(!text.includes('mysecretpassword'), `Password should be redacted in: ${input}`);
    assert.ok(!text.includes('p@ssw0rd'), `Password should be redacted in: ${input}`);
    assert.equal(redacted, true, `Expected redacted=true for: ${input}`);
    // Protocol and host should be preserved
    assert.ok(text.includes('[REDACTED]@'), `Should contain [REDACTED]@ placeholder in: ${text}`);
  }
});

test('redactStderrTail preserves URL host after redacting userinfo', () => {
  const input = 'fetch error: https://user:secret@api.example.com/v1/data returned 401';
  const { text } = redactStderrTail(input);
  assert.ok(text.includes('api.example.com'), 'Host should be preserved after userinfo redaction');
  assert.ok(text.includes('https://[REDACTED]@api.example.com'), 'Should contain redacted form');
  assert.ok(!text.includes('secret'), 'Secret should not appear');
});

test('redactStderrTail redacts PEM private key blocks', () => {
  const pemKey = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29o2dFCnOBrO7s',
    'bmByXMadFcwN4MYtUgzOh3gCxGUFQP7DPSQqMiB7FJMF9GjfFMq9RKXPLABCD',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const input = `SSL handshake error:\n${pemKey}\nRetrying...`;
  const { text, redacted } = redactStderrTail(input);
  assert.ok(!text.includes('MIIEowIBAAK'), 'PEM body should be redacted');
  assert.ok(text.includes('[REDACTED_PEM]'), 'Should contain [REDACTED_PEM] placeholder');
  assert.equal(redacted, true);
  assert.ok(text.includes('SSL handshake error'), 'Non-PEM context should be preserved');
  assert.ok(text.includes('Retrying'), 'Text after PEM should be preserved');
});

test('redactStderrTail redacts PEM certificate blocks', () => {
  const pemCert = [
    '-----BEGIN CERTIFICATE-----',
    'MIIDazCCAlOgAwIBAgIUYzFakeBase64DataHere1234567890ABCDEF=',
    '-----END CERTIFICATE-----',
  ].join('\n');
  const { text, redacted } = redactStderrTail(`Certificate error:\n${pemCert}`);
  assert.ok(!text.includes('MIIDazCCAlO'), 'PEM body should be redacted');
  assert.ok(text.includes('[REDACTED_PEM]'), 'Should contain [REDACTED_PEM] placeholder');
  assert.equal(redacted, true);
});

test('redactStderrTail does not redact short innocuous tokens', () => {
  // Short tokens not preceded by a credential marker should pass through
  const { text, redacted } = redactStderrTail('Error code: 42, status: OK, retries: 3');
  assert.equal(text, 'Error code: 42, status: OK, retries: 3');
  assert.equal(redacted, false);
});
