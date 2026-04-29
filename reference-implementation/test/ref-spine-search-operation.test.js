/**
 * Operation-level behavior tests for `ref.spine.search`.
 *
 * Pins:
 *   - the `{object: 'search_result', exact, traces, grants, runs}`
 *     envelope shape;
 *   - the per-bucket summary discriminators projected onto each entry.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefSpineSearch } from '../operations/ref-spine-search/index.ts';

function summary(idPrefix) {
  return {
    id: idPrefix,
    first_at: '2026-04-01T00:00:00Z',
    last_at: '2026-04-01T00:01:00Z',
    event_count: 1,
    status: 'succeeded',
    kinds: ['oauth'],
    request_id: null,
    grant_id: null,
    run_id: null,
    client_id: null,
    provider_id: null,
    connector_id: null,
    actor_type: 'system',
    actor_id: 'pdpp_reference',
    failure: null,
    needs_input: false,
  };
}

test('ref.spine.search emits {object: search_result} envelope with per-kind discriminators', async () => {
  const envelope = await executeRefSpineSearch(
    { query: 'q' },
    {
      searchSpine: () => ({
        exact: { kind: 'trace', id: 'trc_x' },
        traces: [summary('trc_a')],
        grants: [summary('grt_a')],
        runs: [summary('run_a')],
      }),
    },
  );
  assert.equal(envelope.object, 'search_result');
  assert.deepEqual(envelope.exact, { kind: 'trace', id: 'trc_x' });
  assert.equal(envelope.traces[0].object, 'trace_summary');
  assert.equal(envelope.traces[0].trace_id, 'trc_a');
  assert.equal(envelope.grants[0].object, 'grant_summary');
  assert.equal(envelope.grants[0].grant_id, 'grt_a');
  assert.equal(envelope.runs[0].object, 'run_summary');
  assert.equal(envelope.runs[0].run_id, 'run_a');
});

test('ref.spine.search emits empty result when search returns no hits', async () => {
  const envelope = await executeRefSpineSearch(
    { query: '' },
    {
      searchSpine: () => ({ exact: null, traces: [], grants: [], runs: [] }),
    },
  );
  assert.equal(envelope.exact, null);
  assert.deepEqual(envelope.traces, []);
  assert.deepEqual(envelope.grants, []);
  assert.deepEqual(envelope.runs, []);
});

test('ref.spine.search forwards the query string to the dependency unchanged', async () => {
  let received = null;
  await executeRefSpineSearch(
    { query: '  some-query  ' },
    {
      searchSpine: (query) => {
        received = query;
        return { exact: null, traces: [], grants: [], runs: [] };
      },
    },
  );
  assert.equal(received, '  some-query  ');
});

test('ref.spine.search awaits dependency promises', async () => {
  let resolved = false;
  await executeRefSpineSearch(
    { query: 'q' },
    {
      searchSpine: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve({ exact: null, traces: [], grants: [], runs: [] });
          }),
        ),
    },
  );
  assert.equal(resolved, true);
});
