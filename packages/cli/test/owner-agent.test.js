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
    profile: 'trusted-owner-agent',
    authorization_server: 'https://ref.test',
    device_authorization_endpoint: 'https://ref.test/oauth/device_authorization',
    token_endpoint: 'https://ref.test/oauth/token',
    introspection_endpoint: 'https://ref.test/oauth/introspect',
    registration_endpoint: 'https://ref.test/oauth/register',
    owner_approval_url: 'https://ref.test/owner/approve',
    schema_endpoint: 'https://ref.test/v1/schema',
    streams_endpoint: 'https://ref.test/v1/streams',
    mcp_rejects_owner_bearer: true,
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
  assert.equal(profile.introspectionEndpoint, 'https://ref.test/oauth/introspect');
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
      match: '/oauth/device_authorization',
      body: {
        device_code: 'dev-code-123',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://ref.test/owner/approve',
        verification_uri_complete: 'https://ref.test/owner/approve?code=WXYZ-1234',
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
            registration_client_uri: 'https://ref.test/oauth/register/client-9',
            registration_access_token: REG_TOKEN,
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
    assert.match(captured.stdout, /owner\/approve/);
    assert.match(captured.stdout, /WXYZ-1234/);
    assert.match(captured.stdout, /\/mcp rejects owner bearers/i);

    const target = resolveCredentialFile({ resource: 'https://ref.test', home });
    assert.ok(existsSync(target));
    assert.equal(statSync(target).mode & 0o777, 0o600);

    const record = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(record.credential.access_token, SECRET);
    assert.equal(record.pdpp_token_kind, 'owner');
    assert.equal(record.registration_access_token, REG_TOKEN);
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
    profile: 'trusted-owner-agent',
    pdpp_token_kind: 'owner',
    resource: 'https://ref.test',
    introspection_endpoint: 'https://ref.test/oauth/introspect',
    registration_client_uri: 'https://ref.test/oauth/register/client-9',
    registration_access_token: REG_TOKEN,
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
        match: '/oauth/introspect',
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
      { method: 'POST', match: '/oauth/introspect', body: { active: false } },
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

// ---- revoke (RFC 7592 client delete) ----------------------------------------

test('revoke deletes the dynamically registered client', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    let deleteAuth = null;
    const fetch = makeFetch([
      {
        method: 'DELETE',
        match: '/oauth/register/client-9',
        handler: ({ opts }) => {
          deleteAuth = opts.headers?.Authorization ?? null;
          return { ok: true, status: 204, json: async () => ({}) };
        },
      },
    ]);
    const code = await runOwnerAgent(['revoke', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /revoked/i);
    assert.equal(deleteAuth, `Bearer ${REG_TOKEN}`);
  });
});

test('revoke without an RFC 7592 handle reports revocation_unavailable', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home, { registration_client_uri: null, registration_access_token: null });
    const captured = capture();
    const code = await runOwnerAgent(['revoke', '--entrypoint', 'https://ref.test'], captured.io, { fetch: async () => { throw new Error('nope'); }, home });
    assert.notEqual(code, 0);
    assert.match(captured.stderr, /no RFC 7592 registration handle/i);
  });
});

test('revoke treats 404 as already absent', async () => {
  await withTmpHome(async (home) => {
    await seedCredential(home);
    const captured = capture();
    const fetch = makeFetch([
      { method: 'DELETE', match: '/oauth/register/client-9', status: 404, body: {} },
    ]);
    const code = await runOwnerAgent(['revoke', '--entrypoint', 'https://ref.test'], captured.io, { fetch, home });
    assert.equal(code, 0);
    assert.match(captured.stdout, /already absent/i);
  });
});

// ---- CLI routing + help -----------------------------------------------------

test('runCli routes owner-agent and help advertises the profile', async () => {
  const captured = capture();
  const code = await runCli(['owner-agent', '--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /owner-agent onboard/);
  assert.match(captured.stdout, /not the default/i);
});

test('top-level help advertises owner-agent without recommending it as default', async () => {
  const captured = capture();
  const code = await runCli(['--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /owner-agent onboard/);
  assert.match(captured.stdout, /not the default agent path/i);
});
