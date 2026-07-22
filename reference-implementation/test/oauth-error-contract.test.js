// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function postForm(url, params) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return { resp, body: await resp.json() };
}

function assertOAuthErrorHasRequestId(resp, body) {
  assert.equal(typeof body.error, 'string');
  assert.equal(typeof body.error_description, 'string');
  assert.equal(typeof body.request_id, 'string');
  assert.equal(body.request_id.length > 0, true);
  assert.equal(resp.headers.get('Request-Id'), body.request_id);
}

test('OAuth DCR errors keep RFC shape and include request ids', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: ['test-initial-access-token'],
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await fetch(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({
        client_name: 'Rejected Client',
        token_endpoint_auth_method: 'none',
      }),
    }).then(async (resp) => ({ resp, body: await resp.json() }));

    assert.equal(resp.status, 401);
    assert.equal(body.error, 'invalid_client');
    assertOAuthErrorHasRequestId(resp, body);
  } finally {
    await closeServer(server);
  }
});

test('OAuth device authorization errors include request ids', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await postForm(`${asUrl}/oauth/device_authorization`, {});

    assert.equal(resp.status, 400);
    assert.equal(body.error, 'invalid_request');
    assertOAuthErrorHasRequestId(resp, body);
  } finally {
    await closeServer(server);
  }
});

test('OAuth token errors include request ids', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await postForm(`${asUrl}/oauth/token`, {
      grant_type: 'unsupported_grant',
      client_id: 'pdpp_cli',
      device_code: 'missing',
    });

    assert.equal(resp.status, 400);
    assert.equal(body.error, 'unsupported_grant_type');
    assertOAuthErrorHasRequestId(resp, body);
  } finally {
    await closeServer(server);
  }
});
