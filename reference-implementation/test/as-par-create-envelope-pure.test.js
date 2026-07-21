// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit test for the RFC 9126 Pushed Authorization Request create
// operation in operations/as-par-create/index.ts. No test imports it by name. It
// projects the grant-initiation result into the PAR response envelope (request_uri,
// authorization_url, expires_in) at status 201 and extracts the trace context.
//
// Mutation surface:
//   - status is 201.
//   - envelope surfaces exactly request_uri / authorization_url / expires_in from
//     the initiateGrant result.
//   - traceContext = result.trace_context ?? null.
//   - input.body + baseUrl + nativeManifest are forwarded to initiateGrant.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsParCreate } from '../operations/as-par-create/index.ts';

test('executeAsParCreate: projects the RFC 9126 PAR envelope at status 201', async () => {
  const out = await executeAsParCreate(
    { body: { client_id: 'cli' }, baseUrl: 'https://as', nativeManifest: null },
    {
      initiateGrant: () => ({
        request_uri: 'urn:ietf:params:oauth:request_uri:abc',
        authorization_url: 'https://as/oauth/authorize?request_uri=...',
        expires_in: 90,
        trace_context: { trace_id: 'T' },
        // an internal field that must NOT appear in the envelope
        grant_storage_binding: { connector_id: 'gmail' },
      }),
    },
  );
  assert.equal(out.status, 201);
  assert.deepEqual(out.envelope, {
    request_uri: 'urn:ietf:params:oauth:request_uri:abc',
    authorization_url: 'https://as/oauth/authorize?request_uri=...',
    expires_in: 90,
  }, 'envelope surfaces exactly the three PAR fields');
  assert.ok(!('grant_storage_binding' in out.envelope), 'internal fields are not projected into the envelope');
  assert.deepEqual(out.traceContext, { trace_id: 'T' });
});

test('executeAsParCreate: forwards body + baseUrl + nativeManifest to initiateGrant', async () => {
  let received = null;
  const manifest = { provider_id: 'acme' };
  await executeAsParCreate(
    { body: { a: 1 }, baseUrl: 'https://as', nativeManifest: manifest },
    {
      initiateGrant: (body, opts) => {
        received = { body, opts };
        return { request_uri: 'u', authorization_url: 'a', expires_in: 1 };
      },
    },
  );
  assert.deepEqual(received.body, { a: 1 });
  assert.equal(received.opts.baseUrl, 'https://as');
  assert.equal(received.opts.nativeManifest, manifest);
});

test('executeAsParCreate: an absent trace_context yields a null traceContext', async () => {
  const out = await executeAsParCreate(
    { body: {}, baseUrl: 'https://as', nativeManifest: null },
    { initiateGrant: () => ({ request_uri: 'u', authorization_url: 'a', expires_in: 60 }) },
  );
  assert.equal(out.traceContext, null);
});
