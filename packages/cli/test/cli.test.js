import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
  PDPP_CLI_BIN_NAME,
  PDPP_CLI_NO_OWNER_TOKEN_POLICY,
  PDPP_CLI_PACKAGE_NAME,
  PDPP_CLI_PACKAGE_SPECIFIER,
} from '../src/package-info.js';
import { normalizeProviderUrl, runCli } from '../src/index.js';
import { connectProvider } from '../src/connect/flow.js';

const binPath = fileURLToPath(new URL('../bin/pdpp.js', import.meta.url));

test('package info is the CLI source of truth', () => {
  assert.equal(PDPP_CLI_PACKAGE_NAME, '@pdpp/cli');
  assert.equal(PDPP_CLI_BIN_NAME, 'pdpp');
  assert.equal(PDPP_CLI_PACKAGE_SPECIFIER, '@pdpp/cli');
  assert.deepEqual(getPdppCliPackageInfo('https://example.test'), {
    packageName: '@pdpp/cli',
    packageSpecifier: '@pdpp/cli',
    binName: 'pdpp',
    defaultClientId: 'pdpp_cli',
    versionPolicy: 'latest',
    runCommand: 'npx -y @pdpp/cli connect https://example.test',
    noOwnerToken: true,
    noOwnerTokenPolicy: 'owner_browser_approval_required',
  });
  assert.equal(PDPP_CLI_NO_OWNER_TOKEN_POLICY, 'owner_browser_approval_required');
  assert.equal(createPdppCliCommand(), 'npx -y @pdpp/cli connect <provider-url>');
});

test('package info mirrors package manifest name and bin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(PDPP_CLI_PACKAGE_NAME, manifest.name);
  assert.equal(PDPP_CLI_BIN_NAME, Object.keys(manifest.bin)[0]);
});

test('help starts from an installed-style bin invocation', () => {
  const result = spawnSync(process.execPath, [binPath, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /PDPP CLI/);
  assert.match(result.stdout, /npx -y @pdpp\/cli connect <provider-url>/);
});

test('package-info command prints machine-readable install metadata', async () => {
  let stdout = '';
  let stderr = '';

  const code = await runCli(['package-info', '--provider-url', 'https://pdpp.example'], {
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).runCommand, 'npx -y @pdpp/cli connect https://pdpp.example');
});

test('connect validates provider URLs before any network flow', async () => {
  let stderr = '';

  const code = await runCli(['connect', 'http://[::1'], {
    stdout: { write: () => {} },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(code, 64);
  assert.match(stderr, /Invalid provider URL/);
  assert.equal(normalizeProviderUrl('peregrine-dev.vivid.fish'), 'https://peregrine-dev.vivid.fish');
});

test('connect discovers metadata, polls approval, verifies schema, and stores project-local credentials', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'pdpp-cli-test-'));
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = input.toString();
    calls.push({ url, init });

    if (url === 'https://provider.test/.well-known/oauth-protected-resource') {
      return jsonResponse({
        resource: 'https://provider.test/path',
        authorization_servers: ['https://auth.provider.test'],
      });
    }
    if (url === 'https://auth.provider.test/.well-known/oauth-authorization-server') {
      return jsonResponse({
        issuer: 'https://auth.provider.test',
        registration_endpoint: 'https://auth.provider.test/oauth/register',
        pdpp_registration_modes_supported: ['dynamic', 'pre_registered_public'],
        agent_connect_endpoint: 'https://auth.provider.test/agent-connect',
      });
    }
    if (url === 'https://auth.provider.test/oauth/register') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        client_name: 'PDPP CLI',
        token_endpoint_auth_method: 'none',
      });
      return jsonResponse({
        client_id: 'cli_dynamic_123',
        client_name: 'PDPP CLI',
        token_endpoint_auth_method: 'none',
      }, 201);
    }
    if (url === 'https://auth.provider.test/agent-connect') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        resource: 'https://provider.test/path',
        scope: 'pdpp:read',
        client_name: 'PDPP CLI',
        client_id: 'cli_dynamic_123',
      });
      return jsonResponse({
        approval_url: 'https://auth.provider.test/approve/abc',
        poll_url: 'https://auth.provider.test/agent-connect/poll/abc',
        interval_ms: 1,
      });
    }
    if (url === 'https://auth.provider.test/agent-connect/poll/abc') {
      return jsonResponse({
        status: 'approved',
        access_token: 'test-access-token',
        grant_id: 'grant_test',
        token_type: 'Bearer',
        scope: 'pdpp:read',
      });
    }
    if (url === 'https://provider.test/v1/schema') {
      assert.equal(init.headers.Authorization, 'Bearer test-access-token');
      return jsonResponse({ tables: [] });
    }

    throw new Error(`unexpected fetch ${url}`);
  };

  let stdout = '';
  const result = await connectProvider('provider.test/path?ignored=1#frag', {
    fetch,
    cacheRoot,
    io: { stdout: { write: (chunk) => (stdout += chunk) }, stderr: { write: () => {} } },
    now: () => 0,
  });

  assert.equal(result.providerUrl, 'https://provider.test/path');
  assert.equal(result.clientId, 'cli_dynamic_123');
  assert.match(stdout, /Open this URL to approve access/);
  assert.match(stdout, /Verified \/v1\/schema/);
  assert.equal(await readFile(join(cacheRoot, '.gitignore'), 'utf8'), '*\n!.gitignore\n');
  assert.ok(existsSync(result.cacheFile));
  assert.equal((await stat(result.cacheFile)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(result.cacheFile, 'utf8'));
  assert.equal(stored.credential.access_token, 'test-access-token');
  assert.equal(stored.credential.grant_id, 'grant_test');
  assert.equal(stored.provider_url, 'https://provider.test/path');
  assert.deepEqual(stored.client, {
    client_id: 'cli_dynamic_123',
    client_name: 'PDPP CLI',
    token_endpoint_auth_method: 'none',
  });

  let tokenStdout = '';
  let tokenStderr = '';
  const tokenCode = await runCli(['token', 'provider.test/path?ignored=1#frag', '--cache-root', cacheRoot], {
    stdout: { write: (chunk) => (tokenStdout += chunk) },
    stderr: { write: (chunk) => (tokenStderr += chunk) },
  });
  assert.equal(tokenCode, 0);
  assert.equal(tokenStderr, '');
  assert.equal(tokenStdout, 'test-access-token\n');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://provider.test/.well-known/oauth-protected-resource',
      'https://auth.provider.test/.well-known/oauth-authorization-server',
      'https://auth.provider.test/oauth/register',
      'https://auth.provider.test/agent-connect',
      'https://auth.provider.test/agent-connect/poll/abc',
      'https://provider.test/v1/schema',
    ]
  );
});

test('connect fails honestly when backend metadata lacks agent connect support', async () => {
  const fetch = async (input) => {
    const url = input.toString();
    if (url === 'https://provider.test/.well-known/oauth-protected-resource') {
      return jsonResponse({ resource: 'https://provider.test', authorization_servers: ['https://auth.test'] });
    }
    if (url === 'https://auth.test/.well-known/oauth-authorization-server') {
      return jsonResponse({ issuer: 'https://auth.test' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await assert.rejects(
    () => connectProvider('https://provider.test', { fetch }),
    /does not advertise a no-owner-token agent connect endpoint/
  );
});

test('connect stops when provider metadata gates no-owner-token completion', async () => {
  const fetch = async (input) => {
    const url = input.toString();
    if (url === 'https://provider.test/.well-known/oauth-protected-resource') {
      return jsonResponse({
        resource: 'https://provider.test',
        authorization_servers: ['https://auth.test'],
        pdpp_agent_discovery: {
          cli: {
            no_owner_token: false,
            no_owner_token_policy: 'requires_native_reference_provider_for_one_command_connect',
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await assert.rejects(
    () => connectProvider('https://provider.test', { fetch }),
    /does not advertise a complete no-owner-token connect flow/
  );
});

test('connect maps denied, expired, insufficient-scope, and verification errors', async () => {
  for (const [status, message] of [
    ['denied', /denied/],
    ['expired', /expired/],
    ['insufficient_scope', /required PDPP scope/],
  ]) {
    await assert.rejects(() => runMockConnect({ poll: { status } }), message);
  }

  await assert.rejects(() => runMockConnect({ schemaStatus: 401 }), /rejected by \/v1\/schema/);
  await assert.rejects(() => runMockConnect({ schemaStatus: 403 }), /required scope is missing/);
});

async function runMockConnect({ poll = { status: 'approved', access_token: 'token' }, schemaStatus = 200 }) {
  const fetch = async (input) => {
    const url = input.toString();
    if (url.endsWith('/.well-known/oauth-protected-resource')) {
      return jsonResponse({ resource: 'https://provider.test', authorization_servers: ['https://provider.test'] });
    }
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return jsonResponse({ issuer: 'https://provider.test', agent_connect_endpoint: '/connect/start' });
    }
    if (url === 'https://provider.test/connect/start') {
      return jsonResponse({ approval_url: 'https://provider.test/approve', poll_url: 'https://provider.test/poll' });
    }
    if (url === 'https://provider.test/poll') {
      return jsonResponse(poll);
    }
    if (url === 'https://provider.test/v1/schema') {
      return jsonResponse({}, schemaStatus);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  return connectProvider('https://provider.test', {
    fetch,
    cacheRoot: await mkdtemp(join(tmpdir(), 'pdpp-cli-test-')),
    io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
  });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
