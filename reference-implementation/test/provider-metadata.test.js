import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

async function closeServer(server) {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 2000);

    srv.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { status: resp.status, body };
}


test('ephemeral local servers ignore leaked public-url env when computing metadata', async () => {
  const previous = {
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    AS_ISSUER: process.env.AS_ISSUER,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  process.env.AS_PUBLIC_URL = 'https://wrong-as.example';
  process.env.AS_ISSUER = 'https://wrong-issuer.example';
  process.env.RS_PUBLIC_URL = 'https://wrong-rs.example';

  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsUrl);
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asUrl);
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${asUrl}/oauth/device_authorization`);
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('provider metadata routes expose current honest capability set', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsUrl);
    assert.equal(protectedResource.body.resource_name, 'PDPP Reference Provider Resource Server');
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);
    assert.deepEqual(protectedResource.body.bearer_methods_supported, ['header']);
    assert.equal(protectedResource.body.pdpp_provider_connect_version, 'draft-2026-04-16');
    assert.equal(protectedResource.body.pdpp_self_export_supported, true);
    assert.deepEqual(protectedResource.body.pdpp_token_kinds_supported, ['owner', 'client']);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${rsUrl}/v1`);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asUrl);
    assert.equal(authorizationServer.body.introspection_endpoint, `${asUrl}/introspect`);
    assert.equal(authorizationServer.body.pushed_authorization_request_endpoint, `${asUrl}/oauth/par`);
    assert.equal(authorizationServer.body.registration_endpoint, `${asUrl}/oauth/register`);
    assert.equal('authorization_endpoint' in authorizationServer.body, false);
    assert.equal('response_types_supported' in authorizationServer.body, false);
    assert.equal('code_challenge_methods_supported' in authorizationServer.body, false);
    assert.deepEqual(authorizationServer.body.pdpp_provider_connect_capabilities, ['owner_self_export', 'cli_device_connect', 'third_party_client_connect']);
    assert.deepEqual(authorizationServer.body.pdpp_registration_modes_supported, ['dynamic', 'pre_registered_public']);
    assert.deepEqual(authorizationServer.body.pdpp_authorization_details_types_supported, ['https://pdpp.org/data-access']);
    assert.equal(authorizationServer.body.token_endpoint, `${asUrl}/oauth/token`);
    assert.deepEqual(authorizationServer.body.token_endpoint_auth_methods_supported, ['none']);
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${asUrl}/oauth/device_authorization`);
    assert.deepEqual(authorizationServer.body.grant_types_supported, ['urn:ietf:params:oauth:grant-type:device_code']);
  } finally {
    await closeServer(server);
  }
});

test('provider metadata omits registration endpoint when no initial access token is configured', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal('registration_endpoint' in authorizationServer.body, false);
    assert.deepEqual(authorizationServer.body.pdpp_registration_modes_supported, ['pre_registered_public']);
  } finally {
    await closeServer(server);
  }
});

test('provider metadata omits registration endpoint when dynamic registration is disabled', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    enableDynamicClientRegistration: false,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal('registration_endpoint' in authorizationServer.body, false);
    assert.deepEqual(authorizationServer.body.pdpp_registration_modes_supported, ['pre_registered_public']);
  } finally {
    await closeServer(server);
  }
});


test('native provider metadata surfaces the native provider name', async () => {
  const nativeManifest = {
    provider_id: 'northstar_hr',
    storage_binding: { connector_id: 'northstar_hr_native' },
    name: 'Northstar HR',
    streams: [],
  };
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    nativeManifest,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource_name, 'Northstar HR Resource Server');
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asUrl);
  } finally {
    await closeServer(server);
  }
});

test('native startup rejects manifests missing provider_id', async () => {
  await assert.rejects(
    startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      nativeManifest: {
        storage_binding: { connector_id: 'northstar_hr_native' },
        name: 'Northstar HR',
        streams: [],
      },
    }),
    /Native manifest must include provider_id/
  );
});

test('native startup rejects manifests missing storage_binding.connector_id', async () => {
  await assert.rejects(
    startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      nativeManifest: {
        provider_id: 'northstar_hr',
        name: 'Northstar HR',
        streams: [],
      },
    }),
    /Native manifest must include storage_binding\.connector_id/
  );
});

test('native startup rejects manifests that include connector_id', async () => {
  await assert.rejects(
    startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      nativeManifest: {
        connector_id: 'https://registry.pdpp.org/connectors/not-actually-native',
        provider_id: 'northstar_hr',
        storage_binding: { connector_id: 'northstar_hr_native' },
        name: 'Northstar HR',
        streams: [],
      },
    }),
    /Native manifest must not include connector_id/
  );
});

test('native startup rejects manifests whose storage_binding includes unsupported fields', async () => {
  await assert.rejects(
    startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      nativeManifest: {
        provider_id: 'northstar_hr',
        storage_binding: {
          connector_id: 'northstar_hr_native',
          debug_context: 'should_not_be_accepted',
        },
        name: 'Northstar HR',
        streams: [],
      },
    }),
    /Native manifest storage_binding must include only connector_id/
  );
});
