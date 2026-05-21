import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_ENV_DENYLIST,
  buildScrubbedTestEnv,
} from '../scripts/test-env.js';

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
