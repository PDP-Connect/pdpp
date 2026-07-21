// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from '../src/index.js';
import { runRefLogin } from '../src/ref/commands/login.js';
import { runRefRun } from '../src/ref/commands/run.js';
import { PdppCliError, PdppUsageError } from '../src/ref/errors.js';
import {
  extractCookieFromSetCookie,
  getOwnerSessionPaths,
  readOwnerSession,
  writeOwnerSession,
} from '../src/ref/session.js';
import { ownerSessionHeaders } from '../src/ref/fetch.js';

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

async function withTmpCache(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pdpp-ref-login-'));
  try {
    return await fn(join(root, '.pdpp'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function loginFetch({ status = 302, cookieValue = 'abc123' } = {}) {
  return async (url, opts = {}) => {
    return {
      status,
      headers: {
        getSetCookie: () =>
          cookieValue
            ? [`pdpp_owner_session=${cookieValue}; Path=/; HttpOnly`]
            : [],
        get: () => null,
      },
      text: async () => '',
      __debug: { url, opts },
    };
  };
}

// ---- session helpers --------------------------------------------------------

test('writeOwnerSession persists cookie with 0600 file mode and gitignore', async () => {
  await withTmpCache(async (cacheRoot) => {
    const file = writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=abc',
      cacheRoot,
    });
    assert.ok(existsSync(file), 'session file should be created');
    assert.equal(statSync(file).mode & 0o777, 0o600);

    const gi = join(cacheRoot, '.gitignore');
    assert.ok(existsSync(gi));
    assert.match(readFileSync(gi, 'utf8'), /\*/);
  });
});

test('readOwnerSession returns cached cookie; getOwnerSessionPaths derives origin', async () => {
  await withTmpCache(async (cacheRoot) => {
    const { file } = getOwnerSessionPaths('https://ref.test:8443', { cacheRoot });
    assert.match(file, /https___ref\.test_8443\.json$/);

    writeOwnerSession({
      referenceUrl: 'https://ref.test:8443',
      cookie: 'pdpp_owner_session=cached',
      cacheRoot,
    });
    const got = readOwnerSession({ referenceUrl: 'https://ref.test:8443', cacheRoot });
    assert.equal(got.cookie, 'pdpp_owner_session=cached');

    assert.equal(readOwnerSession({ referenceUrl: 'http://ref.test:8443', cacheRoot }), null);
  });
});

test('extractCookieFromSetCookie reads named cookie from various shapes', () => {
  assert.equal(
    extractCookieFromSetCookie(['pdpp_owner_session=ok; Path=/; HttpOnly'], 'pdpp_owner_session'),
    'ok',
  );
  assert.equal(
    extractCookieFromSetCookie('pdpp_owner_session=v2; Secure', 'pdpp_owner_session'),
    'v2',
  );
  assert.equal(
    extractCookieFromSetCookie('other=1; Path=/', 'pdpp_owner_session'),
    null,
  );
});

// ---- ownerSessionHeaders precedence -----------------------------------------

test('ownerSessionHeaders precedence: --owner-session beats env beats cache', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=from-cache',
      cacheRoot,
    });

    const origEnv = process.env.PDPP_OWNER_SESSION_COOKIE;
    process.env.PDPP_OWNER_SESSION_COOKIE = 'env-val';
    try {
      // 1. flag wins
      assert.equal(
        ownerSessionHeaders({
          ownerSession: 'flag-val',
          referenceUrl: 'https://ref.test',
          cacheRoot,
        }).Cookie,
        'pdpp_owner_session=flag-val',
      );

      // 2. env wins over cache
      assert.equal(
        ownerSessionHeaders({
          referenceUrl: 'https://ref.test',
          cacheRoot,
        }).Cookie,
        'pdpp_owner_session=env-val',
      );

      // 3. cache used when env+flag absent
      delete process.env.PDPP_OWNER_SESSION_COOKIE;
      assert.equal(
        ownerSessionHeaders({
          referenceUrl: 'https://ref.test',
          cacheRoot,
        }).Cookie,
        'pdpp_owner_session=from-cache',
      );

      // 4. no cookie when nothing available
      assert.deepEqual(
        ownerSessionHeaders({
          referenceUrl: 'https://other.test',
          cacheRoot,
        }),
        {},
      );
    } finally {
      if (origEnv === undefined) delete process.env.PDPP_OWNER_SESSION_COOKIE;
      else process.env.PDPP_OWNER_SESSION_COOKIE = origEnv;
    }
  });
});

// ---- ref login command ------------------------------------------------------

test('ref login: requires <reference-url> positional', async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefLogin([], io, loginFetch()),
    (err) => err instanceof PdppUsageError && /reference-url/.test(err.message),
  );
});

test('ref login: requires password from stdin or env, never argv', async () => {
  const orig = process.env.PDPP_OWNER_PASSWORD;
  delete process.env.PDPP_OWNER_PASSWORD;
  try {
    const { io } = capture();
    await assert.rejects(
      () => runRefLogin(['https://ref.test'], io, loginFetch()),
      (err) => err instanceof PdppUsageError && /password/i.test(err.message),
    );
  } finally {
    if (orig !== undefined) process.env.PDPP_OWNER_PASSWORD = orig;
  }
});

test('ref login: success caches session, never prints cookie value', async () => {
  await withTmpCache(async (cacheRoot) => {
    const captured = capture();
    const orig = process.env.PDPP_OWNER_PASSWORD;
    process.env.PDPP_OWNER_PASSWORD = 'hunter2';
    try {
      const code = await runRefLogin(
        ['https://ref.test', '--cache-root', cacheRoot],
        captured.io,
        loginFetch({ status: 302, cookieValue: 'secret-cookie-value' }),
      );
      assert.equal(code, 0);

      // Cookie value must not appear in any output.
      assert.doesNotMatch(captured.stdout, /secret-cookie-value/);
      assert.doesNotMatch(captured.stdout, /hunter2/);
      assert.doesNotMatch(captured.stderr, /secret-cookie-value/);
      assert.doesNotMatch(captured.stderr, /hunter2/);

      // Session file persisted with secret perms.
      const { file } = getOwnerSessionPaths('https://ref.test', { cacheRoot });
      assert.ok(existsSync(file));
      assert.equal(statSync(file).mode & 0o777, 0o600);

      const cached = readOwnerSession({ referenceUrl: 'https://ref.test', cacheRoot });
      assert.equal(cached.cookie, 'pdpp_owner_session=secret-cookie-value');
    } finally {
      if (orig === undefined) delete process.env.PDPP_OWNER_PASSWORD;
      else process.env.PDPP_OWNER_PASSWORD = orig;
    }
  });
});

test('ref login: 401 yields bounded error with exit code 3', async () => {
  const orig = process.env.PDPP_OWNER_PASSWORD;
  process.env.PDPP_OWNER_PASSWORD = 'wrong';
  try {
    const { io } = capture();
    await assert.rejects(
      () => runRefLogin(['https://ref.test'], io, loginFetch({ status: 401, cookieValue: '' })),
      (err) =>
        err instanceof PdppCliError &&
        err.exitCode === 3 &&
        /incorrect password/i.test(err.message),
    );
  } finally {
    if (orig === undefined) delete process.env.PDPP_OWNER_PASSWORD;
    else process.env.PDPP_OWNER_PASSWORD = orig;
  }
});

test('ref login: 404 yields bounded error with exit code 5', async () => {
  const orig = process.env.PDPP_OWNER_PASSWORD;
  process.env.PDPP_OWNER_PASSWORD = 'pw';
  try {
    const { io } = capture();
    await assert.rejects(
      () => runRefLogin(['https://ref.test'], io, loginFetch({ status: 404, cookieValue: '' })),
      (err) => err instanceof PdppCliError && err.exitCode === 5,
    );
  } finally {
    if (orig === undefined) delete process.env.PDPP_OWNER_PASSWORD;
    else process.env.PDPP_OWNER_PASSWORD = orig;
  }
});

test('ref login: success but missing Set-Cookie yields PdppCliError', async () => {
  const orig = process.env.PDPP_OWNER_PASSWORD;
  process.env.PDPP_OWNER_PASSWORD = 'pw';
  try {
    const { io } = capture();
    await assert.rejects(
      () => runRefLogin(['https://ref.test'], io, loginFetch({ status: 302, cookieValue: '' })),
      (err) => err instanceof PdppCliError && /no owner-session cookie/i.test(err.message),
    );
  } finally {
    if (orig === undefined) delete process.env.PDPP_OWNER_PASSWORD;
    else process.env.PDPP_OWNER_PASSWORD = orig;
  }
});

// ---- cached session used by later ref commands ------------------------------

test('ref run timeline uses cached session when flag and env are absent', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=from-cache',
      cacheRoot,
    });

    let capturedHeaders = null;
    const fetch = async (_url, opts = {}) => {
      capturedHeaders = opts.headers || {};
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
        headers: { get: () => null },
      };
    };

    const origEnv = process.env.PDPP_OWNER_SESSION_COOKIE;
    delete process.env.PDPP_OWNER_SESSION_COOKIE;
    try {
      const { io } = capture();
      await runRefRun(
        ['timeline', 'run-1', '--as-url', 'https://ref.test', '--cache-root', cacheRoot],
        io,
        fetch,
      );
      assert.equal(capturedHeaders.Cookie, 'pdpp_owner_session=from-cache');
    } finally {
      if (origEnv !== undefined) process.env.PDPP_OWNER_SESSION_COOKIE = origEnv;
    }
  });
});

test('ref run timeline: --owner-session flag overrides cached session', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=from-cache',
      cacheRoot,
    });

    let capturedHeaders = null;
    const fetch = async (_url, opts = {}) => {
      capturedHeaders = opts.headers || {};
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [] }),
        headers: { get: () => null },
      };
    };

    const { io } = capture();
    await runRefRun(
      [
        'timeline',
        'run-1',
        '--as-url',
        'https://ref.test',
        '--cache-root',
        cacheRoot,
        '--owner-session',
        'flag-only',
      ],
      io,
      fetch,
    );
    assert.equal(capturedHeaders.Cookie, 'pdpp_owner_session=flag-only');
  });
});

// ---- runCli routing for ref login -------------------------------------------

test('runCli ref login routes through login command and persists session', async () => {
  await withTmpCache(async (cacheRoot) => {
    const origPw = process.env.PDPP_OWNER_PASSWORD;
    process.env.PDPP_OWNER_PASSWORD = 'pw';
    const origFetch = globalThis.fetch;
    globalThis.fetch = loginFetch({ status: 302, cookieValue: 'routed-cookie' });
    try {
      const captured = capture();
      const code = await runCli(
        ['ref', 'login', 'https://ref.test', '--cache-root', cacheRoot],
        captured.io,
      );
      assert.equal(code, 0);
      assert.doesNotMatch(captured.stdout, /routed-cookie/);
      const cached = readOwnerSession({ referenceUrl: 'https://ref.test', cacheRoot });
      assert.equal(cached.cookie, 'pdpp_owner_session=routed-cookie');
    } finally {
      globalThis.fetch = origFetch;
      if (origPw === undefined) delete process.env.PDPP_OWNER_PASSWORD;
      else process.env.PDPP_OWNER_PASSWORD = origPw;
    }
  });
});

test('runCli ref --help advertises login', async () => {
  const captured = capture();
  const code = await runCli(['ref', '--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /ref login/);
});
