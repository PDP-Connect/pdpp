// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRefEventSubscriptions } from '../src/ref/commands/event-subscriptions.js';
import { PdppUsageError } from '../src/ref/errors.js';

function mockFetch(responses) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const key = (typeof url === 'string' ? url : url.toString());
    calls.push({ url: key, opts });
    const route = Object.keys(responses).find((k) => k === key || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
    if (!route) {
      throw new Error(`Unexpected fetch: ${key}`);
    }
    const { body, status = 200 } = responses[route];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? 'Unauthorized' : 'OK',
      text: async () => text,
      headers: { get: () => null },
    };
  };
  impl.calls = calls;
  return impl;
}

function capture(extra = {}) {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (c) => { out += c; } },
      stderr: { write: (c) => { err += c; } },
      ...extra,
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

const SAMPLE_LIST = {
  object: 'list',
  data: [
    {
      subscription_id: 'sub_alpha',
      client_id: 'client_alpha',
      grant_id: 'grant_one',
      status: 'active',
      callback_host: 'client.example',
      disabled_reason: null,
      created_at: '2026-05-27T00:00:00.000Z',
      updated_at: '2026-05-27T00:00:00.000Z',
      disabled_at: null,
      pending_queue_count: 0,
      final_failure_count: 0,
      last_attempted_at: '2026-05-27T00:00:05.000Z',
      last_attempt_ok: true,
      last_attempt_status_code: 200,
    },
  ],
};

const SAMPLE_DETAIL = {
  subscription_id: 'sub_alpha',
  client_id: 'client_alpha',
  grant_id: 'grant_one',
  subject_id: 'owner_local',
  status: 'active',
  disabled_reason: null,
  callback_url: 'https://client.example/hook',
  callback_host: 'client.example',
  scope: { streams: [{ name: 'messages' }] },
  created_at: '2026-05-27T00:00:00.000Z',
  updated_at: '2026-05-27T00:00:00.000Z',
  disabled_at: null,
  pending_queue_count: 0,
  final_failure_count: 0,
  last_attempted_at: null,
  last_attempt_ok: null,
  last_attempt_status_code: null,
  recent_attempts: [],
};

const DISABLED_DETAIL = {
  ...SAMPLE_DETAIL,
  status: 'disabled',
  disabled_reason: 'operator_disabled',
  disabled_at: '2026-05-27T01:00:00.000Z',
};

// ---------------------------------------------------------------------------

test('event-subscriptions list (json) hits the canonical _ref route', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions': { body: SAMPLE_LIST },
  });
  const c = capture();
  const code = await runRefEventSubscriptions(
    ['list', '--as-url', 'http://ref.test', '--format', 'json'],
    c.io,
    fetchImpl,
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(c.stdout), SAMPLE_LIST);
});

test('event-subscriptions list forwards filter flags as query params', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions?client_id=client_alpha&status=disabled': {
      body: SAMPLE_LIST,
    },
  });
  const c = capture();
  const code = await runRefEventSubscriptions(
    [
      'list',
      '--as-url', 'http://ref.test',
      '--client-id', 'client_alpha',
      '--status', 'disabled',
      '--format', 'json',
    ],
    c.io,
    fetchImpl,
  );
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 1);
});

test('event-subscriptions list table format renders projection rows', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions': { body: SAMPLE_LIST },
  });
  const c = capture();
  await runRefEventSubscriptions(['list', '--as-url', 'http://ref.test', '--format', 'table'], c.io, fetchImpl);
  // Table prints headers + rows; check we see subscription id and callback host.
  assert.match(c.stdout, /sub_alpha/);
  assert.match(c.stdout, /client\.example/);
});

test('event-subscriptions show requires subscription-id', async () => {
  const fetchImpl = mockFetch({});
  const c = capture();
  await assert.rejects(
    () => runRefEventSubscriptions(['show', '--as-url', 'http://ref.test'], c.io, fetchImpl),
    PdppUsageError,
  );
});

test('event-subscriptions show fetches detail by id', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions/sub_alpha': { body: SAMPLE_DETAIL },
  });
  const c = capture();
  const code = await runRefEventSubscriptions(
    ['show', 'sub_alpha', '--as-url', 'http://ref.test', '--format', 'json'],
    c.io,
    fetchImpl,
  );
  assert.equal(code, 0);
  const body = JSON.parse(c.stdout);
  assert.equal(body.subscription_id, 'sub_alpha');
  for (const banned of ['secret', 'secret_hash', 'secret_text']) {
    assert.equal(banned in body, false);
  }
});

test('event-subscriptions disable --yes posts the disable request without prompting', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions/sub_alpha/disable': { body: DISABLED_DETAIL },
  });
  const c = capture();
  const code = await runRefEventSubscriptions(
    ['disable', 'sub_alpha', '--as-url', 'http://ref.test', '--yes', '--reason', 'loop_suspected', '--format', 'json'],
    c.io,
    fetchImpl,
  );
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.opts.method, 'POST');
  assert.equal(JSON.parse(call.opts.body).reason, 'loop_suspected');
  const detail = JSON.parse(c.stdout);
  assert.equal(detail.status, 'disabled');
});

test('event-subscriptions disable without --yes prompts and accepts "yes"', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions/sub_alpha': { body: SAMPLE_DETAIL },
    'http://ref.test/_ref/event-subscriptions/sub_alpha/disable': { body: DISABLED_DETAIL },
  });
  const c = capture({
    stdin: makeStdinStream('yes\n'),
  });
  const code = await runRefEventSubscriptions(
    ['disable', 'sub_alpha', '--as-url', 'http://ref.test', '--format', 'json'],
    c.io,
    fetchImpl,
  );
  assert.equal(code, 0);
  assert.match(c.stderr, /Subscription sub_alpha/);
  assert.match(c.stderr, /Disable subscription\?/);
  // Two calls: detail fetch + disable POST.
  assert.equal(fetchImpl.calls.length, 2);
});

test('event-subscriptions disable without --yes aborts on no answer', async () => {
  const fetchImpl = mockFetch({
    'http://ref.test/_ref/event-subscriptions/sub_alpha': { body: SAMPLE_DETAIL },
  });
  const c = capture({
    stdin: makeStdinStream('no\n'),
  });
  const code = await runRefEventSubscriptions(
    ['disable', 'sub_alpha', '--as-url', 'http://ref.test'],
    c.io,
    fetchImpl,
  );
  assert.equal(code, 1);
  assert.match(c.stderr, /Aborted/);
  // Only the detail fetch; no POST.
  assert.equal(fetchImpl.calls.length, 1);
});

test('unknown subcommand throws usage error', async () => {
  await assert.rejects(
    () => runRefEventSubscriptions(['frobnicate'], capture().io, async () => ({ ok: true, status: 200, text: async () => '', headers: { get: () => null } })),
    PdppUsageError,
  );
});

// ---------------------------------------------------------------------------
// helpers

import { Readable } from 'node:stream';
function makeStdinStream(text) {
  const stream = Readable.from([Buffer.from(text, 'utf8')]);
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}
