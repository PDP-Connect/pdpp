import assert from 'node:assert/strict';
import test from 'node:test';

import { decideBackoffDispatch } from '../runtime/scheduler/dispatch-governor.ts';

test('decideBackoffDispatch honors a persisted gave_up marker while preserving blocked suppression', (t) => {
  t.diagnostic('BASELINE: authored test active');

  assert.deepEqual(
    decideBackoffDispatch({
      announcedBackoff: 'source_pressure',
      announcedBlocked: undefined,
      backoffApplied: true,
      blocked: true,
      eligible: true,
      persistedBackoffStarted: false,
      persistedGaveUp: true,
      reasonClass: 'source_pressure',
      recoveryOnly: true,
    }),
    {
      eligible: false,
      recoveryOnly: false,
      announcedBackoffMutation: 'set',
      announcedBlockedMutation: 'set',
      transitions: [],
    }
  );
});
