/**
 * Operation-level behavior tests for `ref.spine.correlations.list`.
 *
 * Pins:
 *   - the per-kind `trace_summary` / `grant_summary` / `run_summary`
 *     discriminator;
 *   - the `{object: 'list', data, has_more}` envelope shape;
 *   - the optional `next_cursor` (present iff the dependency exposes
 *     one);
 *   - the per-kind field projection from the underlying spine summary.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefSpineCorrelationsList } from '../operations/ref-spine-correlations-list/index.ts';

function makeSummary(overrides = {}) {
  return {
    id: 'corr_1',
    first_at: '2026-04-01T00:00:00Z',
    last_at: '2026-04-01T00:01:00Z',
    event_count: 3,
    status: 'succeeded',
    kinds: ['oauth', 'token'],
    request_id: 'req_1',
    grant_id: 'grant_1',
    run_id: 'run_1',
    client_id: 'client_x',
    provider_id: 'pdpp_reference',
    connector_id: 'conn_x',
    actor_type: 'system',
    actor_id: 'pdpp_reference',
    failure: null,
    needs_input: false,
    ...overrides,
  };
}

test('ref.spine.correlations.list emits trace_summary discriminator', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'trace', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [makeSummary({ id: 'trc_1' })],
        hasMore: false,
        nextCursor: null,
      }),
    },
  );
  assert.equal(envelope.object, 'list');
  assert.equal(envelope.has_more, false);
  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].object, 'trace_summary');
  assert.equal(envelope.data[0].trace_id, 'trc_1');
  assert.equal(envelope.data[0].request_id, 'req_1');
  assert.equal(envelope.data[0].actor_type, 'system');
});

test('ref.spine.correlations.list emits grant_summary discriminator with source fallback', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'grant', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [
          makeSummary({ id: 'grt_1', connector_id: '' }),
        ],
        hasMore: false,
        nextCursor: null,
      }),
    },
  );
  const entry = envelope.data[0];
  assert.equal(entry.object, 'grant_summary');
  assert.equal(entry.grant_id, 'grt_1');
  assert.deepEqual(entry.source, null);
  assert.equal('actor_type' in entry, false);
});

test('ref.spine.correlations.list emits run_summary discriminator with failure_reason and needs_input', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'run', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [
          makeSummary({
            id: 'run_1',
            needs_input: true,
            failure: { event_type: 'run.failed', reason: 'auth_denied' },
          }),
        ],
        hasMore: false,
        nextCursor: null,
      }),
    },
  );
  const entry = envelope.data[0];
  assert.equal(entry.object, 'run_summary');
  assert.equal(entry.run_id, 'run_1');
  assert.equal(entry.needs_input, true);
  assert.equal(entry.failure_reason, 'auth_denied');
});

test('ref.spine.correlations.list projects browser-profile connection identity and surface failure reason', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'run', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [
          makeSummary({
            id: 'run_browser_surface_failed',
            browser_surface_profile_key: 'chase:cin_expired_setup',
            browser_surface_status: 'surface_failed',
            browser_surface_wait_reason: 'surface_unhealthy',
            failure: null,
            status: 'surface_failed',
          }),
        ],
        hasMore: false,
        nextCursor: null,
      }),
    },
  );
  const entry = envelope.data[0];
  assert.equal(entry.object, 'run_summary');
  assert.equal(entry.connection_id, 'cin_expired_setup');
  assert.equal(entry.connector_instance_id, 'cin_expired_setup');
  assert.equal(entry.browser_surface_profile_key, 'chase:cin_expired_setup');
  assert.equal(entry.failure_reason, 'surface_unhealthy');
});

test('ref.spine.correlations.list does not invent connection identity from non-connection browser profiles', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'run', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [
          makeSummary({
            id: 'run_managed_profile',
            browser_surface_profile_key: 'managed-profile',
            browser_surface_status: 'leased',
          }),
        ],
        hasMore: false,
        nextCursor: null,
      }),
    },
  );
  const entry = envelope.data[0];
  assert.equal(entry.object, 'run_summary');
  assert.equal('connection_id' in entry, false);
  assert.equal('connector_instance_id' in entry, false);
});

test('ref.spine.correlations.list omits next_cursor when the page does not expose one', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'trace', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [],
        hasMore: false,
        nextCursor: null,
      }),
    },
  );
  assert.equal('next_cursor' in envelope, false);
});

test('ref.spine.correlations.list emits next_cursor when the page exposes one', async () => {
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'trace', filters: {} },
    {
      listSpineCorrelations: () => ({
        summaries: [makeSummary()],
        hasMore: true,
        nextCursor: 'opaque_cursor_value',
      }),
    },
  );
  assert.equal(envelope.has_more, true);
  assert.equal(envelope.next_cursor, 'opaque_cursor_value');
});

test('ref.spine.correlations.list forwards the kind and filter bag to the dependency unchanged', async () => {
  let received = null;
  const filters = Object.freeze({ status: 'failed', q: 'abc' });
  await executeRefSpineCorrelationsList(
    { kind: 'grant', filters },
    {
      listSpineCorrelations: (kind, filterArg) => {
        received = { kind, filterArg };
        return { summaries: [], hasMore: false, nextCursor: null };
      },
    },
  );
  assert.equal(received.kind, 'grant');
  assert.equal(received.filterArg, filters);
});

test('ref.spine.correlations.list awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefSpineCorrelationsList(
    { kind: 'run', filters: {} },
    {
      listSpineCorrelations: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve({ summaries: [makeSummary({ id: 'run_async' })], hasMore: false, nextCursor: null });
          }),
        ),
    },
  );
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
});
