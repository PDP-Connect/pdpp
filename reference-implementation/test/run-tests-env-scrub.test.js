import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_ENV_DENYLIST,
  buildScrubbedTestEnv,
} from '../scripts/test-env.js';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

describe('run-tests env scrub', () => {
  it('removes owner-auth vars exported by the parent shell', () => {
    const polluted = {
      PATH: '/usr/bin',
      PDPP_OWNER_PASSWORD: 'leaked-from-shell-secrets',
      PDPP_OWNER_SUBJECT_ID: 'owner-leak',
      PDPP_OWNER_TOKEN: 'tok-leak',
      PDPP_OWNER_FORCE_SECURE_COOKIES: '1',
      PDPP_OWNER_SAMESITE: 'lax',
      PDPP_TEST_CONCURRENCY: '2',
    };

    const scrubbed = buildScrubbedTestEnv(polluted);

    for (const key of TEST_ENV_DENYLIST) {
      assert.equal(
        Object.hasOwn(scrubbed, key),
        false,
        `${key} must not leak into the test-worker env`,
      );
    }
    assert.equal(scrubbed.PATH, '/usr/bin');
    assert.equal(scrubbed.PDPP_TEST_CONCURRENCY, '2');
  });

  it('defaults PDPP_RUNTIME_QUIET to "1" but honors an explicit value', () => {
    const quietImplicit = buildScrubbedTestEnv({ PATH: '/usr/bin' });
    assert.equal(quietImplicit.PDPP_RUNTIME_QUIET, '1');

    const quietExplicit = buildScrubbedTestEnv({
      PATH: '/usr/bin',
      PDPP_RUNTIME_QUIET: '0',
    });
    assert.equal(quietExplicit.PDPP_RUNTIME_QUIET, '0');
  });

  it('direct node --test startServer ignores inherited owner-auth env unless options opt in', async () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, 'sanity: this test runs under node --test');
    const previous = {
      PDPP_OWNER_FORCE_SECURE_COOKIES: process.env.PDPP_OWNER_FORCE_SECURE_COOKIES,
      PDPP_OWNER_PASSWORD: process.env.PDPP_OWNER_PASSWORD,
      PDPP_OWNER_SAMESITE: process.env.PDPP_OWNER_SAMESITE,
      PDPP_OWNER_SUBJECT_ID: process.env.PDPP_OWNER_SUBJECT_ID,
      PDPP_OWNER_TOKEN: process.env.PDPP_OWNER_TOKEN,
    };
    process.env.PDPP_OWNER_FORCE_SECURE_COOKIES = '1';
    process.env.PDPP_OWNER_PASSWORD = 'bootstrap-probe';
    process.env.PDPP_OWNER_SAMESITE = 'strict';
    process.env.PDPP_OWNER_SUBJECT_ID = 'owner-probe';
    process.env.PDPP_OWNER_TOKEN = 'owner-token-probe';

    const { startServer } = await import('../server/index.js');
    const server = await startServer({
      asPort: 0,
      dbPath: ':memory:',
      quiet: true,
      rsPort: 0,
    });
    try {
      const response = await fetch(`http://localhost:${server.asPort}/_ref/traces`);
      assert.equal(response.status, 200);
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

  it('lists the owner-auth vars that the harness must scrub', () => {
    // Locks the denylist contents so a future refactor cannot silently drop a
    // var. If you add or remove an owner-auth env var, update both the
    // denylist and this assertion together.
    assert.deepEqual(
      [...TEST_ENV_DENYLIST].sort(),
      [
        'PDPP_OWNER_FORCE_SECURE_COOKIES',
        'PDPP_OWNER_PASSWORD',
        'PDPP_OWNER_SAMESITE',
        'PDPP_OWNER_SUBJECT_ID',
        'PDPP_OWNER_TOKEN',
      ],
    );
  });
});
