// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for isLocalOrPrivateRequestOrigin in server/metadata.ts.
// No test imports it by name. This SECURITY-relevant classifier decides whether an
// inbound request originates from a local/private network — it gates local-only
// privileged behavior (e.g. accepting the reference-local DCR default token). A
// misclassification either exposes a local-only privilege to the public internet or
// breaks local development.
//
// The request is a minimal Express-shaped object exposing the Host header via
// req.get('host'); the classification runs over that host.
//
// Mutation surface:
//   - loopback (localhost, 127.x, ::1) + *.local -> private/local.
//   - RFC 1918 ranges 10.x, 172.16-31.x, 192.168.x + link-local 169.254.x -> private.
//   - the 172.16-31 boundary (172.32.x is PUBLIC).
//   - IPv6 ULA (fc/fd) + link-local (fe80:) -> private.
//   - public IPs and domains -> NOT local/private.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isLocalOrPrivateRequestOrigin } from '../server/metadata.ts';

function reqWithHost(host) {
  return {
    headers: { host },
    get(name) {
      return String(name).toLowerCase() === 'host' ? host : undefined;
    },
  };
}

function classify(host) {
  return isLocalOrPrivateRequestOrigin(reqWithHost(host));
}

test('isLocalOrPrivateRequestOrigin: loopback hosts are local', () => {
  assert.equal(classify('localhost:3000'), true);
  assert.equal(classify('127.0.0.1'), true);
  assert.equal(classify('127.5.5.5'), true, 'the whole 127/8 loopback block is local');
  assert.equal(classify('[::1]'), true, 'IPv6 loopback');
});

test('isLocalOrPrivateRequestOrigin: .local mDNS hosts are local', () => {
  assert.equal(classify('mymac.local'), true);
});

test('isLocalOrPrivateRequestOrigin: RFC 1918 private ranges are local', () => {
  assert.equal(classify('10.0.0.1'), true, '10/8');
  assert.equal(classify('192.168.1.1'), true, '192.168/16');
  assert.equal(classify('172.16.0.1'), true, '172.16 (start of the range)');
  assert.equal(classify('172.31.255.255'), true, '172.31 (end of the range)');
  assert.equal(classify('169.254.1.1'), true, '169.254 link-local');
});

test('isLocalOrPrivateRequestOrigin: the 172.16-31 boundary excludes 172.32 (PUBLIC)', () => {
  assert.equal(classify('172.15.0.1'), false, '172.15 is below the private range -> public');
  assert.equal(classify('172.32.0.1'), false, '172.32 is above the private range -> public');
});

test('isLocalOrPrivateRequestOrigin: IPv6 ULA and link-local are local', () => {
  assert.equal(classify('[fc00::1]'), true, 'fc00::/7 ULA');
  assert.equal(classify('[fd12:3456::1]'), true, 'fd ULA');
  assert.equal(classify('[fe80::1]'), true, 'fe80 link-local');
});

test('isLocalOrPrivateRequestOrigin: public IPs and domains are NOT local', () => {
  assert.equal(classify('8.8.8.8'), false, 'public IPv4');
  assert.equal(classify('1.1.1.1'), false);
  assert.equal(classify('pdpp.example.com'), false, 'public domain');
  assert.equal(classify('app.vercel.app'), false);
  assert.equal(classify('11.0.0.1'), false, '11.x is NOT in the 10.x private block');
});
