/**
 * Unit coverage for the UNTESTED trust-gate projection
 * `isTrustedMetadataRequestOrigin` (`server/metadata.ts`). It decides whether a
 * request's origin is trusted enough to receive forwarded-origin-safe metadata
 * (e.g. owner-agent onboarding). This test OBSERVES the decision surface; it
 * does not change any behavior.
 *
 * Contract pinned:
 *   - When the effective public URL does NOT come from the request origin (an
 *     explicit non-loopback URL, no forwarded origin) and forceHostDerived is
 *     not set, the origin is trusted BY CONSTRUCTION => returns true early.
 *   - On the host-derived path (forceHostDerived, or the explicit URL resolves
 *     back to the request origin): a private/loopback request host is trusted;
 *     otherwise trust requires membership in `trustedHosts` (exact host, or a
 *     `*.domain` wildcard that matches a strict subdomain — never the bare
 *     domain).
 *   - A request with no resolvable host is not trusted.
 *
 * Pure — the only import is `node:net`. A tiny request duck-type shim stands in
 * for Express/Fastify. No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isTrustedMetadataRequestOrigin } from '../server/metadata.ts';

function req(headers = {}, protocol = 'https') {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { protocol, get: (name) => lower[name.toLowerCase()] };
}

const HOST_DERIVED = { forceHostDerived: true };

test('isTrustedMetadataRequestOrigin: an explicit non-loopback URL (not host-derived) is trusted by construction', () => {
  // The explicit public URL does not resolve back to the request origin and
  // there is no forwarded origin, so the host-derived check is skipped => true.
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'pub.example.com' }), 'https://real.example.com'),
    true,
  );
});

test('isTrustedMetadataRequestOrigin: host-derived path trusts a private/loopback request host', () => {
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: '10.0.0.1' }, 'http'), 'https://real.example.com', null, HOST_DERIVED),
    true,
    'RFC1918 host is trusted',
  );
  // Also reachable without forceHostDerived when there is no explicit URL (the
  // effective URL IS the request origin).
  assert.equal(isTrustedMetadataRequestOrigin(req({ host: '127.0.0.1' }, 'http')), true, 'loopback, no explicit URL');
});

test('isTrustedMetadataRequestOrigin: host-derived + public host + no trusted hosts is NOT trusted', () => {
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'pub.example.com' }), 'https://real.example.com', null, HOST_DERIVED),
    false,
  );
});

test('isTrustedMetadataRequestOrigin: host-derived + public host present in the trusted-host list is trusted', () => {
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'pub.example.com' }), 'https://real.example.com', 'pub.example.com', HOST_DERIVED),
    true,
    'exact trusted host',
  );
  // A comma/space-separated trusted-host string is split; any match trusts.
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'pub.example.com' }), 'https://real.example.com', 'a.example.com, pub.example.com', HOST_DERIVED),
    true,
    'match anywhere in the list',
  );
});

test('isTrustedMetadataRequestOrigin: a *.domain wildcard trusts a strict subdomain but NOT the bare domain', () => {
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'api.example.com' }), 'https://real.example.com', '*.example.com', HOST_DERIVED),
    true,
    'subdomain matches the wildcard',
  );
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'example.com' }), 'https://real.example.com', '*.example.com', HOST_DERIVED),
    false,
    'the bare domain is NOT a subdomain match',
  );
});

test('isTrustedMetadataRequestOrigin: an unrelated trusted host does not trust a different request host', () => {
  assert.equal(
    isTrustedMetadataRequestOrigin(req({ host: 'evil.example.net' }), 'https://real.example.com', 'pub.example.com', HOST_DERIVED),
    false,
  );
});

test('isTrustedMetadataRequestOrigin: a request with no resolvable host is not trusted', () => {
  assert.equal(isTrustedMetadataRequestOrigin(req({}), 'https://real.example.com', null, HOST_DERIVED), false, 'no host header');
});
