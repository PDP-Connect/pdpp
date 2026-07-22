// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapSearchFanout,
  resolveSearchFanoutConcurrency,
} from '../server/search-fanout.ts';

test('search fanout is unbounded for non-Postgres unless configured', () => {
  assert.equal(
    resolveSearchFanoutConcurrency({ isPostgres: false, env: {} }),
    Number.POSITIVE_INFINITY,
  );
});

test('search fanout defaults to a bounded Postgres concurrency', () => {
  assert.equal(resolveSearchFanoutConcurrency({ isPostgres: true, env: {} }), 8);
});

test('search fanout honors explicit positive concurrency', () => {
  assert.equal(
    resolveSearchFanoutConcurrency({
      isPostgres: true,
      env: { PDPP_RS_SEARCH_FANOUT_CONCURRENCY: '2' },
    }),
    2,
  );
});

test('search fanout preserves result order while bounding active work', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapSearchFanout(
    [3, 1, 2, 0],
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value * 5));
      active -= 1;
      return value * 10;
    },
    {
      isPostgres: true,
      env: { PDPP_RS_SEARCH_FANOUT_CONCURRENCY: '2' },
    },
  );
  assert.deepEqual(results, [30, 10, 20, 0]);
  assert.equal(maxActive, 2);
});
