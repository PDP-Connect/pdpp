// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pins the AS purpose_code syntax contract (spec-core.md:428): a purpose_code
// MUST be a syntactically valid absolute URI; the AS rejects malformed/non-URI
// codes, but MUST NOT reject a code merely for being unrecognized (registry
// membership is advisory). Drives normalizeAuthorizationDetail via initiateGrant.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initDb } from '../server/db.js';
import { initiateGrant, registerConnector, registerDynamicClient } from '../server/auth.js';

let registeredClientId = null;

const MANIFEST = {
  connector_id: 'demo',
  version: '1.0.0',
  streams: [
    {
      name: 'items',
      primary_key: ['id'],
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      selection: { fields: true },
    },
  ],
};

function baseRequest(purposeCode) {
  return {
    client_id: registeredClientId,
    authorization_details: [
      {
        type: 'https://pdpp.org/data-access',
        purpose_code: purposeCode,
        purpose_description: 'purpose-code syntax coverage',
        access_mode: 'single_use',
        source: { kind: 'connector', id: 'demo' },
        streams: [{ name: 'items', fields: ['id'] }],
      },
    ],
  };
}

async function purposeCodeOutcome(purposeCode) {
  initDb(':memory:');
  await registerConnector(MANIFEST);
  const reg = await registerDynamicClient({
    client_name: 'purpose-code-test',
    redirect_uris: ['https://example.com/cb'],
  });
  registeredClientId = reg.client_id;
  try {
    await initiateGrant(baseRequest(purposeCode));
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

test('a recognized absolute-URI purpose_code is accepted', async () => {
  const out = await purposeCodeOutcome('https://pdpp.org/purpose/analytics');
  assert.equal(out.ok, true, `expected accept, got ${JSON.stringify(out)}`);
});

test('an UNKNOWN absolute-URI purpose_code is still accepted (registry is advisory)', async () => {
  const out = await purposeCodeOutcome('https://example.com/purpose/brand-new-unregistered');
  assert.equal(out.ok, true, `unknown absolute URIs must not be rejected: ${JSON.stringify(out)}`);
});

test('a bare non-URI purpose_code is rejected with invalid_request', async () => {
  const out = await purposeCodeOutcome('analytics');
  assert.equal(out.ok, false, 'bare token must be rejected');
  assert.equal(out.code, 'invalid_request');
  assert.match(out.message, /purpose_code/);
});

test('a dotted non-URI purpose_code is rejected', async () => {
  const out = await purposeCodeOutcome('assist.summarize');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid_request');
});
