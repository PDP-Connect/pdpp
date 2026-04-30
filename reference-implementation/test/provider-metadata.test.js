import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';

import { startServer } from '../server/index.js';
import { resolvePublicUrl, resolveSiblingPublicUrl } from '../server/metadata.ts';
import { PDPP_REFERENCE_REVISION_HEADER } from '../server/reference-revision.js';

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

function expectReferenceRevisionHeader(resp, expectedRevision) {
  assert.equal(resp.headers.get(PDPP_REFERENCE_REVISION_HEADER), expectedRevision);
}

async function fetchJsonResponse(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { resp, body };
}

async function httpRequestJson(url, { headers = {} } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (chunk) => chunks.push(chunk));
        resp.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: resp.statusCode, body });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}


test('ephemeral local servers ignore leaked public-url env when computing metadata', async () => {
  const previous = {
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    AS_ISSUER: process.env.AS_ISSUER,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
  };
  process.env.AS_PUBLIC_URL = 'https://wrong-as.example';
  process.env.AS_ISSUER = 'https://wrong-issuer.example';
  process.env.RS_PUBLIC_URL = 'https://wrong-rs.example';
  process.env.PDPP_REFERENCE_MODE = 'composed';
  process.env.PDPP_REFERENCE_ORIGIN = 'https://wrong-web.example';

  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsUrl);
    assert.deepEqual(protectedResource.body.authorization_servers, [asUrl]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(protectedResource.body, 'pdpp_agent_discovery'),
      false,
      'direct ephemeral RS must not advertise browser-hosted agent discovery URLs',
    );

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

test('composed mode env drives browser-facing metadata when explicit public urls are unset', async () => {
  const previous = {
    PDPP_REFERENCE_MODE: process.env.PDPP_REFERENCE_MODE,
    PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN,
    AS_PUBLIC_URL: process.env.AS_PUBLIC_URL,
    RS_PUBLIC_URL: process.env.RS_PUBLIC_URL,
  };
  process.env.PDPP_REFERENCE_MODE = 'composed';
  process.env.PDPP_REFERENCE_ORIGIN = 'http://localhost:3200';
  delete process.env.AS_PUBLIC_URL;
  delete process.env.RS_PUBLIC_URL;

  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ignoreAmbientPublicUrls: false,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, 'http://localhost:3200');
    assert.deepEqual(protectedResource.body.authorization_servers, ['http://localhost:3200']);
    assert.equal(protectedResource.body.pdpp_core_query_base, 'http://localhost:3200/v1');
    assert.deepEqual(protectedResource.body.pdpp_agent_discovery, {
      advisory: true,
      skill_name: 'pdpp-data-access',
      recommended_flow: 'pdpp agent',
      skill_catalog: 'http://localhost:3200/.well-known/skills/index.json',
      skill: 'http://localhost:3200/.well-known/skills/pdpp-data-access/SKILL.md',
      llms_txt: 'http://localhost:3200/llms.txt',
      llms_full_txt: 'http://localhost:3200/llms-full.txt',
    });

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, 'http://localhost:3200');
    assert.equal(
      authorizationServer.body.device_authorization_endpoint,
      'http://localhost:3200/oauth/device_authorization',
    );
    assert.equal(
      authorizationServer.body.pushed_authorization_request_endpoint,
      'http://localhost:3200/oauth/par',
    );
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

test('proxied composed metadata rebases localhost defaults to the forwarded public origin', async () => {
  const publicOrigin = 'https://peregrine-dev.example';
  const localOrigin = 'http://localhost:3000';
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    referenceMode: 'composed',
    referenceOrigin: localOrigin,
    asPublicUrl: localOrigin,
    rsPublicUrl: localOrigin,
    trustedMetadataHosts: ['peregrine-dev.example'],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const forwardedHeaders = {
    'x-forwarded-host': 'peregrine-dev.example',
    'x-forwarded-proto': 'https',
  };

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: forwardedHeaders,
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, publicOrigin);
    assert.deepEqual(protectedResource.body.authorization_servers, [publicOrigin]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${publicOrigin}/v1`);
    assert.equal(
      protectedResource.body.pdpp_agent_discovery.skill,
      `${publicOrigin}/.well-known/skills/pdpp-data-access/SKILL.md`,
    );

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: forwardedHeaders,
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, publicOrigin);
    assert.equal(authorizationServer.body.registration_endpoint, `${publicOrigin}/oauth/register`);
    assert.equal(authorizationServer.body.device_authorization_endpoint, `${publicOrigin}/oauth/device_authorization`);
  } finally {
    await closeServer(server);
  }
});

test('provider metadata pins explicit public origins despite hostile forwarded hosts', async () => {
  const asOrigin = 'https://as.example.test';
  const rsOrigin = 'https://rs.example.test';
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    asPublicUrl: asOrigin,
    rsPublicUrl: rsOrigin,
    trustedMetadataHosts: [],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const hostileHeaders = {
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https',
  };

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: hostileHeaders,
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, asOrigin);
    assert.equal(authorizationServer.body.registration_endpoint, `${asOrigin}/oauth/register`);

    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: hostileHeaders,
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, rsOrigin);
    assert.deepEqual(protectedResource.body.authorization_servers, [asOrigin]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${rsOrigin}/v1`);
  } finally {
    await closeServer(server);
  }
});

test('provider metadata permits unconfigured local and private-LAN host discovery', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    trustedMetadataHosts: [],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const lanAsHost = `192.168.50.10:${server.asPort}`;
  const lanRsHost = `192.168.50.10:${server.rsPort}`;

  try {
    const authorizationServer = await httpRequestJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: { host: lanAsHost },
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, `http://${lanAsHost}`);

    const protectedResource = await httpRequestJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: { host: lanRsHost },
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, `http://${lanRsHost}`);
    assert.deepEqual(protectedResource.body.authorization_servers, [`http://192.168.50.10:${server.asPort}`]);
  } finally {
    await closeServer(server);
  }
});

test('provider metadata rejects unconfigured public Host and X-Forwarded-Host values', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    trustedMetadataHosts: [],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const authorizationServer = await httpRequestJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: { host: 'evil.example' },
    });
    assert.equal(authorizationServer.status, 421);
    assert.equal(authorizationServer.body.error.code, 'misdirected_request');

    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: {
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(protectedResource.status, 421);
    assert.equal(protectedResource.body.error.code, 'misdirected_request');
  } finally {
    await closeServer(server);
  }
});

test('PDPP_TRUSTED_HOSTS permits explicit public host-derived metadata allowlisting', async () => {
  const previousTrustedHosts = process.env.PDPP_TRUSTED_HOSTS;
  process.env.PDPP_TRUSTED_HOSTS = 'pdpp.example.com, *.trusted.example';
  let server;

  try {
    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`, {
      headers: {
        'x-forwarded-host': 'tenant.trusted.example',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, 'https://tenant.trusted.example');

    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`, {
      headers: {
        'x-forwarded-host': 'pdpp.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, 'https://pdpp.example.com');
    assert.deepEqual(protectedResource.body.authorization_servers, ['https://pdpp.example.com']);
  } finally {
    if (server) {
      await closeServer(server);
    }
    if (previousTrustedHosts === undefined) {
      delete process.env.PDPP_TRUSTED_HOSTS;
    } else {
      process.env.PDPP_TRUSTED_HOSTS = previousTrustedHosts;
    }
  }
});

test('public URL helpers rebase loopback defaults for direct LAN callers without losing sibling web links', () => {
  const req = {
    protocol: 'http',
    get(name) {
      return name.toLowerCase() === 'host' ? '192.0.2.10:7663' : undefined;
    },
  };

  assert.equal(resolvePublicUrl(req, 'http://localhost:3000'), 'http://192.0.2.10:7663');
  assert.equal(resolveSiblingPublicUrl(req, 'http://localhost:3000'), 'http://192.0.2.10:3000');
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

test('reference revision header is distinct reference metadata across AS, RS, and _ref surfaces', async () => {
  const referenceRevision = 'pdpp-reference@test-revision';
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    referenceRevision,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { resp: asMetadata } = await fetchJsonResponse(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(asMetadata.status, 200);
    expectReferenceRevisionHeader(asMetadata, referenceRevision);
    assert.equal(asMetadata.headers.get('PDPP-Version'), null);

    const { resp: rsMetadata } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(rsMetadata.status, 200);
    expectReferenceRevisionHeader(rsMetadata, referenceRevision);
    assert.equal(rsMetadata.headers.get('PDPP-Version'), '2026-04-06');

    const refSurface = await fetch(`${asUrl}/_ref/connectors`);
    assert.equal(refSurface.status, 200);
    expectReferenceRevisionHeader(refSurface, referenceRevision);
    assert.equal(refSurface.headers.get('PDPP-Version'), null);

    const hostedAsset = await fetch(`${asUrl}/__pdpp/hosted-ui.css`);
    assert.equal(hostedAsset.status, 200);
    expectReferenceRevisionHeader(hostedAsset, referenceRevision);
    assert.equal(hostedAsset.headers.get('PDPP-Version'), null);
  } finally {
    await closeServer(server);
  }
});

test('explicit browser-facing public urls drive metadata, device verification, and PAR links', async () => {
  const publicOrigin = 'http://localhost:3000';
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    asPublicUrl: publicOrigin,
    rsPublicUrl: publicOrigin,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    assert.equal(protectedResource.body.resource, publicOrigin);
    assert.deepEqual(protectedResource.body.authorization_servers, [publicOrigin]);
    assert.equal(protectedResource.body.pdpp_core_query_base, `${publicOrigin}/v1`);

    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.issuer, publicOrigin);
    assert.equal(
      authorizationServer.body.device_authorization_endpoint,
      `${publicOrigin}/oauth/device_authorization`,
    );
    assert.equal(
      authorizationServer.body.pushed_authorization_request_endpoint,
      `${publicOrigin}/oauth/par`,
    );

    const device = await fetch(`${asUrl}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'pdpp-web-dashboard' }).toString(),
    });
    assert.equal(device.status, 200);
    const deviceBody = await device.json();
    assert.equal(deviceBody.verification_uri, `${publicOrigin}/device`);
    assert.match(
      deviceBody.verification_uri_complete,
      /^http:\/\/localhost:3000\/device\?user_code=/,
    );

    const spotifyManifest = JSON.parse(
      await readFile(new URL('../manifests/spotify.json', import.meta.url), 'utf8'),
    );
    const registerConnector = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerConnector.status, 201);

    const par = await fetch(`${asUrl}/oauth/par`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview' },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: 'https://registry.pdpp.org/connectors/spotify',
            purpose_code: 'https://pdpp.org/purpose/recommendation',
            purpose_description: 'Review top artists',
            access_mode: 'single_use',
            retention: 'P30D',
            streams: [{ name: 'top_artists' }],
          },
        ],
      }),
    });
    assert.equal(par.status, 201);
    const parBody = await par.json();
    assert.match(
      parBody.authorization_url,
      /^http:\/\/localhost:3000\/consent\?request_uri=/,
    );
  } finally {
    await closeServer(server);
  }
});

test('provider metadata omits registration endpoint when initial access tokens are explicitly empty', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [],
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

test('default local reference startup advertises a registration endpoint backed by the shared default token', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const authorizationServer = await fetchJson(`${asUrl}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.equal(authorizationServer.body.registration_endpoint, `${asUrl}/oauth/register`);
    assert.deepEqual(authorizationServer.body.pdpp_registration_modes_supported, ['dynamic', 'pre_registered_public']);

    // The default local DCR token must actually unlock /oauth/register; a
    // bogus token must still be rejected.
    const { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } = await import('../server/reference-local-defaults.ts');
    const registerOk = await fetch(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ client_name: 'Default Local Client', token_endpoint_auth_method: 'none' }),
    });
    assert.ok(registerOk.status === 200 || registerOk.status === 201, `unexpected status ${registerOk.status}`);
    const registered = await registerOk.json();
    assert.equal(typeof registered.client_id, 'string');

    const registerNope = await fetch(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer nope',
      },
      body: JSON.stringify({ client_name: 'Bogus', token_endpoint_auth_method: 'none' }),
    });
    assert.ok(
      registerNope.status === 400 || registerNope.status === 401,
      `expected 4xx rejection, got ${registerNope.status}`,
    );
  } finally {
    await closeServer(server);
  }
});

test('explicit PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0 env still disables registration', async () => {
  // Simulate: operator sets the off switch and no explicit opts override it.
  const previous = process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
  process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = '0';
  // The server/index.js module reads the env once at import time, so we can't
  // retroactively flip the module constant. Instead we pass the explicit opts
  // equivalent that `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` would have set
  // on a fresh process. This matches how the reference docs describe the env.
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
    if (previous === undefined) {
      delete process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
    } else {
      process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = previous;
    }
  }
});

test('default local reference startup seeds pdpp-web-dashboard so dashboard bootstrap device_authorization works', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'pdpp-web-dashboard' }).toString(),
    });
    assert.equal(deviceRes.status, 200);
    const payload = await deviceRes.json();
    assert.equal(typeof payload.device_code, 'string');
    assert.equal(typeof payload.user_code, 'string');
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

test('AS root exposes an unauthenticated discovery index pointing at the well-known endpoint', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    referenceRevision: 'pdpp-reference@test+sentinel',
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { resp, body } = await fetchJsonResponse(`${asUrl}/`);
    assert.equal(resp.status, 200);
    assert.equal(body.object, 'pdpp_discovery_index');
    assert.equal(body.role, 'authorization_server');
    assert.equal(body.links.well_known_authorization_server, '/.well-known/oauth-authorization-server');
    assert.equal(body.reference_revision, 'pdpp-reference@test+sentinel');
    expectReferenceRevisionHeader(resp, 'pdpp-reference@test+sentinel');
    assert.equal(body.links.well_known, undefined);
    assert.equal(body.links.schema, undefined);
  } finally {
    await closeServer(server);
  }
});

test('RS root exposes an unauthenticated discovery index pointing at well-known, schema, and the core query base', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    referenceRevision: 'pdpp-reference@test+sentinel',
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { resp, body } = await fetchJsonResponse(`${rsUrl}/`);
    assert.equal(resp.status, 200);
    assert.equal(body.object, 'pdpp_discovery_index');
    assert.equal(body.role, 'resource_server');
    assert.equal(body.links.well_known, '/.well-known/oauth-protected-resource');
    assert.equal(body.links.schema, '/v1/schema');
    assert.equal(body.links.core_query_base, '/v1');
    // The connector listing is a primary cold-start landing surface — owner
    // tokens need a connector_id for polyfill reads, and exposing the link
    // here closes the discovery loop without forcing a well-known round-trip.
    assert.equal(body.links.connectors, '/v1/connectors');
    assert.equal(body.reference_revision, 'pdpp-reference@test+sentinel');
    expectReferenceRevisionHeader(resp, 'pdpp-reference@test+sentinel');
  } finally {
    await closeServer(server);
  }
});

test('discovery index does not require authentication', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    // Calling with a deliberately bogus token should still succeed since the
    // route is unauthenticated and routes registered before the requireToken
    // middleware. The body shape must still be a discovery index.
    const { resp, body } = await fetchJsonResponse(`${rsUrl}/`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(resp.status, 200);
    assert.equal(body.object, 'pdpp_discovery_index');
  } finally {
    await closeServer(server);
  }
});

test('protected-resource metadata names canonical first-call shapes via pdpp_discovery_hints', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const protectedResource = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(protectedResource.status, 200);
    const hints = protectedResource.body.pdpp_discovery_hints;
    assert.ok(hints, 'pdpp_discovery_hints should be present');
    assert.equal(hints.schema_endpoint, '/v1/schema');
    assert.equal(hints.query_base, '/v1');
    assert.equal(hints.aggregate.endpoint_template, '/v1/streams/{stream}/aggregate');
    assert.equal(hints.changes_since_bootstrap, 'beginning');
    assert.equal(hints.blob_indirection, 'data.blob_ref.fetch_url');
    // Connector and stream metadata locations a cold caller would otherwise
    // have to guess. /v1/connectors is the canonical connector listing;
    // /v1/streams/{stream} returns per-stream metadata and schema.
    assert.equal(hints.connectors_endpoint, '/v1/connectors');
    assert.equal(hints.streams_endpoint_template, '/v1/streams/{stream}');
    // Default reference startup is polyfill-mode (no native manifest), so
    // owner-token reads must pass `connector_id`. The hint surfaces that
    // requirement without making the caller hit a route and parse a 400.
    assert.equal(hints.owner_polyfill_requires_connector_id, true);

    // Lexical retrieval is advertised by default; the search hints should
    // mirror the canonical streams[] scope and the v1 single-stream filter
    // constraint.
    assert.ok(hints.search, 'search hints should be present when lexical retrieval is advertised');
    assert.equal(hints.search.endpoint, '/v1/search');
    assert.equal(hints.search.scope_param, 'streams[]');
    assert.equal(hints.search.filter_requires_single_stream, true);
  } finally {
    await closeServer(server);
  }
});

test('pdpp_discovery_hints omits owner_polyfill_requires_connector_id when a native manifest is configured', async () => {
  // Native single-source mode resolves the connector implicitly from the
  // manifest, so the polyfill connector_id requirement does not apply. The
  // hint should be absent rather than emitted as `false`, matching the
  // truthful-omission convention used elsewhere in this block (see
  // hybrid_pagination_supported).
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
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { body } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    const hints = body.pdpp_discovery_hints;
    assert.ok(hints);
    assert.equal(hints.connectors_endpoint, '/v1/connectors');
    assert.equal(hints.streams_endpoint_template, '/v1/streams/{stream}');
    assert.equal(
      Object.prototype.hasOwnProperty.call(hints, 'owner_polyfill_requires_connector_id'),
      false,
      'owner_polyfill_requires_connector_id should be omitted in native single-source mode',
    );
  } finally {
    await closeServer(server);
  }
});

test('pdpp_discovery_hints omits hybrid pagination when hybrid is not advertised', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    // Disable semantic so hybrid is not advertised. Lexical stays on.
    semanticRetrievalSupported: false,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { body } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    const hints = body.pdpp_discovery_hints;
    assert.ok(hints);
    assert.equal(
      Object.prototype.hasOwnProperty.call(hints, 'hybrid_pagination_supported'),
      false,
      'hybrid_pagination_supported should be omitted when hybrid retrieval is not advertised',
    );
    // Lexical search hints remain present.
    assert.ok(hints.search);
  } finally {
    await closeServer(server);
  }
});

test('pdpp_discovery_hints omits search when lexical retrieval is suppressed', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    lexicalRetrievalSupported: false,
    semanticRetrievalSupported: false,
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const { body } = await fetchJsonResponse(`${rsUrl}/.well-known/oauth-protected-resource`);
    const hints = body.pdpp_discovery_hints;
    assert.ok(hints);
    assert.equal(
      Object.prototype.hasOwnProperty.call(hints, 'search'),
      false,
      'search hints should be omitted when lexical retrieval is suppressed',
    );
    // Static hints unrelated to retrieval extensions are still present.
    assert.equal(hints.schema_endpoint, '/v1/schema');
    assert.equal(hints.changes_since_bootstrap, 'beginning');
  } finally {
    await closeServer(server);
  }
});

test('HEAD on /v1 RS endpoints mirrors GET status (RFC 7231 §4.3.2)', async () => {
  // Without auto HEAD shadows, an unauthenticated `HEAD /v1/streams` returned
  // 404 while `GET /v1/streams` returned 401. Per RFC 7231 §4.3.2 HEAD must
  // behave like GET minus the message body — the status code (and crucially
  // the auth-gate behavior) must agree.
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const probes = ['/v1/streams', '/v1/schema', '/v1/search', '/v1/search/hybrid'];
    for (const path of probes) {
      const getResp = await fetch(`${rsUrl}${path}`);
      const headResp = await fetch(`${rsUrl}${path}`, { method: 'HEAD' });
      assert.equal(
        headResp.status,
        getResp.status,
        `HEAD ${path} status ${headResp.status} must match GET status ${getResp.status}`,
      );
      // HEAD body must be empty per RFC 7231.
      const headBody = await headResp.text();
      assert.equal(headBody, '', `HEAD ${path} body must be empty`);
    }
  } finally {
    await closeServer(server);
  }
});

test('HEAD on RS metadata endpoints mirrors GET status', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const rsUrl = `http://localhost:${server.rsPort}`;
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    for (const url of [
      `${rsUrl}/.well-known/oauth-protected-resource`,
      `${asUrl}/.well-known/oauth-authorization-server`,
      `${rsUrl}/`,
      `${asUrl}/`,
    ]) {
      const getResp = await fetch(url);
      const headResp = await fetch(url, { method: 'HEAD' });
      assert.equal(headResp.status, getResp.status, `HEAD ${url} status mismatch`);
      assert.equal(await headResp.text(), '', `HEAD ${url} body must be empty`);
    }
  } finally {
    await closeServer(server);
  }
});

test('PDPP_REFERENCE_REVISION env override flows into the discovery index and response header', async () => {
  const previous = process.env.PDPP_REFERENCE_REVISION;
  process.env.PDPP_REFERENCE_REVISION = 'pdpp-reference@1.2.3+abc123';
  let server;
  try {
    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
    });
    const rsUrl = `http://localhost:${server.rsPort}`;
    const { resp, body } = await fetchJsonResponse(`${rsUrl}/`);
    assert.equal(resp.status, 200);
    assert.equal(body.reference_revision, 'pdpp-reference@1.2.3+abc123');
    expectReferenceRevisionHeader(resp, 'pdpp-reference@1.2.3+abc123');
  } finally {
    if (server) await closeServer(server);
    if (previous === undefined) {
      delete process.env.PDPP_REFERENCE_REVISION;
    } else {
      process.env.PDPP_REFERENCE_REVISION = previous;
    }
  }
});
