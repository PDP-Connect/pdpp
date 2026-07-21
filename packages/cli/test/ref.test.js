import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCli } from '../src/index.js';
import { runRefRun } from '../src/ref/commands/run.js';
import { runRefGrant } from '../src/ref/commands/grant.js';
import { runRefTrace } from '../src/ref/commands/trace.js';
import { PdppCliError, PdppHttpError, PdppUsageError } from '../src/ref/errors.js';

// ---- helpers ----------------------------------------------------------------

function mockFetch(responses) {
  return async (url) => {
    const key = url.toString();
    if (!Object.hasOwn(responses, key)) {
      throw new Error(`Unexpected fetch: ${key}`);
    }
    const { body, status = 200 } = responses[key];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : 'OK',
      text: async () => text,
      headers: { get: () => null },
    };
  };
}

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

// ---- pdpp ref run timeline --------------------------------------------------

test('ref run timeline: fetches correct URL and outputs table', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/runs/run-abc/timeline': {
      body: { data: [{ event: 'started', ts: '2024-01-01' }] },
    },
  });

  const captured = capture();
  const code = await runRefRun(
    ['timeline', 'run-abc', '--as-url', 'https://ref.test', '--format', 'table'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  assert.match(captured.stdout, /started/);
  assert.match(captured.stdout, /event/);
});

test('ref run timeline: outputs JSON when --format json', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/runs/run-abc/timeline': {
      body: { data: [{ event: 'done' }] },
    },
  });

  const captured = capture();
  await runRefRun(
    ['timeline', 'run-abc', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, { data: [{ event: 'done' }] });
});

test('ref run timeline: sends Cookie header from --owner-session flag', async () => {
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
    ['timeline', 'run-abc', '--as-url', 'https://ref.test', '--owner-session', 'mysecret'],
    io,
    fetch
  );

  assert.equal(capturedHeaders.Cookie, 'pdpp_owner_session=mysecret');
});

test('ref run timeline: sends Cookie from PDPP_OWNER_SESSION_COOKIE env var', async () => {
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

  const orig = process.env.PDPP_OWNER_SESSION_COOKIE;
  process.env.PDPP_OWNER_SESSION_COOKIE = 'env-session-value';
  try {
    const { io } = capture();
    await runRefRun(
      ['timeline', 'run-abc', '--as-url', 'https://ref.test'],
      io,
      fetch
    );
    assert.equal(capturedHeaders.Cookie, 'pdpp_owner_session=env-session-value');
  } finally {
    if (orig === undefined) {
      delete process.env.PDPP_OWNER_SESSION_COOKIE;
    } else {
      process.env.PDPP_OWNER_SESSION_COOKIE = orig;
    }
  }
});

test('ref run timeline: throws PdppUsageError when missing run-id', async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefRun(['timeline', '--as-url', 'https://ref.test'], io, mockFetch({})),
    (err) => err instanceof PdppUsageError && /run-id/.test(err.message)
  );
});

test('ref run timeline: throws PdppCliError when --as-url missing', async () => {
  const orig = process.env.PDPP_AS_URL;
  delete process.env.PDPP_AS_URL;
  delete process.env.AS_URL;
  try {
    const { io } = capture();
    await assert.rejects(
      () => runRefRun(['timeline', 'run-abc'], io, mockFetch({})),
      (err) => err instanceof PdppCliError && /as-url/.test(err.message)
    );
  } finally {
    if (orig !== undefined) process.env.PDPP_AS_URL = orig;
  }
});

test('ref run timeline: throws PdppHttpError with exit code 3 on 401', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/runs/run-abc/timeline': {
      body: { error_description: 'not authenticated' },
      status: 401,
    },
  });

  const { io } = capture();
  await assert.rejects(
    () => runRefRun(['timeline', 'run-abc', '--as-url', 'https://ref.test'], io, fetch),
    (err) => err instanceof PdppHttpError && err.exitCode === 3 && err.status === 401
  );
});

// ---- pdpp ref grant timeline ------------------------------------------------

test('ref grant timeline: fetches correct URL and outputs table', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/grants/grant-xyz/timeline': {
      body: { data: [{ event: 'granted', ts: '2024-01-02' }] },
    },
  });

  const captured = capture();
  const code = await runRefGrant(
    ['timeline', 'grant-xyz', '--as-url', 'https://ref.test', '--format', 'table'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  assert.match(captured.stdout, /granted/);
});

test('ref grant timeline: sends Cookie header from --owner-session', async () => {
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
  await runRefGrant(
    ['timeline', 'grant-xyz', '--as-url', 'https://ref.test', '--owner-session', 'tok=val'],
    io,
    fetch
  );

  assert.equal(capturedHeaders.Cookie, 'tok=val');
});

test('ref grant timeline: throws PdppUsageError for unknown subcommand', async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefGrant(['revoke', 'grant-xyz', '--as-url', 'https://ref.test'], io, mockFetch({})),
    (err) => err instanceof PdppUsageError
  );
});

// ---- pdpp ref trace show ----------------------------------------------------

test('ref trace show: fetches correct URL and outputs table', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/traces/trace-111': {
      body: { data: [{ step: 'auth', result: 'ok' }] },
    },
  });

  const captured = capture();
  const code = await runRefTrace(
    ['show', 'trace-111', '--as-url', 'https://ref.test', '--format', 'table'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  assert.match(captured.stdout, /auth/);
});

test('ref trace show: outputs JSON when --format json', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/traces/trace-111': {
      body: { data: [{ step: 'complete' }] },
    },
  });

  const captured = capture();
  await runRefTrace(
    ['show', 'trace-111', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, { data: [{ step: 'complete' }] });
});

test('ref trace show: throws PdppUsageError for unknown subcommand', async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefTrace(['list', '--as-url', 'https://ref.test'], io, mockFetch({})),
    (err) => err instanceof PdppUsageError
  );
});

// ---- pdpp ref routing via runCli --------------------------------------------

test('runCli ref run timeline routes to handler and returns 0', async () => {
  // We patch globalThis.fetch for the duration of this test
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    'https://ref.test/_ref/runs/run-abc/timeline': { body: { data: [] } },
  });

  try {
    const captured = capture();
    const code = await runCli(
      ['ref', 'run', 'timeline', 'run-abc', '--as-url', 'https://ref.test', '--format', 'json'],
      captured.io
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(captured.stdout), { data: [] });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('runCli ref grant timeline routes to handler and returns 0', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    'https://ref.test/_ref/grants/grant-xyz/timeline': { body: { data: [] } },
  });

  try {
    const captured = capture();
    const code = await runCli(
      ['ref', 'grant', 'timeline', 'grant-xyz', '--as-url', 'https://ref.test', '--format', 'json'],
      captured.io
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(captured.stdout), { data: [] });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('runCli ref trace show routes to handler and returns 0', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    'https://ref.test/_ref/traces/trace-111': { body: { data: [] } },
  });

  try {
    const captured = capture();
    const code = await runCli(
      ['ref', 'trace', 'show', 'trace-111', '--as-url', 'https://ref.test', '--format', 'json'],
      captured.io
    );
    assert.equal(code, 0);
    void captured.stdout; // captured but not asserted in this test
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('runCli ref --help prints reference diagnostics', async () => {
  const captured = capture();
  const code = await runCli(['ref', '--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /ref run timeline/);
  assert.match(captured.stdout, /ref grant timeline/);
  assert.match(captured.stdout, /ref trace show/);
});

test('runCli ref unknown subcommand returns 64', async () => {
  const captured = capture();
  const code = await runCli(['ref', 'unknown-cmd'], captured.io);
  assert.equal(code, 64);
  assert.match(captured.stderr, /Unknown ref command/);
});

test('runCli ref missing session error exits with non-zero code', async () => {
  const orig = process.env.PDPP_AS_URL;
  process.env.PDPP_AS_URL = 'https://ref.test';
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    'https://ref.test/_ref/runs/missing-run/timeline': {
      body: { error_description: 'not authenticated' },
      status: 401,
    },
  });

  try {
    const { io } = capture();
    const code = await runCli(['ref', 'run', 'timeline', 'missing-run'], io);
    assert.equal(code, 3);
  } finally {
    if (orig === undefined) delete process.env.PDPP_AS_URL;
    else process.env.PDPP_AS_URL = orig;
    globalThis.fetch = origFetch;
  }
});

test('help output mentions reference diagnostics section', async () => {
  const captured = capture();
  const code = await runCli(['--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /Reference diagnostics/);
  assert.match(captured.stdout, /ref run timeline/);
});

// ---- canonical envelope warnings (task 6.3) --------------------------------
//
// pdpp ref run|grant|trace commands MUST surface canonical `meta.warnings`
// on stderr without polluting stdout JSON, matching `pdpp ref connectors`.

test('ref run timeline: surfaces meta.warnings on stderr without polluting JSON stdout', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/runs/run-abc/timeline': {
      body: {
        data: [{ event: 'started' }],
        meta: {
          warnings: [
            { code: 'deprecated_alias', message: 'connector_instance_id is deprecated; use connection_id' },
          ],
        },
      },
    },
  });

  const captured = capture();
  const code = await runRefRun(
    ['timeline', 'run-abc', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.data.length, 1);
  assert.match(captured.stderr, /warning: deprecated_alias/);
  assert.match(captured.stderr, /connector_instance_id is deprecated/);
});

test('ref grant timeline: surfaces meta.warnings on stderr', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/grants/grant-1/timeline': {
      body: {
        data: [{ event: 'issued' }],
        meta: { warnings: [{ code: 'partial_results', message: 'one source unavailable' }] },
      },
    },
  });

  const captured = capture();
  const code = await runRefGrant(
    ['timeline', 'grant-1', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  assert.match(captured.stderr, /warning: partial_results — one source unavailable/);
});

test('ref trace show: surfaces meta.warnings on stderr', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/traces/trace-xyz': {
      body: {
        data: [{ event: 'request_received' }],
        meta: { warnings: [{ code: 'count_downgraded', dropped_parameter: 'count=exact' }] },
      },
    },
  });

  const captured = capture();
  const code = await runRefTrace(
    ['show', 'trace-xyz', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  assert.match(captured.stderr, /warning: count_downgraded/);
  assert.match(captured.stderr, /\(dropped: count=exact\)/);
});

test('ref run timeline: emits no stderr noise when meta.warnings is absent', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/runs/run-abc/timeline': {
      body: { data: [{ event: 'started' }] },
    },
  });

  const captured = capture();
  await runRefRun(
    ['timeline', 'run-abc', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  assert.equal(captured.stderr, '');
});
