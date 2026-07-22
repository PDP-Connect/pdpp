// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the per-kind spine-correlation projectors in
// operations/ref-spine-correlations-list/index.ts. No test imports these by name.
// They project a raw spine summary into the operator-console trace/grant/run
// discriminated entry; the source-fallback chain, run connection-identity
// derivation, and surface-failure reason fallback are the mutation surface.
//
// Mutation surface:
//   summaryToTrace -- object='trace_summary', trace_id<-id, client only when
//     present, source via source>source_kind/id>connector_id fallback.
//   summaryToGrant -- object='grant_summary', grant_id<-id, grant_package_id only
//     when present.
//   summaryToRun -- object='run_summary', connection_id/connector_instance_id via
//     connection_id>connector_instance_id>profile_key(cin_ suffix); failure_reason
//     via failure.reason>surface_failed-fallback; needs_input coerced to boolean;
//     browser_surface_* only when present.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  summaryToGrant,
  summaryToRun,
  summaryToTrace,
} from '../operations/ref-spine-correlations-list/index.ts';

function baseSummary(overrides = {}) {
  return {
    id: 'corr-1',
    first_at: '2024-01-01T00:00:00Z',
    last_at: '2024-01-02T00:00:00Z',
    event_count: 5,
    status: 'succeeded',
    kinds: ['run.started', 'run.succeeded'],
    request_id: 'req-1',
    grant_id: 'grant-1',
    run_id: 'run-1',
    client_id: 'client-1',
    connector_id: 'amazon',
    source: null,
    source_id: null,
    source_kind: null,
    actor_type: 'runtime',
    actor_id: 'act-1',
    failure: null,
    needs_input: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// summaryToTrace
// ---------------------------------------------------------------------------

test('summaryToTrace: discriminator + trace_id from id + core fields', () => {
  const out = summaryToTrace(baseSummary());
  assert.equal(out.object, 'trace_summary');
  assert.equal(out.trace_id, 'corr-1', 'trace_id sourced from summary id');
  assert.equal(out.grant_id, 'grant-1');
  assert.equal(out.actor_id, 'act-1');
});

test('summaryToTrace: client is attached only when present', () => {
  assert.ok(!('client' in summaryToTrace(baseSummary())), 'no client key when absent');
  const withClient = summaryToTrace(baseSummary({ client: { client_id: 'c', client_name: 'C', registration_mode: 'dynamic' } }));
  assert.deepEqual(withClient.client, { client_id: 'c', client_name: 'C', registration_mode: 'dynamic' });
});

test('summaryToTrace: source fallback prefers explicit source, then source_kind/id, then connector_id', () => {
  assert.deepEqual(
    summaryToTrace(baseSummary({ source: { kind: 'provider_native', id: 'gmail' } })).source,
    { kind: 'provider_native', id: 'gmail' },
    'explicit source wins',
  );
  assert.deepEqual(
    summaryToTrace(baseSummary({ source: null, source_kind: 'connector', source_id: 'spotify' })).source,
    { kind: 'connector', id: 'spotify' },
    'source_kind/id used next',
  );
  assert.deepEqual(
    summaryToTrace(baseSummary({ source: null, source_kind: null, source_id: null, connector_id: 'amazon' })).source,
    { kind: 'connector', id: 'amazon' },
    'connector_id is the final fallback',
  );
  assert.equal(
    summaryToTrace(baseSummary({ source: null, source_kind: null, source_id: null, connector_id: null })).source,
    null,
    'no source signal -> null',
  );
});

// ---------------------------------------------------------------------------
// summaryToGrant
// ---------------------------------------------------------------------------

test('summaryToGrant: discriminator + grant_id from id, grant_package_id only when present', () => {
  const out = summaryToGrant(baseSummary());
  assert.equal(out.object, 'grant_summary');
  assert.equal(out.grant_id, 'corr-1');
  assert.ok(!('grant_package_id' in out), 'omitted when absent');

  const withPkg = summaryToGrant(baseSummary({ grant_package_id: 'pkg-9' }));
  assert.equal(withPkg.grant_package_id, 'pkg-9');
});

// ---------------------------------------------------------------------------
// summaryToRun
// ---------------------------------------------------------------------------

test('summaryToRun: discriminator + run_id + needs_input coerced to a boolean', () => {
  const out = summaryToRun(baseSummary({ needs_input: 1 }));
  assert.equal(out.object, 'run_summary');
  assert.equal(out.run_id, 'corr-1');
  assert.equal(out.needs_input, true, 'truthy needs_input coerced to true');
  assert.strictEqual(summaryToRun(baseSummary({ needs_input: 0 })).needs_input, false);
});

test('summaryToRun: connection identity prefers connection_id, then connector_instance_id, then profile_key cin_ suffix', () => {
  const byConn = summaryToRun(baseSummary({ connection_id: 'cin_direct' }));
  assert.equal(byConn.connection_id, 'cin_direct');
  assert.equal(byConn.connector_instance_id, 'cin_direct', 'alias mirrors connection_id');

  const byInstance = summaryToRun(baseSummary({ connection_id: null, connector_instance_id: 'cin_inst' }));
  assert.equal(byInstance.connection_id, 'cin_inst');

  const byProfile = summaryToRun(baseSummary({
    connection_id: null,
    connector_instance_id: null,
    browser_surface_profile_key: 'amazon:cin_fromkey',
  }));
  assert.equal(byProfile.connection_id, 'cin_fromkey', 'cin_-suffixed profile key segment used');

  const none = summaryToRun(baseSummary({ connection_id: null, connector_instance_id: null }));
  assert.ok(!('connection_id' in none), 'no connection identity -> field omitted');
});

test('summaryToRun: a profile_key whose last segment is NOT cin_-prefixed yields no connection id', () => {
  const out = summaryToRun(baseSummary({
    connection_id: null,
    connector_instance_id: null,
    browser_surface_profile_key: 'amazon:notacin',
  }));
  assert.ok(!('connection_id' in out), 'non-cin_ suffix is not a connection id');
});

test('summaryToRun: failure_reason prefers failure.reason, falls back for surface_failed status', () => {
  assert.equal(
    summaryToRun(baseSummary({ failure: { event_type: 'run.failed', reason: 'boom' } })).failure_reason,
    'boom',
  );
  assert.equal(
    summaryToRun(baseSummary({ status: 'surface_failed', browser_surface_wait_reason: 'no_surface_available' })).failure_reason,
    'no_surface_available',
    'surface_failed uses the wait reason',
  );
  assert.equal(
    summaryToRun(baseSummary({ status: 'surface_failed', browser_surface_wait_reason: null, browser_surface_status: null })).failure_reason,
    'browser_surface_failed',
    'surface_failed with no detail uses the generic reason',
  );
  assert.equal(summaryToRun(baseSummary()).failure_reason, null, 'no failure + non-surface status -> null');
});

test('summaryToRun: browser_surface_* fields are attached only when present', () => {
  const plain = summaryToRun(baseSummary());
  assert.ok(!('browser_surface_status' in plain));
  assert.ok(!('browser_surface_lease_id' in plain));

  const withSurface = summaryToRun(baseSummary({
    browser_surface_status: 'leased',
    browser_surface_lease_id: 'lease-1',
  }));
  assert.equal(withSurface.browser_surface_status, 'leased');
  assert.equal(withSurface.browser_surface_lease_id, 'lease-1');
});
