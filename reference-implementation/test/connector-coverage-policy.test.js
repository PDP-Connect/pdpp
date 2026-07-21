// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveStreamCoverageCondition } from '../server/connector-coverage-policy.ts';

function fact(overrides = {}) {
  return {
    checkpoint: 'committed',
    collected: 5,
    considered: 100,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    stream: 'repositories',
    ...overrides,
  };
}

test('checkpoint-window streams treat collected as changed-record count, not coverage numerator', () => {
  assert.equal(
    deriveStreamCoverageCondition(fact(), {
      coverage_strategy: 'checkpoint_window',
      freshness_strategy: 'scheduled_window',
    }),
    'complete',
  );
});

test('checkpoint-window streams remain partial until the boundary checkpoint is committed', () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ checkpoint: 'pending' }), {
      coverage_strategy: 'checkpoint_window',
      freshness_strategy: 'scheduled_window',
    }),
    'partial',
  );
});

test('parent-detail accounting still requires an accounted-for covered count', () => {
  assert.equal(
    deriveStreamCoverageCondition(fact(), {
      coverage_strategy: 'parent_detail_accounting',
      freshness_strategy: 'scheduled_window',
    }),
    'partial',
  );

  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 0, considered: 1, covered: 1 }), {
      coverage_strategy: 'parent_detail_accounting',
      freshness_strategy: 'scheduled_window',
    }),
    'complete',
  );

  assert.equal(
    deriveStreamCoverageCondition(fact({ covered: 100 }), {
      coverage_strategy: 'parent_detail_accounting',
      freshness_strategy: 'scheduled_window',
    }),
    'complete',
  );
});

test('pending detail gaps outrank checkpoint strategy proof', () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ pending_detail_gaps: 1 }), {
      coverage_strategy: 'checkpoint_window',
      freshness_strategy: 'scheduled_window',
    }),
    'retryable_gap',
  );
});

test('skip facts outrank checkpoint strategy proof', () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        skipped: {
          reason: 'rate_limited',
          recovery_action: 'retry_by_runtime',
        },
      }),
      {
        coverage_strategy: 'checkpoint_window',
        freshness_strategy: 'scheduled_window',
      },
    ),
    'retryable_gap',
  );
});
