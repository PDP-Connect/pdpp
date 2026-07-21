import assert from 'node:assert/strict';
import test from 'node:test';

import { decideBackoffDispatch } from '../runtime/scheduler/dispatch-governor.ts';

function input(overrides = {}) {
  return {
    announcedBackoff: undefined,
    announcedBlocked: undefined,
    backoffApplied: true,
    blocked: false,
    eligible: true,
    persistedBackoffStarted: false,
    persistedGaveUp: false,
    reasonClass: 'source_pressure',
    recoveryOnly: true,
    ...overrides,
  };
}

test('decideBackoffDispatch returns exact backoff transition and dedup mutation decisions', (t) => {
  t.diagnostic('BASELINE: authored test active');

  const cases = [
    {
      name: 'no backoff clears announcedBackoff and preserves eligibility',
      inputs: input({
        announcedBackoff: 'source_pressure',
        backoffApplied: false,
        eligible: true,
        recoveryOnly: true,
      }),
      expected: {
        eligible: true,
        recoveryOnly: true,
        announcedBackoffMutation: 'delete',
        announcedBlockedMutation: 'keep',
        transitions: [],
      },
    },
    {
      name: 'new backoff reason emits exactly backoff_started and sets announcedBackoffMutation',
      inputs: input(),
      expected: {
        eligible: true,
        recoveryOnly: true,
        announcedBackoffMutation: 'set',
        announcedBlockedMutation: 'keep',
        transitions: [{ kind: 'backoff_started' }],
      },
    },
    {
      name: 'persisted backoff_started suppresses duplicate transition emission',
      inputs: input({ persistedBackoffStarted: true }),
      expected: {
        eligible: true,
        recoveryOnly: true,
        announcedBackoffMutation: 'set',
        announcedBlockedMutation: 'keep',
        transitions: [],
      },
    },
    {
      name: 'already-announced backoff suppresses duplicate transition emission',
      inputs: input({ announcedBackoff: 'source_pressure' }),
      expected: {
        eligible: true,
        recoveryOnly: true,
        announcedBackoffMutation: 'set',
        announcedBlockedMutation: 'keep',
        transitions: [],
      },
    },
    {
      name: 'blocked backoff emits gave_up once, sets announcedBlockedMutation, and suppresses dispatch',
      inputs: input({
        announcedBackoff: 'source_pressure',
        blocked: true,
      }),
      expected: {
        eligible: false,
        recoveryOnly: false,
        announcedBackoffMutation: 'set',
        announcedBlockedMutation: 'set',
        transitions: [{ kind: 'gave_up' }],
      },
    },
    {
      name: 'backoffApplied with no reasonClass keeps both cells and emits no transitions',
      inputs: input({ reasonClass: null }),
      expected: {
        eligible: true,
        recoveryOnly: true,
        announcedBackoffMutation: 'keep',
        announcedBlockedMutation: 'keep',
        transitions: [],
      },
    },
  ];

  for (const { name, inputs, expected } of cases) {
    assert.deepEqual(decideBackoffDispatch(inputs), expected, name);
  }
});
