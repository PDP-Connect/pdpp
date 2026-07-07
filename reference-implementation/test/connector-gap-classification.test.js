import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasTerminalKnownGap,
  isOwnerRecoverableKnownGap,
  isRetryableKnownGap,
} from '../server/connector-gap-classification.ts';

test('assistance timeout gaps are owner/session-recoverable, not maintainer-code terminal gaps', () => {
  const gap = {
    kind: 'run_failed',
    reason: 'assistance_timed_out',
    severity: 'actionable',
    recovery_hint: { action: 'unknown', retryable: false },
  };

  assert.equal(isOwnerRecoverableKnownGap(gap), true);
  assert.equal(isRetryableKnownGap(gap), true);
  assert.equal(hasTerminalKnownGap({ known_gaps: [gap] }), false);
});
