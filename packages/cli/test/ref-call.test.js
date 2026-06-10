import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { runCli } from '../src/index.js';
import { runRefCall } from '../src/ref/commands/call.js';
import { inferAuthMode, resolveAuthMode, buildAuthHeaders, AUTH_COOKIE, AUTH_BEARER } from '../src/ref/auth.js';
import { PdppUsageError, PdppHttpError } from '../src/ref/errors.js';
import { writeOwnerSession } from '../src/ref/session.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function stdinFrom(text) {
  return Readable.from([text]);
}

// A fetch double that records the single request it received and returns a
// canned response. `text()` returns the JSON-encoded body.
function fakeFetch({ status = 200, statusText = 'OK', body = {} } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    return {
      status,
      statusText,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

async function withTmpCache(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pdpp-ref-call-'));
  try {
    return await fn(join(root, '.pdpp'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---- auth mode inference ----------------------------------------------------

test('inferAuthMode maps /_ref/* to cookie and /v1/owner/* to bearer', () => {
  assert.equal(inferAuthMode('/_ref/dataset/summary/reconcile'), AUTH_COOKIE);
  assert.equal(inferAuthMode('/_ref/runs/run_1/cancel'), AUTH_COOKIE);
  assert.equal(inferAuthMode('/v1/owner/connections/c1/run'), AUTH_BEARER);
  assert.equal(inferAuthMode('/v1/owner/control'), AUTH_BEARER);
});

test('inferAuthMode tolerates full URLs and query strings', () => {
  assert.equal(inferAuthMode('https://ref.test/_ref/deployment?x=1'), AUTH_COOKIE);
  assert.equal(inferAuthMode('https://ref.test/v1/owner/connections'), AUTH_BEARER);
});

test('inferAuthMode returns null for non-owner paths (e.g. /v1/streams)', () => {
  assert.equal(inferAuthMode('/v1/streams'), null);
  assert.equal(inferAuthMode('/v1/search'), null);
  assert.equal(inferAuthMode('/health'), null);
});

// ---- mismatch guard ---------------------------------------------------------

test('resolveAuthMode infers when no override', () => {
  assert.equal(resolveAuthMode('/_ref/deployment'), AUTH_COOKIE);
  assert.equal(resolveAuthMode('/v1/owner/control'), AUTH_BEARER);
});

test('resolveAuthMode accepts a matching override', () => {
  assert.equal(resolveAuthMode('/_ref/deployment', 'cookie'), AUTH_COOKIE);
  assert.equal(resolveAuthMode('/v1/owner/control', 'bearer'), AUTH_BEARER);
});

test('resolveAuthMode rejects bearer pointed at /_ref/* with a corrective hint', () => {
  assert.throws(
    () => resolveAuthMode('/_ref/runs/r1/cancel', 'bearer'),
    (e) => {
      assert.ok(e instanceof PdppUsageError);
      assert.match(e.message, /\/_ref\/\* uses the owner session cookie/);
      assert.match(e.message, /cookie/);
      return true;
    }
  );
});

test('resolveAuthMode rejects cookie pointed at /v1/owner/* with a corrective hint', () => {
  assert.throws(
    () => resolveAuthMode('/v1/owner/connections/c1/run', 'cookie'),
    (e) => {
      assert.ok(e instanceof PdppUsageError);
      assert.match(e.message, /\/v1\/owner\/\* uses the owner bearer/);
      return true;
    }
  );
});

test('resolveAuthMode rejects an unrecognized path without an override', () => {
  assert.throws(() => resolveAuthMode('/v1/streams'), PdppUsageError);
});

test('resolveAuthMode honors an explicit override for a non-standard path', () => {
  assert.equal(resolveAuthMode('/custom/route', 'cookie'), AUTH_COOKIE);
});

test('resolveAuthMode rejects a bogus --auth value', () => {
  assert.throws(() => resolveAuthMode('/_ref/deployment', 'token'), PdppUsageError);
});

// ---- header building & secret handling --------------------------------------

test('buildAuthHeaders cookie mode uses the cached session and never echoes it', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=secret-cookie',
      cacheRoot,
    });
    const headers = await buildAuthHeaders({
      mode: AUTH_COOKIE,
      referenceUrl: 'https://ref.test',
      flags: { 'cache-root': cacheRoot },
      io: {},
    });
    assert.equal(headers.Cookie, 'pdpp_owner_session=secret-cookie');
  });
});

test('buildAuthHeaders cookie mode errors when no session is available', async () => {
  await withTmpCache(async (cacheRoot) => {
    await assert.rejects(
      buildAuthHeaders({
        mode: AUTH_COOKIE,
        referenceUrl: 'https://ref.test',
        flags: { 'cache-root': cacheRoot },
        io: {},
        env: {},
      }),
      (e) => {
        assert.ok(e instanceof PdppUsageError);
        assert.match(e.message, /pdpp ref login/);
        return true;
      }
    );
  });
});

test('buildAuthHeaders bearer mode reads PDPP_OWNER_TOKEN from env', async () => {
  const headers = await buildAuthHeaders({
    mode: AUTH_BEARER,
    referenceUrl: 'https://ref.test',
    flags: {},
    io: {},
    env: { PDPP_OWNER_TOKEN: 'owner-bearer-xyz' },
  });
  assert.equal(headers.Authorization, 'Bearer owner-bearer-xyz');
});

test('buildAuthHeaders bearer mode reads --owner-token-stdin', async () => {
  const headers = await buildAuthHeaders({
    mode: AUTH_BEARER,
    referenceUrl: 'https://ref.test',
    flags: { 'owner-token-stdin': true },
    io: { stdin: stdinFrom('piped-bearer\n') },
    env: {},
  });
  assert.equal(headers.Authorization, 'Bearer piped-bearer');
});

test('buildAuthHeaders bearer mode errors when no token is available', async () => {
  await assert.rejects(
    buildAuthHeaders({
      mode: AUTH_BEARER,
      referenceUrl: 'https://ref.test',
      flags: {},
      io: {},
      env: {},
    }),
    (e) => {
      assert.ok(e instanceof PdppUsageError);
      assert.match(e.message, /PDPP_OWNER_TOKEN/);
      return true;
    }
  );
});

// ---- end-to-end command behavior --------------------------------------------

test('ref call sends a JSON POST to /_ref/* with the cookie and no _csrf', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=cookie-val',
      cacheRoot,
    });
    const fetchImpl = fakeFetch({ status: 200, body: { object: 'dataset_summary_reconcile', reconciled: 3 } });
    const cap = capture();
    const code = await runRefCall(
      ['POST', '/_ref/dataset/summary/reconcile', '--as-url', 'https://ref.test', '--cache-root', cacheRoot],
      cap.io,
      fetchImpl
    );
    assert.equal(code, 0);
    assert.equal(fetchImpl.calls.length, 1);
    const { url, opts } = fetchImpl.calls[0];
    assert.equal(url, 'https://ref.test/_ref/dataset/summary/reconcile');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers.Cookie, 'pdpp_owner_session=cookie-val');
    // No body was supplied, so no content-type/_csrf is sent.
    assert.equal(opts.headers['Content-Type'], undefined);
    assert.equal(opts.body, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    assert.match(cap.stdout, /dataset_summary_reconcile/);
    assert.match(cap.stderr, /POST \/_ref\/dataset\/summary\/reconcile → 200/);
    // The cookie value must never leak to stdout or stderr.
    assert.doesNotMatch(cap.stdout, /cookie-val/);
    assert.doesNotMatch(cap.stderr, /cookie-val/);
  });
});

test('ref call sends a JSON body as application/json (CSRF-exempt) with no _csrf field', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({
      referenceUrl: 'https://ref.test',
      cookie: 'pdpp_owner_session=cv',
      cacheRoot,
    });
    const fetchImpl = fakeFetch({ status: 202, statusText: 'Accepted', body: { ok: true } });
    const cap = capture();
    const code = await runRefCall(
      [
        'POST',
        '/_ref/some/action',
        '--as-url',
        'https://ref.test',
        '--cache-root',
        cacheRoot,
        '--auth',
        'cookie',
        '--data',
        '{"reason":"manual"}',
      ],
      cap.io,
      fetchImpl
    );
    assert.equal(code, 0);
    const { opts } = fetchImpl.calls[0];
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(opts.body, JSON.stringify({ reason: 'manual' }));
    assert.doesNotMatch(opts.body, /_csrf/);
  });
});

test('ref call sends a bearer GET to /v1/owner/* and never sends a cookie', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { object: 'owner_control' } });
  const cap = capture();
  const prev = process.env.PDPP_OWNER_TOKEN;
  process.env.PDPP_OWNER_TOKEN = 'bearer-abc';
  try {
    const code = await runRefCall(
      ['GET', '/v1/owner/control', '--as-url', 'https://ref.test'],
      cap.io,
      fetchImpl
    );
    assert.equal(code, 0);
    const { url, opts } = fetchImpl.calls[0];
    assert.equal(url, 'https://ref.test/v1/owner/control');
    assert.equal(opts.headers.Authorization, 'Bearer bearer-abc');
    assert.equal(opts.headers.Cookie, undefined);
    assert.doesNotMatch(cap.stdout, /bearer-abc/);
    assert.doesNotMatch(cap.stderr, /bearer-abc/);
  } finally {
    if (prev === undefined) delete process.env.PDPP_OWNER_TOKEN;
    else process.env.PDPP_OWNER_TOKEN = prev;
  }
});

test('ref call rejects a mismatched --auth before issuing any request', async () => {
  const fetchImpl = fakeFetch();
  const cap = capture();
  await assert.rejects(
    runRefCall(
      ['POST', '/_ref/runs/r1/cancel', '--as-url', 'https://ref.test', '--auth', 'bearer'],
      cap.io,
      fetchImpl
    ),
    PdppUsageError
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('ref call maps an HTTP error status to a PdppHttpError exit code', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({ referenceUrl: 'https://ref.test', cookie: 'pdpp_owner_session=cv', cacheRoot });
    const fetchImpl = fakeFetch({
      status: 404,
      statusText: 'Not Found',
      body: { error: { message: 'No active run with id: r1' } },
    });
    const cap = capture();
    await assert.rejects(
      runRefCall(
        ['POST', '/_ref/runs/r1/cancel', '--as-url', 'https://ref.test', '--cache-root', cacheRoot],
        cap.io,
        fetchImpl
      ),
      (e) => {
        assert.ok(e instanceof PdppHttpError);
        assert.equal(e.status, 404);
        assert.equal(e.exitCode, 5);
        return true;
      }
    );
  });
});

test('ref call --status-only returns a status-derived exit code without printing the body', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({ referenceUrl: 'https://ref.test', cookie: 'pdpp_owner_session=cv', cacheRoot });
    const fetchImpl = fakeFetch({ status: 202, statusText: 'Accepted', body: { ok: true } });
    const cap = capture();
    const code = await runRefCall(
      ['POST', '/_ref/runs/r1/cancel', '--as-url', 'https://ref.test', '--cache-root', cacheRoot, '--status-only'],
      cap.io,
      fetchImpl
    );
    assert.equal(code, 0);
    assert.equal(cap.stdout, '');
    assert.match(cap.stderr, /→ 202/);
  });
});

test('ref call rejects malformed --data JSON before sending', async () => {
  await withTmpCache(async (cacheRoot) => {
    writeOwnerSession({ referenceUrl: 'https://ref.test', cookie: 'pdpp_owner_session=cv', cacheRoot });
    const fetchImpl = fakeFetch();
    const cap = capture();
    await assert.rejects(
      runRefCall(
        ['POST', '/_ref/x', '--as-url', 'https://ref.test', '--cache-root', cacheRoot, '--data', '{not json}'],
        cap.io,
        fetchImpl
      ),
      PdppUsageError
    );
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('ref call rejects an unknown HTTP method', async () => {
  const cap = capture();
  await assert.rejects(
    runRefCall(['FROBNICATE', '/_ref/x', '--as-url', 'https://ref.test'], cap.io, fakeFetch()),
    PdppUsageError
  );
});

// ---- routing through runCli -------------------------------------------------

test('runCli routes "ref call" to the call handler', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { object: 'deployment' } });
  const cap = capture();
  const prev = process.env.PDPP_OWNER_SESSION_COOKIE;
  process.env.PDPP_OWNER_SESSION_COOKIE = 'pdpp_owner_session=envcookie';
  try {
    // runCli's ref dispatch calls the real handler; inject fetch via globalThis.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const code = await runCli(['ref', 'call', 'GET', '/_ref/deployment', '--as-url', 'https://ref.test'], cap.io);
      assert.equal(code, 0);
      assert.match(cap.stdout, /deployment/);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    if (prev === undefined) delete process.env.PDPP_OWNER_SESSION_COOKIE;
    else process.env.PDPP_OWNER_SESSION_COOKIE = prev;
  }
});

test('ref --help advertises the call command and its auth model', async () => {
  const cap = capture();
  const code = await runCli(['ref', '--help'], cap.io);
  assert.equal(code, 0);
  assert.match(cap.stdout, /ref call <method> <path>/);
  assert.match(cap.stdout, /\/_ref\/\* uses the owner session cookie/);
  assert.match(cap.stdout, /\/v1\/owner\/\* uses the owner bearer/);
});
