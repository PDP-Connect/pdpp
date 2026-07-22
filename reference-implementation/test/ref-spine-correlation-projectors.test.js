// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the three UNTESTED per-kind correlation-summary
 * projectors exported by `operations/ref-spine-correlations-list/index.ts`:
 * `summaryToTrace`, `summaryToGrant`, `summaryToRun`.
 *
 * These map a single spine correlation summary into the discriminated
 * operator-console read-model shapes behind `GET /_ref/traces`,
 * `GET /_ref/grants`, and `GET /_ref/runs`. The behaviors pinned here:
 *
 *   - `id` is projected onto the kind-specific primary key
 *     (`trace_id` / `grant_id` / `run_id`);
 *   - each carries its own `object` discriminator;
 *   - `client` is included ONLY when present; `grant_package_id` only on grant
 *     and only when present; browser-surface fields only on run and only when
 *     present (no falsy-value holes);
 *   - `source` derivation fallback: explicit `source` → `{source_kind,
 *     source_id}` → `{kind:"connector", id:connector_id}` → null;
 *   - run connection identity fallback: `connection_id` →
 *     `connector_instance_id` → the `cin_`-suffixed browser-surface profile key;
 *     when resolved it is emitted as BOTH `connection_id` and
 *     `connector_instance_id`;
 *   - run failure reason: `failure.reason` → (status==="surface_failed")
 *     surface-wait/status/"browser_surface_failed" → null.
 *
 * The module is pure (no imports). No DB, no server. The operation-level
 * `ref-spine-*` tests exercise the envelope, not these field maps by name.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  summaryToTrace,
  summaryToGrant,
  summaryToRun,
} from '../operations/ref-spine-correlations-list/index.ts';

// A maximal summary; individual tests override only the fields they probe.
function baseSummary(overrides = {}) {
  return {
    id: 'id-1',
    first_at: '2026-07-01T00:00:00.000Z',
    last_at: '2026-07-01T01:00:00.000Z',
    event_count: 3,
    status: 'succeeded',
    kinds: ['run.started', 'run.succeeded'],
    request_id: 'req-1',
    grant_id: 'grant-1',
    run_id: 'run-1',
    client_id: 'client-1',
    client: null,
    connector_id: 'connector-1',
    source: null,
    source_id: null,
    source_kind: null,
    actor_type: 'owner',
    actor_id: 'owner-1',
    failure: null,
    needs_input: false,
    ...overrides,
  };
}

// --- summaryToTrace ---------------------------------------------------------

test('summaryToTrace: projects id onto trace_id with the trace_summary discriminator', () => {
  const out = summaryToTrace(baseSummary({ id: 'trace-xyz' }));
  assert.equal(out.object, 'trace_summary');
  assert.equal(out.trace_id, 'trace-xyz', `trace_id: ${out.trace_id}`);
  // Carries the correlation ids straight through.
  assert.equal(out.request_id, 'req-1');
  assert.equal(out.grant_id, 'grant-1');
  assert.equal(out.run_id, 'run-1');
  assert.equal(out.client_id, 'client-1');
  assert.equal(out.actor_type, 'owner');
  assert.equal(out.actor_id, 'owner-1');
});

test('summaryToTrace: omits client when null, includes it when present', () => {
  const withoutClient = summaryToTrace(baseSummary({ client: null }));
  assert.equal('client' in withoutClient, false, 'client must be absent when null');

  const client = { client_id: 'client-1', client_name: 'Acme', registration_mode: 'dynamic' };
  const withClient = summaryToTrace(baseSummary({ client }));
  assert.deepEqual(withClient.client, client, 'client passed through when present');
});

test('summaryToTrace: source derived from connector_id when no explicit source/source_kind', () => {
  const out = summaryToTrace(baseSummary({ source: null, source_id: null, source_kind: null, connector_id: 'connector-9' }));
  assert.deepEqual(out.source, { kind: 'connector', id: 'connector-9' }, `source: ${JSON.stringify(out.source)}`);
});

// --- summaryToGrant ---------------------------------------------------------

test('summaryToGrant: projects id onto grant_id with the grant_summary discriminator', () => {
  const out = summaryToGrant(baseSummary({ id: 'grant-abc' }));
  assert.equal(out.object, 'grant_summary');
  assert.equal(out.grant_id, 'grant-abc', `grant_id: ${out.grant_id}`);
  // Grant summary does NOT carry run_id / request_id / actor fields.
  assert.equal('run_id' in out, false, 'grant summary must not expose run_id');
  assert.equal('request_id' in out, false, 'grant summary must not expose request_id');
  assert.equal('actor_type' in out, false, 'grant summary must not expose actor_type');
});

test('summaryToGrant: grant_package_id included only when present', () => {
  const without = summaryToGrant(baseSummary({ grant_package_id: undefined }));
  assert.equal('grant_package_id' in without, false, 'absent when undefined');

  const withPkg = summaryToGrant(baseSummary({ grant_package_id: 'pkg-77' }));
  assert.equal(withPkg.grant_package_id, 'pkg-77', 'included when present');
});

test('summaryToGrant: explicit source object wins over connector_id fallback', () => {
  const out = summaryToGrant(
    baseSummary({ source: { kind: 'provider_native', id: 'prov-1' }, connector_id: 'connector-1' }),
  );
  assert.deepEqual(out.source, { kind: 'provider_native', id: 'prov-1' }, `source: ${JSON.stringify(out.source)}`);
});

test('summaryToGrant: source built from source_kind+source_id when no explicit source', () => {
  const out = summaryToGrant(
    baseSummary({ source: null, source_kind: 'connector', source_id: 'src-42', connector_id: 'connector-1' }),
  );
  assert.deepEqual(out.source, { kind: 'connector', id: 'src-42' }, `source: ${JSON.stringify(out.source)}`);
});

test('summaryToGrant: source is null when no source, no kind/id pair, and no connector_id', () => {
  const out = summaryToGrant(
    baseSummary({ source: null, source_kind: null, source_id: null, connector_id: null }),
  );
  assert.equal(out.source, null, `source: ${JSON.stringify(out.source)}`);
});

// --- summaryToRun -----------------------------------------------------------

test('summaryToRun: projects id onto run_id with the run_summary discriminator and needs_input coercion', () => {
  const out = summaryToRun(baseSummary({ id: 'run-xyz', needs_input: 1 }));
  assert.equal(out.object, 'run_summary');
  assert.equal(out.run_id, 'run-xyz', `run_id: ${out.run_id}`);
  assert.strictEqual(out.needs_input, true, 'needs_input must be Boolean-coerced');
  assert.equal(out.connector_id, 'connector-1');
  assert.equal(out.grant_id, 'grant-1');
});

test('summaryToRun: connection_id present => emitted as BOTH connection_id and connector_instance_id', () => {
  const out = summaryToRun(baseSummary({ connection_id: 'cin_direct', connector_instance_id: 'cin_other' }));
  assert.equal(out.connection_id, 'cin_direct', 'connection_id wins the identity resolution');
  assert.equal(out.connector_instance_id, 'cin_direct', 'connector_instance_id mirrors the resolved identity');
});

test('summaryToRun: falls back to connector_instance_id when connection_id is absent', () => {
  const out = summaryToRun(baseSummary({ connection_id: null, connector_instance_id: 'cin_fallback' }));
  assert.equal(out.connection_id, 'cin_fallback');
  assert.equal(out.connector_instance_id, 'cin_fallback');
});

test('summaryToRun: resolves connection identity from a cin_-suffixed browser_surface_profile_key', () => {
  const out = summaryToRun(
    baseSummary({
      connection_id: null,
      connector_instance_id: null,
      browser_surface_profile_key: 'neko:pool-a:cin_fromkey',
    }),
  );
  assert.equal(out.connection_id, 'cin_fromkey', 'identity extracted from the profile-key suffix');
  assert.equal(out.connector_instance_id, 'cin_fromkey');
  // The profile key itself is also echoed as a browser-surface field.
  assert.equal(out.browser_surface_profile_key, 'neko:pool-a:cin_fromkey');
});

test('summaryToRun: no resolvable connection identity => both keys omitted (no null holes)', () => {
  const out = summaryToRun(
    baseSummary({
      connection_id: null,
      connector_instance_id: null,
      // profile-key suffix does not start with cin_ => not an identity.
      browser_surface_profile_key: 'neko:pool-a:sess_123',
    }),
  );
  assert.equal('connection_id' in out, false, 'connection_id omitted when unresolved');
  assert.equal('connector_instance_id' in out, false, 'connector_instance_id omitted when unresolved');
});

test('summaryToRun: failure_reason taken from failure.reason when present', () => {
  const out = summaryToRun(
    baseSummary({ failure: { event_type: 'run.failed', reason: 'auth_expired' }, status: 'failed' }),
  );
  assert.equal(out.failure_reason, 'auth_expired', `failure_reason: ${out.failure_reason}`);
});

test('summaryToRun: surface_failed derives failure_reason from wait reason when no failure object', () => {
  const out = summaryToRun(
    baseSummary({
      failure: null,
      status: 'surface_failed',
      browser_surface_wait_reason: 'surface_timeout',
      browser_surface_status: 'lost',
    }),
  );
  assert.equal(out.failure_reason, 'surface_timeout', 'wait reason wins for surface_failed');
});

test('summaryToRun: surface_failed with no wait reason falls back to surface status then default', () => {
  const fromStatus = summaryToRun(
    baseSummary({ failure: null, status: 'surface_failed', browser_surface_wait_reason: undefined, browser_surface_status: 'evicted' }),
  );
  assert.equal(fromStatus.failure_reason, 'evicted', 'surface status used when wait reason absent');

  const fromDefault = summaryToRun(
    baseSummary({ failure: null, status: 'surface_failed', browser_surface_wait_reason: undefined, browser_surface_status: undefined }),
  );
  assert.equal(fromDefault.failure_reason, 'browser_surface_failed', 'default sentinel when nothing else present');
});

test('summaryToRun: non-failed status with no failure object => failure_reason null', () => {
  const out = summaryToRun(baseSummary({ failure: null, status: 'succeeded' }));
  assert.equal(out.failure_reason, null, `failure_reason: ${out.failure_reason}`);
});

test('summaryToRun: browser-surface fields included only when present', () => {
  const bare = summaryToRun(
    baseSummary({
      browser_surface_status: undefined,
      browser_surface_wait_reason: undefined,
      browser_surface_lease_id: undefined,
      browser_surface_profile_key: undefined,
    }),
  );
  assert.equal('browser_surface_status' in bare, false);
  assert.equal('browser_surface_wait_reason' in bare, false);
  assert.equal('browser_surface_lease_id' in bare, false);
  assert.equal('browser_surface_profile_key' in bare, false);

  const full = summaryToRun(
    baseSummary({
      browser_surface_status: 'live',
      browser_surface_wait_reason: 'waiting_otp',
      browser_surface_lease_id: 'lease-1',
      browser_surface_profile_key: 'neko:p:cin_x',
    }),
  );
  assert.equal(full.browser_surface_status, 'live');
  assert.equal(full.browser_surface_wait_reason, 'waiting_otp');
  assert.equal(full.browser_surface_lease_id, 'lease-1');
  assert.equal(full.browser_surface_profile_key, 'neko:p:cin_x');
});
