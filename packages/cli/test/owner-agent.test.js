import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from '../src/index.js';
import { runOwnerAgent } from '../src/owner-agent/command.js';
import { discoverOwnerAgentProfile, normalizeEntrypointUrl } from '../src/owner-agent/discovery.js';
import { resolveCredentialFile, DEFAULT_OWNER_AGENT_DIR } from '../src/owner-agent/credential-store.js';
import { OwnerAgentError } from '../src/owner-agent/errors.js';

const SECRET = 'super-secret-owner-bearer-value';
const REG_TOKEN = 'reg-access-token-value';

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (c) => { out += c; } },
      stderr: { write: (c) => { err += c; } },
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

async function withTmpHome(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pdpp-owner-agent-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// A scriptable fetch keyed by `${METHOD} ${path}` substring match.
function makeFetch(routes) {
  return async (url, opts = {}) => {
    const method = (opts.method ?? 'GET').toUpperCase();
    const u = typeof url === 'string' ? url : url.toString();
    for (const route of routes) {
      if (method === route.method && u.includes(route.match)) {
        if (typeof route.handler === 'function') {
          return route.handler({ url: u, opts });
        }
        return jsonResponse(route.status ?? 200, route.body ?? {});
      }
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

const ADVISORY_METADATA = {
  resource: 'https://ref.test',
  authorization_servers: ['https://ref.test'],
  pdpp_owner_agent_onboarding: {
    profile: 'trusted_owner_agent',
    authorization_server: 'https://ref.test',
    device_authorization_endpoint: 'https://ref.test/oauth/device_authorization',
    token_endpoint: 'https://ref.test/oauth/token',
    introspection_endpoint: 'https://ref.test/introspect',
    registration_endpoint: 'https://ref.test/oauth/register',
    revocation_path_template: 'https://ref.test/oauth/register/{client_id}',
    owner_approval_url: 'https://ref.test',
    schema_endpoint: 'https://ref.test/v1/schema',
    schema_compact_endpoint: 'https://ref.test/v1/schema?view=compact',
    streams_endpoint: 'https://ref.test/v1/streams',
    event_subscriptions_endpoint: 'https://ref.test/v1/event-subscriptions',
    mcp_owner_bearer_rejected: true,
  },
};

// ---- normalize / resolve ----------------------------------------------------

test('normalizeEntrypointUrl strips creds, query, trailing slash; defaults https', () => {
  assert.equal(normalizeEntrypointUrl('ref.test'), 'https://ref.test');
  assert.equal(normalizeEntrypointUrl('https://u:p@ref.test/path/?q=1#f'), 'https://ref.test/path');
  assert.equal(normalizeEntrypointUrl('ftp://ref.test'), null);
  assert.equal(normalizeEntrypointUrl(''), null);
});

test('resolveCredentialFile honors explicit path and expands ~', () => {
  assert.equal(
    resolveCredentialFile({ credentialFile: '/abs/daisy/pdpp-owner-agent.json', resource: 'https://ref.test', home: '/home/user' }),
    '/abs/daisy/pdpp-owner-agent.json',
  );
  assert.equal(
    resolveCredentialFile({ credentialFile: '~/applications/daisy/.pi/agent/pdpp-owner-agent.json', resource: 'https://ref.test', home: '/home/user' }),
    '/home/user/applications/daisy/.pi/agent/pdpp-owner-agent.json',
  );
});

test('resolveCredentialFile default is home-rooted, not project-local', () => {
  const p = resolveCredentialFile({ resource: 'https://ref.test:8443', home: '/home/user' });
  assert.equal(p, join('/home/user', DEFAULT_OWNER_AGENT_DIR, 'ref.test_8443.json'));
});

// ---- discovery --------------------------------------------------------------

test('discoverOwnerAgentProfile reads the advisory block', async () => {
  const fetch = makeFetch([
    { method: 'GET', match: '/.well-known/oauth-protected-resource', body: ADVISORY_METADATA },
  ]);
  const profile = await discoverOwnerAgentProfile('https://ref.test', { fetch });
  assert.equal(profile.advisory, true);
  assert.equal(profile.deviceAuthorizationEndpoint, 'https://ref.test/oauth/device_authorization');
  assert.equal(profile.tokenEndpoint, 'https://ref.test/oauth/token');
  assert.equal(profile.introspectionEndpoint, 'https://ref.test/introspect');
  assert.equal(profile.revocationPathTemplate, 'https://ref.test/oauth/register/{client_id}');
  assert.equal(profile.schemaCompactEndpoint, 'https://ref.test/v1/schema?view=compact');
});

test('discoverOwnerAgentProfile falls back to AS metadata RFC 8628 shape', async () => {
  const fetch = makeFetch([
    {
      method: 'GET',
      match: '/.well-known/oauth-protected-resource',
      body: { resource: 'https://ref.test', authorization_servers: ['https://ref.test'] },
    },
    { method: 'GET', match: '/', handler: ({ url }) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return jsonResponse(200, {
          issuer: 'https://ref.test',
          device_authorization_endpoint: 'https://ref.test/oauth/device_authorization',
          token_endpoint: 'https://ref.test/oauth/token',
          introspection_endpoint: 'https://ref.test/oauth/introspect',
        });
      }
      // GET / root pointer with no advisory block
      return jsonResponse(200, {});
    } },
  ]);
  const profile = await discoverOwnerAgentProfile('https://ref.test', { fetch });
  assert.equal(profile.advisory, false);
  assert.equal(profile.deviceAuthorizationEndpoint, 'https://ref.test/oauth/device_authorization');
  assert.equal(profile.tokenEndpoint, 'https://ref.test/oauth/token');
});

test('discoverOwnerAgentProfile throws when onboarding unavailable', async () => {
  const fetch = makeFetch([
    { method: 'GET', match: '/.well-known/oauth-protected-resource', body: { resource: 'https://ref.test' } },
    { method: 'GET', match: '/', handler: () => jsonResponse(404, {}) },
  ]);
  await assert.rejects(
    () => discoverOwnerAgentProfile('https://ref.test', { fetch }),
    (e) => e instanceof OwnerAgentError && e.code === 'onboarding_unavailable',
  );
});

// ---- onboard: happy path ----------------------------------------------------

function onboardFetch({ tokenSequence }) {
  let tokenCall = 0;
  return makeFetch([
    { method: 'GET', match: '/.well-known/oauth-protected-resource', body: ADVISORY_METADATA },
    {
      method: 'POST',
      match: '/oauth/register',
      handler: ({ opts }) => {
        const body = JSON.parse(opts.body);
        assert.equal(body.token_endpoint_auth_method, 'none');
        assert.ok(body.client_name);
        return jsonResponse(201, {
          client_id: 'client-9',
          client_name: body.client_name,
          token_endpoint_auth_method: 'none',
        });
      },
    },
    {
      method: 'POST',
      match: '/oauth/device_authorization',
      handler: ({ opts }) => {
        const body = new URLSearchParams(opts.body);
        assert.equal(body.get('client_id'), 'client-9');
        return jsonResponse(200, {
          device_code: 'dev-code-123',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://ref.test/device',
          verification_uri_complete: 'https://ref.test/device?user_code=WXYZ-1234',
          interval: 1,
          expires_in: 300,
        });
      },
    },
    {
      method: 'POST',
      match: '/oauth/token',
      handler: ({ opts }) => {
        const body = new URLSearchParams(opts.body);
        assert.equal(body.get('client_id'), 'client-9');
        const next = tokenSequence[Math.min(tokenCall, tokenSequence.length - 1)];
        tokenCall += 1;
        return jsonResponse(next.status, next.body);
      },
    },
  ]);
}

function onboardFetchWithExplicitClient({ tokenSequence }) {
  let tokenCall = 0;
  return makeFetch([
    { method: 'GET', match: '/.well-known/oauth-protected-resource', body: ADVISORY_METADATA },
    {
      method: 'POST',
      match: '/oauth/device_authorization',
      body: {
        device_code: 'dev-code-123',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://ref.test/device',
        verification_uri_complete: 'https://ref.test/device?user_code=WXYZ-1234',
        interval: 1,
        expires_in: 300,
      },
    },
    {
      method: 'POST',
      match: '/oauth/token',
      handler: () => {
        const next = tokenSequence[Math.min(tokenCall, tokenSequence.length - 1)];
        tokenCall += 1;
        return jsonResponse(next.status, next.body);
      },
    },
  ]);
}

test('onboard writes credential to 0600 file and never prints the bearer', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const fetch = onboardFetch({
      tokenSequence: [
        { status: 400, body: { error: 'authorization_pending' } },
        {
          status: 200,
          body: {
            access_token: SECRET,
            token_type: 'Bearer',
            expires_in: 3600,
          },
        },
      ],
    });

    const code = await runOwnerAgent(
      ['onboard', 'https://ref.test'],
      captured.io,
      { fetch, home, sleep: async () => {}, now: () => 1_000_000 },
    );
    assert.equal(code, 0);

    // bearer + reg token never printed
    assert.doesNotMatch(captured.stdout, new RegExp(SECRET));
    assert.doesNotMatch(captured.stderr, new RegExp(SECRET));
    assert.doesNotMatch(captured.stdout, new RegExp(REG_TOKEN));

    // verification URL + code printed (non-secret)
    assert.match(captured.stdout, /\/device/);
    assert.match(captured.stdout, /WXYZ-1234/);
    assert.match(captured.stdout, /\/mcp rejects owner bearers/i);

    const target = resolveCredentialFile({ resource: 'https://ref.test', home });
    assert.ok(existsSync(target));
    assert.equal(statSync(target).mode & 0o777, 0o600);

    const record = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(record.access_token, SECRET);
    assert.equal(record.credential.access_token, SECRET);
    assert.equal(record.profile, 'trusted_owner_agent');
    assert.equal(record.pdpp_token_kind, 'owner');
    assert.equal(record.client_id, 'client-9');
    assert.equal(record.registration_client_uri, 'https://ref.test/oauth/register/client-9');
    assert.equal(record.schema_endpoint, 'https://ref.test/v1/schema');
    assert.equal(record.schema_compact_endpoint, 'https://ref.test/v1/schema?view=compact');
    assert.equal(record.streams_endpoint, 'https://ref.test/v1/streams');
    assert.equal(record.registration_access_token, undefined);
  });
});

test('onboard honors explicit --client-id without registering a new client', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const fetch = onboardFetchWithExplicitClient({
      tokenSequence: [{ status: 200, body: { access_token: SECRET, token_type: 'Bearer', expires_in: 3600 } }],
    });

    const code = await runOwnerAgent(
      ['onboard', 'https://ref.test', '--client-id', 'client-9'],
      captured.io,
      { fetch, home, sleep: async () => {}, now: () => 1_000_000 },
    );
    assert.equal(code, 0);
    const target = resolveCredentialFile({ resource: 'https://ref.test', home });
    const record = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(record.client_id, 'client-9');
    assert.equal(record.registration_client_uri, 'https://ref.test/oauth/register/client-9');
  });
});

test('onboard writes to Daisy-style explicit credential-file path', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const fetch = onboardFetch({
      tokenSequence: [{ status: 200, body: { access_token: SECRET, token_type: 'Bearer', expires_in: 3600 } }],
    });
    const daisyPath = join(home, 'applications/daisy/.pi/agent/pdpp-owner-agent.json');

    const code = await runOwnerAgent(
      ['onboard', 'https://ref.test', '--credential-file', daisyPath],
      captured.io,
      { fetch, home, sleep: async () => {}, now: () => 1_000_000 },
    );
    assert.equal(code, 0);
    assert.ok(existsSync(daisyPath));
    assert.equal(statSync(daisyPath).mode & 0o777, 0o600);
    assert.match(captured.stdout, new RegExp(daisyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

// ---- onboard: denial / expiry -----------------------------------------------

test('onboard surfaces access_denied as bounded error', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const fetch = onboardFetch({ tokenSequence: [{ status: 400, body: { error: 'access_denied' } }] });
    const code = await runOwnerAgent(
      ['onboard', 'https://ref.test'],
      captured.io,
      { fetch, home, sleep: async () => {}, now: () => 1_000_000 },
    );
    assert.notEqual(code, 0);
    assert.match(captured.stderr, /denied/i);
    assert.ok(!existsSync(resolveCredentialFile({ resource: 'https://ref.test', home })));
  });
});

test('onboard surfaces expired_token as bounded error', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const fetch = onboardFetch({ tokenSequence: [{ status: 400, body: { error: 'expired_token' } }] });
    const code = await runOwnerAgent(
      ['onboard', 'https://ref.test'],
      captured.io,
      { fetch, home, sleep: async () => {}, now: () => 1_000_000 },
    );
    assert.notEqual(code, 0);
    assert.match(captured.stderr, /expired/i);
  });
});

test('onboard requires a valid entrypoint URL', async () => {
  const captured = capture();
  const code = await runOwnerAgent(['onboard'], captured.io, { fetch: async () => { throw new Error('nope'); } });
  assert.equal(code, 64);
  assert.match(captured.stderr, /entrypoint/i);
});

// ---- status (introspection) -------------------------------------------------

async function seedCredential(home, overrides = {}) {
  const target = resolveCredentialFile({ resource: 'https://ref.test', home });
  await mkdir(join(home, DEFAULT_OWNER_AGENT_DIR), { recursive: true });
  const record = {
    profile: 'trusted_owner_agent',
    pdpp_token_kind: 'owner',
    resource: 'https://ref.test',
    authorization_server: 'https://ref.test',
    client_id: 'client-9',
    introspection_endpoint: 'https://ref.test/introspect',
    registration_client_uri: 'https://ref.test/oauth/register/client-9',
    access_token: SECRET,
    token_type: 'Bearer',
    credential: { access_token: SECRET, token_type: 'Bearer' },
    ...overrides,
  };
  await writeFile(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return target;
}

test('status introspects the stored credential without printing the bearer', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    let introspectAuth = null;
    const fetch = makeFetch([
      {
        method: 'POST',
        match: '/introspect',
        handler: ({ opts }) => {
          introspectAuth = opts.headers?.Authorization ?? null;
          return jsonResponse(200, { active: true, pdpp_token_kind: 'owner', sub: 'owner_local', client_id: 'client-9', exp: 9999999999 });
        },
      },
    ]);
    const code = await runOwnerAgent(['status', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /active: true/);
    assert.match(captured.stdout, /owner_local/);
    assert.doesNotMatch(captured.stdout, new RegExp(SECRET));
    assert.equal(introspectAuth, `Bearer ${SECRET}`);
  });
});

test('status returns nonzero when token is inactive (revoked)', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = makeFetch([
      { method: 'POST', match: '/introspect', body: { active: false } },
    ]);
    const code = await runOwnerAgent(['status', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 1);
    assert.match(captured.stdout, /active: false/);
  });
});

test('status without a stored credential reports not_onboarded', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const code = await runOwnerAgent(['status'], captured.io, { fetch: async () => { throw new Error('nope'); }, home });
    assert.equal(code, 5);
    assert.match(captured.stderr, /No owner-agent credential/i);
  });
});

// ---- control (capability + connection discovery) ----------------------------

const CONTROL_DOCUMENT = {
  object: 'owner_agent_control_surface',
  entrypoint: 'https://ref.test/v1/owner/control',
  scope: 'reference_implementation',
  mcp_owner_bearer_rejected: true,
  actions: [
    {
      family: 'list_connections',
      status: 'supported',
      method: 'GET',
      url: 'https://ref.test/v1/owner/connections',
      reason: 'List configured connection instances.',
    },
    {
      family: 'initiate_connection',
      status: 'supported',
      method: 'POST',
      url: 'https://ref.test/v1/owner/connections/intents',
      reason: 'Initiate a new connection as a typed, owner-mediated intent.',
    },
    {
      family: 'delete_connection',
      status: 'supported',
      method: 'DELETE',
      url: 'https://ref.test/v1/owner/connections/{connection_id}',
      reason: 'Delete a connection by connection_id to erase its data and remove its configuration.',
    },
  ],
};

function controlFetch({ connections }) {
  return makeFetch([
    {
      method: 'GET',
      match: '/v1/owner/control',
      handler: ({ opts }) => {
        assert.equal(opts.headers?.Authorization, `Bearer ${SECRET}`);
        return jsonResponse(200, CONTROL_DOCUMENT);
      },
    },
    {
      method: 'GET',
      match: '/v1/owner/connections',
      handler: ({ opts }) => {
        assert.equal(opts.headers?.Authorization, `Bearer ${SECRET}`);
        return jsonResponse(200, { object: 'list', data: connections });
      },
    },
  ]);
}

test('control lists capabilities and connections without printing the bearer', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = controlFetch({
      connections: [
        {
          object: 'owner_connection',
          connection_id: 'cin_personal',
          connector_id: 'amazon',
          connector_key: 'amazon',
          display_name: 'the owner personal',
          label_status: 'owner_set',
          status: 'active',
        },
        {
          object: 'owner_connection',
          connection_id: 'cin_shared',
          connector_id: 'amazon',
          connector_key: 'amazon',
          display_name: 'https://registry.pdpp.org/connectors/amazon',
          label_status: 'fallback',
          status: 'active',
        },
      ],
    });
    const code = await runOwnerAgent(['control', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    // capability families surfaced with status
    assert.match(captured.stdout, /list_connections \[supported\] GET https:\/\/ref\.test\/v1\/owner\/connections/);
    assert.match(captured.stdout, /initiate_connection \[supported\]/);
    assert.match(captured.stdout, /delete_connection \[supported\] DELETE https:\/\/ref\.test\/v1\/owner\/connections\/\{connection_id\}/);
    // mcp rejection surfaced
    assert.match(captured.stdout, /\/mcp owner bearer: rejected/i);
    // both connections + label state
    assert.match(captured.stdout, /cin_personal\s+connector=amazon/);
    assert.match(captured.stdout, /"the owner personal" \(owner_set\)/);
    assert.match(captured.stdout, /cin_shared\s+connector=amazon/);
    assert.match(captured.stdout, /label-needed/);
    assert.match(captured.stdout, /rename_connection/);
    // never the bearer
    assert.doesNotMatch(captured.stdout, new RegExp(SECRET));
    assert.doesNotMatch(captured.stderr, new RegExp(SECRET));
  });
});

test('control reports zero connections cleanly', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = controlFetch({ connections: [] });
    const code = await runOwnerAgent(['control', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /Configured connections \(0\)/);
    assert.match(captured.stdout, /none yet/i);
  });
});

test('control surfaces an unauthorized (revoked) credential as a bounded error', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = makeFetch([
      { method: 'GET', match: '/v1/owner/control', status: 401, body: { error: { code: 'authentication_error' } } },
    ]);
    const code = await runOwnerAgent(['control', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 4);
    assert.match(captured.stderr, /not authorized/i);
    assert.doesNotMatch(captured.stderr, new RegExp(SECRET));
  });
});

test('control without a stored credential reports not_onboarded', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const code = await runOwnerAgent(['control'], captured.io, { fetch: async () => { throw new Error('nope'); }, home });
    assert.equal(code, 5);
    assert.match(captured.stderr, /No owner-agent credential/i);
  });
});

// ---- revoke (RFC 7592 client delete) ----------------------------------------

test('revoke deletes the dynamically registered client', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    let deleteCookie = null;
    const fetch = makeFetch([
      {
        method: 'DELETE',
        match: '/oauth/register/client-9',
        handler: ({ opts }) => {
          deleteCookie = opts.headers?.Cookie ?? null;
          return { ok: true, status: 204, json: async () => ({}) };
        },
      },
    ]);
    const code = await runOwnerAgent(
      ['revoke', '--entrypoint', 'https://ref.test', '--owner-session', 'owner-session-value'],
      captured.io,
      { fetch, home },
    );
    assert.equal(code, 0);
    assert.match(captured.stdout, /revoked/i);
    assert.equal(deleteCookie, 'pdpp_owner_session=owner-session-value');
  });
});

test('revoke without an RFC 7592 handle reports revocation_unavailable', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home, { registration_client_uri: null });
    const captured = capture();
    const code = await runOwnerAgent(['revoke', '--entrypoint', 'https://ref.test'], captured.io, { fetch: async () => { throw new Error('nope'); }, home });
    assert.notEqual(code, 0);
    assert.match(captured.stderr, /no RFC 7592 registration handle/i);
  });
});

test('revoke without an owner session reports owner_session_required', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const code = await runOwnerAgent(['revoke', '--entrypoint', 'https://ref.test'], captured.io, {
      fetch: async () => { throw new Error('nope'); },
      home,
    });
    assert.equal(code, 5);
    assert.match(captured.stderr, /owner session/i);
  });
});

test('revoke treats 404 as already absent', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = makeFetch([
      { method: 'DELETE', match: '/oauth/register/client-9', status: 404, body: {} },
    ]);
    const code = await runOwnerAgent(
      ['revoke', '--entrypoint', 'https://ref.test', '--owner-session', 'pdpp_owner_session=owner-session-value'],
      captured.io,
      { fetch, home },
    );
    assert.equal(code, 0);
    assert.match(captured.stdout, /already absent/i);
  });
});

// ---- setup (connection setup plan parity) -----------------------------------

// Builds a fetch that asserts the intent route is called with the owner bearer
// as an Authorization header (never a cookie) and returns the supplied plan.
// Captures the request so tests can assert the wire shape and secret boundary.
function setupFetch({ status = 201, body, capture: cap } = {}) {
  return makeFetch([
    {
      method: 'POST',
      match: '/v1/owner/connections/intents',
      handler: ({ opts }) => {
        if (cap) {
          cap.auth = opts.headers?.Authorization ?? null;
          cap.cookie = opts.headers?.Cookie ?? null;
          cap.body = opts.body ? JSON.parse(opts.body) : null;
        }
        return jsonResponse(status, body ?? {});
      },
    },
  ]);
}

function connectorTemplatesFetch({ body, capture: cap } = {}) {
  return makeFetch([
    {
      method: 'GET',
      match: '/v1/owner/connector-templates',
      handler: ({ opts }) => {
        if (cap) {
          cap.auth = opts.headers?.Authorization ?? null;
          cap.cookie = opts.headers?.Cookie ?? null;
          cap.templateCalls = (cap.templateCalls ?? 0) + 1;
        }
        return jsonResponse(200, body ?? { object: 'list', data: [] });
      },
    },
    {
      method: 'POST',
      match: '/v1/owner/connections/intents',
      handler: () => {
        throw new Error('connectors list/search/explain must not call the mutating setup intent route');
      },
    },
  ]);
}

const TEMPLATE_CATALOG = {
  object: 'list',
  data: [
    {
      object: 'owner_connector_template',
      connector_id: 'amazon',
      connector_key: 'amazon',
      display_name: 'Amazon',
      version: '1.0.0',
      connector_modality: 'browser_bound',
      setup_plan: {
        setup_modality: 'browser_bound',
        support_state: 'proof_gated',
        next_step_kind: 'manual_runbook',
        proof_gate: 'browser_collector_live_proof_missing',
        runbook_path: null,
        deployment_readiness: { state: 'not_applicable', blockers: [], guidance: null },
      },
      stream_count: 3,
      connection_count: 1,
      connections: [
        {
          object: 'owner_connection_summary',
          connection_id: 'cin_amazon_personal',
          connector_instance_id: 'cin_amazon_personal',
          connector_id: 'amazon',
          connector_key: 'amazon',
          display_name: 'Amazon personal',
          label_status: 'owner_set',
          status: 'active',
          source_kind: 'account',
          created_at: null,
          updated_at: null,
          revoked_at: null,
        },
      ],
      supported_actions: [{ family: 'initiate_connection', status: 'unsupported', method: null, url: null, reason: 'manual runbook' }],
    },
    {
      object: 'owner_connector_template',
      connector_id: 'gmail',
      connector_key: 'gmail',
      display_name: 'Gmail',
      version: '1.0.0',
      connector_modality: 'api_network',
      setup_plan: {
        setup_modality: 'static_secret',
        support_state: 'proof_gated',
        next_step_kind: 'capture_static_secret',
        proof_gate: 'static_secret_live_proof_missing',
        runbook_path: null,
        deployment_readiness: { state: 'not_applicable', blockers: [], guidance: null },
      },
      stream_count: 2,
      connection_count: 0,
      connections: [],
      supported_actions: [{ family: 'initiate_connection', status: 'unsupported', method: null, url: null, reason: 'capture secret' }],
    },
    {
      object: 'owner_connector_template',
      connector_id: 'codex',
      connector_key: 'codex',
      display_name: 'Codex',
      version: '1.0.0',
      connector_modality: 'local_collector',
      setup_plan: {
        setup_modality: 'local_collector',
        support_state: 'supported',
        next_step_kind: 'enroll_local_collector',
        proof_gate: null,
        runbook_path: null,
        deployment_readiness: { state: 'not_applicable', blockers: [], guidance: null },
      },
      stream_count: 1,
      connection_count: 0,
      connections: [],
      supported_actions: [{ family: 'initiate_connection', status: 'supported', method: 'POST', url: 'https://ref.test/v1/owner/connections/intents', reason: 'mint code' }],
    },
  ],
};

test('connectors list discovers available setup options without mutating', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const cap = {};
    const fetch = connectorTemplatesFetch({ body: TEMPLATE_CATALOG, capture: cap });
    const code = await runOwnerAgent(['connectors', 'list', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.equal(cap.auth, `Bearer ${SECRET}`);
    assert.equal(cap.cookie, null);
    assert.equal(cap.templateCalls, 1);
    assert.match(captured.stdout, /Connector setup catalog/);
    assert.match(captured.stdout, /Amazon\s+connector=amazon\s+status=proof_gated\s+connections=1/);
    assert.match(captured.stdout, /Codex\s+connector=codex\s+status=supported\s+connections=0/);
    assert.match(captured.stdout, /explain: pdpp owner-agent connectors explain gmail/);
    assert.doesNotMatch(captured.stdout, new RegExp(SECRET));
  });
});

test('connectors search filters the shared setup catalog by provider name', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = connectorTemplatesFetch({ body: TEMPLATE_CATALOG });
    const code = await runOwnerAgent(['connectors', 'search', 'gmail', '--entrypoint', 'https://ref.test'], captured.io, {
      fetch,
      home,
    });
    assert.equal(code, 0);
    assert.match(captured.stdout, /matching "gmail"/);
    assert.match(captured.stdout, /Gmail\s+connector=gmail/);
    assert.doesNotMatch(captured.stdout, /Amazon\s+connector=amazon/);
  });
});

test('connectors explain previews one connector without minting setup material', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = connectorTemplatesFetch({ body: TEMPLATE_CATALOG });
    const code = await runOwnerAgent(['connectors', 'explain', 'codex', '--entrypoint', 'https://ref.test'], captured.io, {
      fetch,
      home,
    });
    assert.equal(code, 0);
    assert.match(captured.stdout, /Connector setup preview for Codex \(codex\)/);
    assert.match(captured.stdout, /status: supported/);
    assert.match(captured.stdout, /next step: enroll_local_collector/);
    assert.match(captured.stdout, /Start setup: pdpp owner-agent setup codex --display-name "<name>"/);
    assert.match(captured.stdout, /did not mint enrollment codes/);
    assert.doesNotMatch(captured.stdout, /lde_setup_code_value/);
    assert.doesNotMatch(captured.stdout, new RegExp(SECRET));
  });
});

const SUPPORTED_LOCAL_PLAN = {
  object: 'owner_connection_intent',
  connector_id: 'claude-code',
  connector_key: 'claude-code',
  connector_modality: 'local_collector',
  connection_active: false,
  deployment_readiness: { state: 'not_applicable', guidance: null, blockers: [] },
  proof_gate: null,
  runbook_path: null,
  setup_modality: 'local_collector',
  support_state: 'supported',
  next_step: {
    kind: 'enroll_local_collector',
    reason:
      'Run the owner’s local collector for this connector and exchange the enrollment_code at enroll_endpoint.',
    enrollment_code: 'lde_setup_code_value',
    enroll_endpoint: 'https://ref.test/_ref/device-exporters/enroll',
    local_binding_name: 'claude-code',
    expires_at: '2026-06-09T00:15:00.000Z',
  },
};

test('setup requests a supported local-collector plan with the bearer as a header', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const cap = {};
    const fetch = setupFetch({ body: SUPPORTED_LOCAL_PLAN, capture: cap });
    const code = await runOwnerAgent(
      ['setup', 'claude-code', '--display-name', 'the owner laptop', '--entrypoint', 'https://ref.test'],
      captured.io,
      { fetch, home },
    );
    assert.equal(code, 0);
    // bearer travels as an Authorization header only, never a cookie
    assert.equal(cap.auth, `Bearer ${SECRET}`);
    assert.equal(cap.cookie, null);
    // connector + optional display name forwarded in the request body
    assert.equal(cap.body.connector_id, 'claude-code');
    assert.equal(cap.body.display_name, 'the owner laptop');
    // formatted supported plan
    assert.match(captured.stdout, /status: supported/);
    assert.match(captured.stdout, /modality: local_collector/);
    assert.match(captured.stdout, /Next step: enroll_local_collector/);
    assert.match(captured.stdout, /enrollment code: lde_setup_code_value/);
    assert.match(captured.stdout, /enroll endpoint: https:\/\/ref\.test\/_ref\/device-exporters\/enroll/);
    assert.match(captured.stdout, /connection active: no/);
    // the owner bearer is never printed
    assert.doesNotMatch(captured.stdout, new RegExp(SECRET));
    assert.doesNotMatch(captured.stderr, new RegExp(SECRET));
  });
});

test('setup formats a proof-gated static-secret connector honestly', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = setupFetch({
      body: {
        object: 'owner_connection_intent',
        connector_id: 'gmail',
        connector_key: 'gmail',
        connector_modality: 'api_network',
        connection_active: false,
        deployment_readiness: { state: 'not_applicable', guidance: null, blockers: [] },
        proof_gate: 'static_secret_live_proof_missing',
        runbook_path: null,
        setup_modality: 'static_secret',
        support_state: 'proof_gated',
        validation: 'synchronous',
        next_step: {
          kind: 'capture_static_secret',
          reason: 'Open the owner-session static-secret setup page; provider secrets are not returned to agents.',
          capture_endpoint: '/connect/static-secret/gmail',
        },
      },
    });
    const code = await runOwnerAgent(['setup', 'gmail', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /status: proof-gated/);
    assert.match(captured.stdout, /Next step: capture_static_secret/);
    assert.match(captured.stdout, /capture endpoint: \/connect\/static-secret\/gmail/);
    assert.doesNotMatch(captured.stdout, /runbook:/);
    // The CLI surfaces the synchronous validation mode without any secret.
    assert.match(captured.stdout, /credential validation: synchronous/);
    assert.doesNotMatch(captured.stdout, /provider-secret-value/);
  });
});

test('setup formats a manual/upload connector with an owner upload endpoint', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = setupFetch({
      body: {
        object: 'owner_connection_intent',
        connector_id: 'google-maps',
        connector_key: 'google-maps',
        connector_modality: 'local_collector',
        connection_active: false,
        deployment_readiness: { state: 'not_applicable', guidance: null, blockers: [] },
        proof_gate: null,
        runbook_path: null,
        setup_modality: 'manual_or_upload',
        support_state: 'supported',
        next_step: {
          kind: 'provide_import_file',
          reason: 'Upload the owner-provided import file from the owner session.',
          upload_endpoint: '/connect/manual-upload/google-maps',
        },
      },
    });
    const code = await runOwnerAgent(['setup', 'google-maps', '--entrypoint', 'https://ref.test'], captured.io, {
      fetch,
      home,
    });
    assert.equal(code, 0);
    assert.match(captured.stdout, /status: supported/);
    assert.match(captured.stdout, /setup modality: manual_or_upload/);
    assert.match(captured.stdout, /Next step: provide_import_file/);
    assert.match(captured.stdout, /upload endpoint: \/connect\/manual-upload\/google-maps/);
    assert.doesNotMatch(captured.stdout, /GOOGLE_MAPS_TIMELINE_DIR|import_dir|pdpp_owner_session/i);
  });
});

test('setup formats an unsupported connector', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = setupFetch({
      body: {
        object: 'owner_connection_intent',
        connector_id: 'mystery',
        connector_key: 'mystery',
        connector_modality: 'unknown',
        connection_active: false,
        deployment_readiness: { state: 'not_applicable', guidance: null, blockers: [] },
        proof_gate: null,
        runbook_path: null,
        setup_modality: 'unknown',
        support_state: 'unsupported',
        next_step: {
          kind: 'unsupported',
          reason: 'Unknown connector: no manifest with runtime binding requirements is registered.',
        },
      },
    });
    const code = await runOwnerAgent(['setup', 'mystery', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /status: unsupported/);
    assert.match(captured.stdout, /Next step: unsupported/);
    assert.match(captured.stdout, /no manifest with runtime binding requirements/);
  });
});

test('setup formats a deployment-blocked connector', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = setupFetch({
      body: {
        object: 'owner_connection_intent',
        connector_id: 'future-oauth',
        connector_key: 'future-oauth',
        connector_modality: 'api_network',
        connection_active: false,
        deployment_readiness: {
          state: 'needs_config',
          guidance: 'Configure the provider app first.',
          blockers: [
            { key: 'FUTURE_OAUTH_CLIENT_ID', label: 'FUTURE_OAUTH_CLIENT_ID', secret: false },
            { key: 'FUTURE_OAUTH_CLIENT_SECRET', label: 'FUTURE_OAUTH_CLIENT_SECRET', secret: true },
          ],
        },
        proof_gate: 'provider_app_deployment_config_missing',
        runbook_path: 'docs/operator/add-connection.md',
        setup_modality: 'provider_authorization',
        support_state: 'needs_deployment_config',
        next_step: {
          kind: 'needs_deployment_config',
          reason: 'A deployment-level provider app (client id/secret) must exist before per-account authorization.',
        },
      },
    });
    const code = await runOwnerAgent(['setup', 'future-oauth', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /status: deployment-blocked/);
    assert.match(captured.stdout, /deployment readiness: needs_config/);
    assert.match(captured.stdout, /FUTURE_OAUTH_CLIENT_ID/);
    assert.match(captured.stdout, /FUTURE_OAUTH_CLIENT_SECRET \(secret\)/);
    assert.match(captured.stdout, /Next step: needs_deployment_config/);
  });
});

test('setup omits display_name from the body when not provided', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const cap = {};
    const fetch = setupFetch({ body: SUPPORTED_LOCAL_PLAN, capture: cap });
    const code = await runOwnerAgent(['setup', 'claude-code', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.equal(cap.body.connector_id, 'claude-code');
    assert.equal(Object.hasOwn(cap.body, 'display_name'), false);
  });
});

test('setup surfaces an HTTP error from the intent route as a bounded error', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = setupFetch({
      status: 400,
      body: { error: { code: 'invalid_request', message: 'connector_id must be a non-empty string' } },
    });
    const code = await runOwnerAgent(['setup', 'claude-code', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.notEqual(code, 0);
    assert.match(captured.stderr, /invalid_request/);
    assert.doesNotMatch(captured.stderr, new RegExp(SECRET));
  });
});

test('setup surfaces an unauthorized (revoked) credential as a bounded error', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = setupFetch({ status: 403, body: { error: { code: 'permission_error' } } });
    const code = await runOwnerAgent(['setup', 'claude-code', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 4);
    assert.match(captured.stderr, /not authorized/i);
    assert.doesNotMatch(captured.stderr, new RegExp(SECRET));
  });
});

test('setup without a connector-id reports a usage error', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const code = await runOwnerAgent(['setup', '--entrypoint', 'https://ref.test'], captured.io, {
      fetch: async () => { throw new Error('nope'); },
      home,
    });
    assert.equal(code, 64);
    assert.match(captured.stderr, /Usage: pdpp owner-agent setup <connector-id>/);
  });
});

test('setup without a stored credential reports not_onboarded', async () => {
  await withTmpHome(async (home) => {
    const captured = capture();
    const code = await runOwnerAgent(['setup', 'claude-code'], captured.io, {
      fetch: async () => { throw new Error('nope'); },
      home,
    });
    assert.equal(code, 5);
    assert.match(captured.stderr, /No owner-agent credential/i);
  });
});

// ---- CLI routing + help -----------------------------------------------------

test('runCli routes owner-agent and help advertises the profile', async () => {
  const captured = capture();
  const code = await runCli(['owner-agent', '--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /owner-agent onboard/);
  assert.match(captured.stdout, /owner-agent control/);
  assert.match(captured.stdout, /owner-agent connectors/);
  assert.match(captured.stdout, /owner-agent setup\s+<connector-id>/);
  assert.match(captured.stdout, /not the default/i);
});

test('top-level help advertises owner-agent without recommending it as default', async () => {
  const captured = capture();
  const code = await runCli(['--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /owner-agent onboard/);
  assert.match(captured.stdout, /not the default agent path/i);
});
