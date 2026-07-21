/**
 * Mutation-killing unit tests for the pure DCR-policy helpers in
 * `server/dcr-configuration.js`. No test imports this module by name.
 *
 * Covered:
 *   - resolvePreRegisteredPublicClients (opts override vs default copy)
 *   - createPublicDcrRateLimiter
 *       (config===false bypass; per-key token bucket that returns null up to
 *        `max` then a positive retry-after; independent keys; the Math.max(1,…)
 *        clamps on max/windowMs)
 *   - publicClientMetadataForAuthorizationServer
 *       (blank client_id dropped; client_name / token_endpoint_auth_method
 *        defaults)
 *
 * The rate-limiter cases are made deterministic by using a large `windowMs`
 * and driving successive `check()` calls within the same wall-clock window,
 * so the count threshold — not the clock — decides the outcome. The
 * retry-after magnitude is asserted as "a positive number" (not an exact
 * value) to stay clock-independent while still killing a mutant that flips
 * the threshold or drops the throttle.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPublicDcrRateLimiter,
  publicClientMetadataForAuthorizationServer,
  resolvePreRegisteredPublicClients,
} from '../server/dcr-configuration.js';

test('resolvePreRegisteredPublicClients: opts override wins; default is a non-empty fresh copy', () => {
  const custom = [{ client_id: 'cli_custom' }];
  assert.equal(resolvePreRegisteredPublicClients({ preRegisteredPublicClients: custom }), custom);

  const def1 = resolvePreRegisteredPublicClients();
  const def2 = resolvePreRegisteredPublicClients();
  assert.ok(Array.isArray(def1) && def1.length > 0, 'default clients should be a non-empty array');
  // Each call returns a fresh copy (mutating one must not affect the next).
  assert.notEqual(def1, def2, 'default must be a fresh array each call');
  assert.notEqual(def1[0], def2[0], 'default entries must be fresh objects (deep-ish copy)');
});

test('createPublicDcrRateLimiter: config===false disables throttling entirely', () => {
  const limiter = createPublicDcrRateLimiter(false);
  // Never throttles regardless of how many calls arrive.
  for (let i = 0; i < 500; i += 1) {
    assert.equal(limiter.check({ ip: '1.2.3.4' }), null);
  }
});

test('createPublicDcrRateLimiter: allows up to `max` per key, then returns a positive retry-after', () => {
  const limiter = createPublicDcrRateLimiter({ max: 2, windowMs: 60_000 });
  const req = { ip: '9.9.9.9' };

  // First `max` calls are allowed (null).
  assert.equal(limiter.check(req), null, 'call 1 within budget');
  assert.equal(limiter.check(req), null, 'call 2 within budget (== max)');

  // The next call is throttled -> a POSITIVE retry-after (seconds).
  const retry = limiter.check(req);
  assert.equal(typeof retry, 'number', 'throttled call must return a number');
  assert.ok(retry > 0, `retry-after must be positive, got ${retry}`);

  // A DIFFERENT key has its own independent budget.
  assert.equal(limiter.check({ ip: '8.8.8.8' }), null, 'independent key is not throttled');
});

test('createPublicDcrRateLimiter: max is clamped to at least 1', () => {
  // max: 0 would disable throttling if not clamped; Math.max(1, 0) -> 1 means
  // the very first call consumes the budget and the second is throttled.
  const limiter = createPublicDcrRateLimiter({ max: 0, windowMs: 60_000 });
  const req = { ip: '7.7.7.7' };
  assert.equal(limiter.check(req), null, 'first call allowed');
  const retry = limiter.check(req);
  assert.ok(typeof retry === 'number' && retry > 0, `second call must throttle (max clamped to 1), got ${retry}`);
});

test('publicClientMetadataForAuthorizationServer: drops blank ids, defaults name + auth method', () => {
  const out = publicClientMetadataForAuthorizationServer([
    { client_id: '  cli_a  ', metadata: { client_name: '  App A  ', token_endpoint_auth_method: 'client_secret_basic' } },
    { client_id: 'cli_b' }, // no metadata -> defaults
    { client_id: '   ' }, // blank -> dropped
    { metadata: { client_name: 'ghost' } }, // no client_id -> dropped
  ]);

  assert.equal(out.length, 2, 'only the two entries with a non-blank client_id survive');

  const [a, b] = out;
  // Trimmed id + trimmed name + explicit auth method preserved.
  assert.deepEqual(a, {
    client_id: 'cli_a',
    client_name: 'App A',
    token_endpoint_auth_method: 'client_secret_basic',
  });
  // Missing metadata -> client_name defaults to client_id, auth method to 'none'.
  assert.deepEqual(b, {
    client_id: 'cli_b',
    client_name: 'cli_b',
    token_endpoint_auth_method: 'none',
  });

  // Empty input -> empty array (default param branch).
  assert.deepEqual(publicClientMetadataForAuthorizationServer(), []);
});
