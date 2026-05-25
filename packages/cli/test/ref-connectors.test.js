import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCli } from '../src/index.js';
import { runRefConnectors } from '../src/ref/commands/connectors.js';
import { PdppHttpError, PdppUsageError } from '../src/ref/errors.js';

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

const SUMMARY_FIXTURE = {
  connection_id: 'github',
  connector_id: 'github',
  display_name: 'GitHub',
  manifest_version: '1.0.0',
  streams: ['issues', 'commits'],
  total_records: 42,
  freshness: {},
  refresh_policy: null,
  schedule: {
    next_due_at: '2026-05-19T01:00:00Z',
  },
  last_run: {
    last_at: '2026-05-19T00:30:00Z',
    status: 'succeeded',
    run_id: 'run-1',
  },
  last_successful_run: {
    last_at: '2026-05-19T00:30:00Z',
    status: 'succeeded',
    run_id: 'run-1',
  },
  next_action: {
    action_target: 'dashboard',
    attention_id: 'att-1',
    expires_at: null,
    owner_action: 'provide_value',
    reason_code: 'otp_required',
    response_contract: 'response_required',
    source: 'structured',
  },
  connection_health: {
    axes: {
      attention: 'open',
      coverage: 'partial',
      freshness: 'fresh',
      outbox: 'idle',
    },
    badges: { stale: false, syncing: true },
    conditions: [
      {
        id: 'AttentionClear:otp_required',
        type: 'AttentionClear',
        status: 'false',
        severity: 'blocked',
        reason: 'otp_required',
        message: 'Owner action is required before collection can continue.',
        origin: 'runtime',
        observed_at: '2026-05-19T00:30:00Z',
        expires_at: null,
        current: true,
        sensitivity: 'owner',
        remediation: {
          action: 'satisfy_attention',
          label: 'Open the requested interaction and complete the action',
          retryable: false,
          target: 'dashboard',
        },
      },
      {
        id: 'SourceCoverageComplete:partial',
        type: 'SourceCoverageComplete',
        status: 'false',
        severity: 'warning',
        reason: 'partial',
        message: 'Required source coverage is incomplete.',
        origin: 'connector',
        observed_at: '2026-05-19T00:30:00Z',
        expires_at: null,
        current: true,
        sensitivity: 'owner',
        remediation: null,
      },
    ],
    dominant_condition_id: 'AttentionClear:otp_required',
    last_success_at: '2026-05-19T00:30:00Z',
    next_action: {
      action_target: 'dashboard',
      attention_id: 'att-1',
      expires_at: null,
      owner_action: 'provide_value',
      reason_code: 'otp_required',
      response_contract: 'response_required',
      source: 'structured',
    },
    next_attempt_at: '2026-05-19T01:00:00Z',
    reason_code: 'attention_open',
    state: 'needs_attention',
    supporting_condition_ids: ['AttentionClear:otp_required', 'SourceCoverageComplete:partial'],
    unknown_reasons: [],
  },
};

// ---- list -------------------------------------------------------------------

test('ref connectors list: projects summary fields in JSON list', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors': { body: { object: 'list', data: [SUMMARY_FIXTURE] } },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ['list', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.object, 'list');
  assert.equal(parsed.data.length, 1);
  const row = parsed.data[0];
  assert.equal(row.connector_id, 'github');
  assert.equal(row.connection_id, 'github');
  assert.equal(row.state, 'needs_attention');
  assert.equal(row.coverage, 'partial');
  assert.equal(row.freshness, 'fresh');
  assert.equal(row.attention, 'open');
  assert.equal(row.outbox, 'idle');
  assert.equal(row.syncing, true);
  assert.equal(row.stale, false);
  assert.equal(row.reason_code, 'attention_open');
  assert.equal(row.dominant_condition_id, 'AttentionClear:otp_required');
  assert.equal(row.dominant_condition_type, 'AttentionClear');
  assert.equal(row.dominant_condition_reason, 'otp_required');
  assert.equal(row.dominant_condition_severity, 'blocked');
  assert.equal(row.dominant_condition_message, 'Owner action is required before collection can continue.');
  assert.equal(row.dominant_condition_origin, 'runtime');
  assert.deepEqual(row.supporting_condition_ids, ['AttentionClear:otp_required', 'SourceCoverageComplete:partial']);
  assert.deepEqual(row.unknown_reasons, []);
  assert.equal(row.next_action_source, 'structured');
  assert.equal(row.next_action_reason, 'otp_required');
  assert.equal(row.next_action_owner_action, 'provide_value');
  assert.equal(row.next_action_target, 'dashboard');
  assert.equal(row.last_run_at, '2026-05-19T00:30:00Z');
  assert.equal(row.last_run_status, 'succeeded');
  assert.equal(row.last_success_at, '2026-05-19T00:30:00Z');
  assert.equal(row.next_attempt_at, '2026-05-19T01:00:00Z');
});

test('ref connectors list: --verbose returns raw envelope', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors': { body: { object: 'list', data: [SUMMARY_FIXTURE] } },
  });

  const captured = capture();
  await runRefConnectors(
    ['list', '--as-url', 'https://ref.test', '--format', 'json', '--verbose'],
    captured.io,
    fetch
  );

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, { object: 'list', data: [SUMMARY_FIXTURE] });
});

test('ref connectors list: table format includes projected columns', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors': { body: { object: 'list', data: [SUMMARY_FIXTURE] } },
  });

  const captured = capture();
  await runRefConnectors(
    ['list', '--as-url', 'https://ref.test', '--format', 'table'],
    captured.io,
    fetch
  );

  assert.match(captured.stdout, /connector_id/);
  assert.match(captured.stdout, /state/);
  assert.match(captured.stdout, /dominant_condition_reason/);
  assert.match(captured.stdout, /github/);
  assert.match(captured.stdout, /needs_attention/);
  assert.match(captured.stdout, /otp_required/);
  assert.doesNotMatch(captured.stdout, /Owner action is required before collection can continue/);
});

test('ref connectors list: handles missing axes / next_action without crashing', async () => {
  const minimal = {
    connection_id: 'spotify',
    connector_id: 'spotify',
    display_name: 'Spotify',
    connection_health: {
      state: 'unknown',
      axes: {},
      badges: {},
      unknown_reasons: ['no_runs'],
      next_action: null,
    },
    next_action: null,
    last_run: null,
    last_successful_run: null,
    schedule: null,
  };
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors': { body: { object: 'list', data: [minimal] } },
  });

  const captured = capture();
  await runRefConnectors(
    ['list', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  const row = JSON.parse(captured.stdout).data[0];
  assert.equal(row.state, 'unknown');
  assert.equal(row.coverage, 'unknown');
  assert.equal(row.freshness, 'unknown');
  assert.equal(row.attention, 'none');
  assert.equal(row.outbox, 'unknown');
  assert.equal(row.dominant_condition_id, null);
  assert.equal(row.dominant_condition_reason, null);
  assert.deepEqual(row.supporting_condition_ids, []);
  assert.equal(row.next_action_source, 'none');
  assert.equal(row.next_action_target, null);
  assert.deepEqual(row.unknown_reasons, ['no_runs']);
});

// ---- show -------------------------------------------------------------------

test('ref connectors show: returns projected row for connector id', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors/github': { body: SUMMARY_FIXTURE },
  });

  const captured = capture();
  const code = await runRefConnectors(
    ['show', 'github', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.connector_id, 'github');
  assert.equal(parsed.state, 'needs_attention');
  assert.equal(parsed.dominant_condition_reason, 'otp_required');
  assert.equal(parsed.next_action_source, 'structured');
});

test('ref connectors show: --verbose returns raw envelope', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors/github': { body: SUMMARY_FIXTURE },
  });

  const captured = capture();
  await runRefConnectors(
    ['show', 'github', '--as-url', 'https://ref.test', '--format', 'json', '--verbose'],
    captured.io,
    fetch
  );

  const parsed = JSON.parse(captured.stdout);
  assert.deepEqual(parsed, SUMMARY_FIXTURE);
});

test('ref connectors show: percent-encodes connector id', async () => {
  let capturedUrl = null;
  const fetch = async (url) => {
    capturedUrl = url.toString();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(SUMMARY_FIXTURE),
      headers: { get: () => null },
    };
  };

  const { io } = capture();
  await runRefConnectors(
    ['show', 'foo/bar baz', '--as-url', 'https://ref.test', '--format', 'json'],
    io,
    fetch
  );

  assert.equal(capturedUrl, 'https://ref.test/_ref/connectors/foo%2Fbar%20baz');
});

test('ref connectors show: omits action_target when server has redacted secret', async () => {
  const redacted = {
    ...SUMMARY_FIXTURE,
    next_action: { ...SUMMARY_FIXTURE.next_action, action_target: null },
    connection_health: {
      ...SUMMARY_FIXTURE.connection_health,
      next_action: { ...SUMMARY_FIXTURE.connection_health.next_action, action_target: null },
    },
  };
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors/github': { body: redacted },
  });

  const captured = capture();
  await runRefConnectors(
    ['show', 'github', '--as-url', 'https://ref.test', '--format', 'json'],
    captured.io,
    fetch
  );

  const parsed = JSON.parse(captured.stdout);
  assert.equal(parsed.next_action_source, 'structured');
  assert.equal(parsed.next_action_target, null);
});

test('ref connectors show: throws PdppUsageError when missing connector id', async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefConnectors(['show', '--as-url', 'https://ref.test'], io, mockFetch({})),
    (err) => err instanceof PdppUsageError && /connector-id/.test(err.message)
  );
});

test('ref connectors: throws PdppUsageError for unknown subcommand', async () => {
  const { io } = capture();
  await assert.rejects(
    () => runRefConnectors(['blah', '--as-url', 'https://ref.test'], io, mockFetch({})),
    (err) => err instanceof PdppUsageError
  );
});

test('ref connectors show: maps 404 to PdppHttpError exit code 5', async () => {
  const fetch = mockFetch({
    'https://ref.test/_ref/connectors/missing': {
      body: { error_description: 'not found' },
      status: 404,
    },
  });

  const { io } = capture();
  await assert.rejects(
    () => runRefConnectors(['show', 'missing', '--as-url', 'https://ref.test'], io, fetch),
    (err) => err instanceof PdppHttpError && err.exitCode === 5 && err.status === 404
  );
});

// ---- routing via runCli -----------------------------------------------------

test('runCli ref connectors list routes to handler', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({
    'https://ref.test/_ref/connectors': { body: { object: 'list', data: [] } },
  });

  try {
    const captured = capture();
    const code = await runCli(
      ['ref', 'connectors', 'list', '--as-url', 'https://ref.test', '--format', 'json'],
      captured.io
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(captured.stdout), { object: 'list', data: [] });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('runCli ref --help mentions connectors commands', async () => {
  const captured = capture();
  const code = await runCli(['ref', '--help'], captured.io);
  assert.equal(code, 0);
  assert.match(captured.stdout, /ref connectors list/);
  assert.match(captured.stdout, /ref connectors show/);
});
