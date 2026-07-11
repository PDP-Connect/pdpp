import assert from 'node:assert/strict';
import test from 'node:test';

import { decideBackoffDispatch } from '../runtime/scheduler/dispatch-governor.ts';

test('decideBackoffDispatch emits ordered first blocked tick transitions while suppressing dispatch', (t) => {
  t.diagnostic('BASELINE: authored test active');

  assert.deepEqual(
    decideBackoffDispatch({
      announcedBackoff: undefined,
      announcedBlocked: undefined,
      backoffApplied: true,
      blocked: true,
      eligible: true,
      persistedBackoffStarted: false,
      persistedGaveUp: false,
      reasonClass: 'source_pressure',
      recoveryOnly: true,
    }),
    {
      eligible: false,
      recoveryOnly: false,
      announcedBackoffMutation: 'set',
      announcedBlockedMutation: 'set',
      transitions: [{ kind: 'backoff_started' }, { kind: 'gave_up' }],
    }
  );
});
