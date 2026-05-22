import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CredentialError, OptionParseError, parseOptions, runMcpServerCli } from '../src/index.js';

test('parseOptions reads --provider-url and defaults', () => {
  const options = parseOptions(['--provider-url', 'https://pdpp.example.com'], {});
  assert.equal(options.providerUrl, 'https://pdpp.example.com');
  assert.equal(options.cacheRoot, '.pdpp');
  assert.equal(options.serverName, 'pdpp-mcp-server');
});

test('parseOptions reads env defaults', () => {
  const options = parseOptions([], {
    PDPP_PROVIDER_URL: 'https://env.example.com',
    PDPP_CACHE_ROOT: '/custom/.pdpp',
    PDPP_MCP_SERVER_NAME: 'env-server',
  });
  assert.equal(options.providerUrl, 'https://env.example.com');
  assert.equal(options.cacheRoot, '/custom/.pdpp');
  assert.equal(options.serverName, 'env-server');
});

test('parseOptions throws when provider URL is missing', () => {
  assert.throws(
    () => parseOptions([], {}),
    (error) => error instanceof OptionParseError && error.exitCode === 64
  );
});

test('parseOptions refuses owner credentials in environment', () => {
  assert.throws(
    () => parseOptions(['--provider-url', 'https://x'], { PDPP_OWNER_TOKEN: 'secret' }),
    (error) => error instanceof OptionParseError && error.exitCode === 77
  );

  assert.throws(
    () =>
      parseOptions(['--provider-url', 'https://x'], {
        PDPP_OWNER_SESSION_COOKIE: 'session=...',
      }),
    (error) => error instanceof OptionParseError && error.exitCode === 77
  );
});

test('runMcpServerCli refuses to start when PDPP_OWNER_TOKEN is set', async () => {
  const stderrChunks = [];
  const stderr = { write: (chunk) => stderrChunks.push(String(chunk)) };
  let loadCalled = false;
  let startCalled = false;

  const exit = await runMcpServerCli(['--provider-url', 'https://x'], {
    stderr,
    env: { PDPP_OWNER_TOKEN: 'secret' },
    loadScopedCredential: async () => {
      loadCalled = true;
      return { providerUrl: 'https://x', accessToken: 't', cacheFile: '/tmp/x' };
    },
    startStdioServer: async () => {
      startCalled = true;
    },
  });

  assert.equal(exit, 77);
  assert.equal(loadCalled, false, 'credential loader must not be invoked');
  assert.equal(startCalled, false, 'stdio server must not start');
  assert.match(stderrChunks.join(''), /Refusing to start/);
});

test('runMcpServerCli surfaces missing-credential guidance and exits non-zero', async () => {
  const stderrChunks = [];
  const stderr = { write: (chunk) => stderrChunks.push(String(chunk)) };
  let startCalled = false;

  const exit = await runMcpServerCli(['--provider-url', 'https://x'], {
    stderr,
    env: {},
    loadScopedCredential: async () => {
      throw new CredentialError(
        'not_connected',
        'No scoped PDPP credential cached for https://x. Run `pdpp connect https://x` and try again.',
        78
      );
    },
    startStdioServer: async () => {
      startCalled = true;
    },
  });

  assert.equal(exit, 78);
  assert.equal(startCalled, false);
  assert.match(stderrChunks.join(''), /No scoped PDPP credential/);
  assert.match(stderrChunks.join(''), /pdpp connect/);
});

test('runMcpServerCli boots stdio server when scoped credential resolves', async () => {
  const stderrChunks = [];
  const stderr = { write: (chunk) => stderrChunks.push(String(chunk)) };
  let startedWith;

  const exit = await runMcpServerCli(['--provider-url', 'https://example.com'], {
    stderr,
    env: {},
    loadScopedCredential: async (providerUrl, options) => {
      assert.equal(providerUrl, 'https://example.com');
      assert.equal(options.cacheRoot, '.pdpp');
      return {
        providerUrl: 'https://example.com',
        accessToken: 'scoped-token',
        cacheFile: '/tmp/.pdpp/clients/example.com.json',
      };
    },
    startStdioServer: async (opts) => {
      startedWith = opts;
    },
  });

  assert.equal(exit, 0);
  assert.deepEqual(startedWith, {
    providerUrl: 'https://example.com',
    accessToken: 'scoped-token',
    serverName: 'pdpp-mcp-server',
  });
  const stderrText = stderrChunks.join('');
  assert.match(stderrText, /connected to https:\/\/example.com/);
  assert.ok(!stderrText.includes('scoped-token'), 'access token must not be logged');
});
