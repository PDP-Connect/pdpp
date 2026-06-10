import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CredentialError, loadScopedCredential } from '../src/credentials.js';

async function makeCacheRoot() {
  return await mkdtemp(join(tmpdir(), 'pdpp-mcp-cred-'));
}

async function writeCacheEntry(cacheRoot, providerUrl, payload) {
  const host = new URL(providerUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const dir = join(cacheRoot, 'clients');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${host}.json`);
  await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
  return path;
}

test('loads scoped credential from cache', async () => {
  const cacheRoot = await makeCacheRoot();
  await writeCacheEntry(cacheRoot, 'https://provider.test', {
    credential: { access_token: 'scoped-abc', token_type: 'Bearer' },
    scope: 'pdpp:read',
    grant_id: 'grant-1',
  });

  const result = await loadScopedCredential('https://provider.test', { cacheRoot });
  assert.equal(result.accessToken, 'scoped-abc');
  assert.equal(result.providerUrl, 'https://provider.test');
  assert.equal(result.scope, 'pdpp:read');
});

test('fails closed with not_connected when cache is empty', async () => {
  const cacheRoot = await makeCacheRoot();
  await assert.rejects(
    () => loadScopedCredential('https://provider.test', { cacheRoot }),
    (error) => error instanceof CredentialError && error.code === 'not_connected'
  );
});

test('refuses owner credential by pdpp_token_kind', async () => {
  const cacheRoot = await makeCacheRoot();
  await writeCacheEntry(cacheRoot, 'https://provider.test', {
    credential: { access_token: 'owner-abc', pdpp_token_kind: 'owner' },
  });

  await assert.rejects(
    () => loadScopedCredential('https://provider.test', { cacheRoot }),
    (error) => error instanceof CredentialError && error.code === 'owner_token_refused'
  );
});

test('rejects missing provider URL with usage exit code', async () => {
  await assert.rejects(
    () => loadScopedCredential(undefined),
    (error) => error instanceof CredentialError && error.exitCode === 64
  );
});

test('rejects expired credential', async () => {
  const cacheRoot = await makeCacheRoot();
  await writeCacheEntry(cacheRoot, 'https://provider.test', {
    credential: {
      access_token: 'expired',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  await assert.rejects(
    () => loadScopedCredential('https://provider.test', { cacheRoot }),
    (error) => error instanceof CredentialError && error.code === 'credential_expired'
  );
});
