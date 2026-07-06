// Pure, no-DB unit tests for server/dcr-configuration.js — DCR (Dynamic Client
// Registration) policy config + the public-DCR per-IP rate limiter + AS public
// client metadata projection. No test imports this module by name; all 6 exports
// were uncovered.
//
// RED note: DCR is an auth-surface. These tests only OBSERVE the config
// resolution + rate-limit accounting; no token is issued, minted, or validated
// and no security source is modified.
//
// Mutation surface:
//   createPublicDcrRateLimiter -- the `count >= max` threshold (Nth allowed,
//     (N+1)th rate-limited with a positive retry-after) and the `config === false`
//     disable path. Deterministic within one window (no wall-clock sleep needed).
//   publicClientMetadataForAuthorizationServer -- client_id trim + drop-empty,
//     client_name fallback to client_id, token_endpoint_auth_method default 'none'.
//   resolveDynamicClientRegistrationEnabled / *InitialAccessTokens[ForRequest] --
//     opts precedence + public-origin default-token stripping.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPublicDcrRateLimiter,
  publicClientMetadataForAuthorizationServer,
  resolveDynamicClientRegistrationEnabled,
  resolveDynamicClientRegistrationInitialAccessTokens,
  resolveDynamicClientRegistrationInitialAccessTokensForRequest,
} from '../server/dcr-configuration.js';
import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from '../server/reference-local-defaults.ts';

// ---------------------------------------------------------------------------
// createPublicDcrRateLimiter
// ---------------------------------------------------------------------------

test('createPublicDcrRateLimiter: allows exactly `max` attempts then rate-limits with positive retry-after', () => {
  const rl = createPublicDcrRateLimiter({ max: 3, windowMs: 60_000 });
  const req = { ip: '203.0.113.7' };
  assert.equal(rl.check(req), null, 'attempt 1 allowed');
  assert.equal(rl.check(req), null, 'attempt 2 allowed');
  assert.equal(rl.check(req), null, 'attempt 3 allowed (== max)');
  const retryAfter = rl.check(req);
  assert.ok(typeof retryAfter === 'number' && retryAfter > 0, `attempt 4 rate-limited, got ${retryAfter}`);
});

test('createPublicDcrRateLimiter: accounting is per-IP (distinct IPs do not share a budget)', () => {
  const rl = createPublicDcrRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(rl.check({ ip: 'a' }), null, 'first IP first attempt allowed');
  assert.ok(rl.check({ ip: 'a' }) > 0, 'first IP second attempt limited');
  assert.equal(rl.check({ ip: 'b' }), null, 'second IP still has its own budget');
});

test('createPublicDcrRateLimiter: config===false disables limiting entirely', () => {
  const rl = createPublicDcrRateLimiter(false);
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(rl.check({ ip: 'x' }), null, 'disabled limiter never limits');
  }
});

test('createPublicDcrRateLimiter: falls back to socket/connection remoteAddress for the key', () => {
  const rl = createPublicDcrRateLimiter({ max: 1, windowMs: 60_000 });
  const req = { socket: { remoteAddress: '198.51.100.4' } };
  assert.equal(rl.check(req), null, 'first attempt via socket key allowed');
  assert.ok(rl.check(req) > 0, 'same socket key is limited on the second attempt');
});

// ---------------------------------------------------------------------------
// publicClientMetadataForAuthorizationServer
// ---------------------------------------------------------------------------

test('publicClientMetadataForAuthorizationServer: trims client_id and drops entries without one', () => {
  const out = publicClientMetadataForAuthorizationServer([
    { client_id: '  keep  ', metadata: {} },
    { client_id: '', metadata: {} }, // dropped
    { client_id: '   ', metadata: {} }, // whitespace-only -> dropped
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].client_id, 'keep');
});

test('publicClientMetadataForAuthorizationServer: client_name falls back to client_id, auth method defaults to none', () => {
  const out = publicClientMetadataForAuthorizationServer([{ client_id: 'cid', metadata: {} }]);
  assert.deepEqual(out[0], {
    client_id: 'cid',
    client_name: 'cid', // fallback
    token_endpoint_auth_method: 'none', // default
  });
});

test('publicClientMetadataForAuthorizationServer: honors provided client_name and auth method (trimmed)', () => {
  const out = publicClientMetadataForAuthorizationServer([
    { client_id: 'cid', metadata: { client_name: '  My App  ', token_endpoint_auth_method: '  client_secret_basic  ' } },
  ]);
  assert.equal(out[0].client_name, 'My App');
  assert.equal(out[0].token_endpoint_auth_method, 'client_secret_basic');
});

// ---------------------------------------------------------------------------
// resolveDynamicClientRegistrationEnabled
// ---------------------------------------------------------------------------

test('resolveDynamicClientRegistrationEnabled: explicit opts win over the env default', () => {
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: false }), false);
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: true }), true);
});

// ---------------------------------------------------------------------------
// resolveDynamicClientRegistrationInitialAccessTokens
// ---------------------------------------------------------------------------

test('resolveDynamicClientRegistrationInitialAccessTokens: explicit opts array wins and is filtered of blanks', () => {
  assert.deepEqual(
    resolveDynamicClientRegistrationInitialAccessTokens({ dynamicClientRegistrationInitialAccessTokens: ['t1', '', 't2'] }),
    ['t1', 't2'],
  );
  // An explicit empty array is honored (public self-registration without bootstrap tokens).
  assert.deepEqual(
    resolveDynamicClientRegistrationInitialAccessTokens({ dynamicClientRegistrationInitialAccessTokens: [] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// resolveDynamicClientRegistrationInitialAccessTokensForRequest (origin filter)
// ---------------------------------------------------------------------------

function mkReq(host) {
  return {
    headers: { host },
    get(name) {
      return String(name).toLowerCase() === 'host' ? host : undefined;
    },
  };
}

test('*ForRequest: a LOCAL/private origin keeps all tokens including the local default', () => {
  const tokens = ['operator-token', DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN];
  const out = resolveDynamicClientRegistrationInitialAccessTokensForRequest(mkReq('localhost:3000'), tokens);
  assert.deepEqual(out, tokens, 'local origin keeps the local default token');
});

test('*ForRequest: a PUBLIC origin strips the local default token but keeps operator tokens', () => {
  const tokens = ['operator-token', DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN];
  const out = resolveDynamicClientRegistrationInitialAccessTokensForRequest(mkReq('pdpp.example.com'), tokens);
  assert.deepEqual(out, ['operator-token'], 'public origin must not accept the local convenience token');
  assert.ok(!out.includes(DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN), 'local default stripped for public origin');
});
