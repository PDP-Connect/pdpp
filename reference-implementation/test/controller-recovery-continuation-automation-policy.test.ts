/**
 * Regression coverage for the USAA fleet-audit incident (2026-08-01):
 *
 *   A successful manual run recovered pending detail gaps, and the
 *   controller's `maybeContinueRecoveryAfterProgress` continuation
 *   immediately started a SECOND run — with no owner POST, and while the
 *   connection had no enabled schedule — because the continuation always
 *   labeled itself `triggerKind: "manual"`. That label caused it to bypass
 *   `policyBlocksScheduledRuns` (the exact check that exists specifically to
 *   honor a manifest's `background_safe: false` / `recommended_mode: "manual"`
 *   declaration), so a connector that says "requires interactive login, refresh
 *   manually so the owner is present" got a second, unattended, OTP-gated run
 *   anyway. That second run needed another OTP, timed out, and became the
 *   connection's last-run failure.
 *
 * The fix: `maybeContinueRecoveryAfterProgress` now checks
 * `automaticIneligibilityReason` against the connector's manifest refresh
 * policy — the same connector-neutral check every other automatic dispatch
 * path already honors — before starting the continuation. It does not touch
 * `triggerKind`, the scheduler, or the recovery-admission logic that decides
 * *whether recoverable work exists*; it only decides whether it is safe to
 * start that work without the owner present.
 *
 * `runConnectorImpl` is injected (rather than spawning a real connector
 * child) so each call's result is controlled directly — the real wire
 * protocol's `detail_gaps` reporting is exercised elsewhere; this test is
 * scoped to the controller's own continuation-gating decision.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeDb, initDb } from '../server/db.ts';
import { __resetControllerInteractionStateForTests, createController } from '../runtime/controller.ts';
import type { RuntimeRunConnectorResult } from '../runtime/index.ts';

const CONNECTOR_ID = 'test/recovery-continuation';

// Fake detail-gap store with one pending non-pressure-recoverable gap
// (`retry_exhausted`, no cooldown floor) so `hasEligibleNonPressureRecoveryWork`
// is true and the continuation attempt is actually reached.
function fakeDetailGapStoreWithRecoverableGap(connectorId: string) {
  const row = {
    connector_id: connectorId,
    connector_instance_id: connectorId,
    reason: 'retry_exhausted',
    attempt_count: 1,
    next_attempt_after: null,
  };
  return {
    listPendingGapsForConnector: () => [row],
    listPendingGapsForConnectorInstance: () => [row],
  };
}

function manifestWith(refreshPolicy: object) {
  return {
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    streams: [{ name: 'items', fields: [] }],
    capabilities: { refresh_policy: refreshPolicy },
  };
}

const USAA_LIKE_REFRESH_POLICY = {
  recommended_mode: 'manual',
  interaction_posture: 'manual_action_likely',
  background_safe: false,
  rationale: 'Requires interactive login and short sessions; refresh manually so the owner is present.',
};

const BACKGROUND_SAFE_REFRESH_POLICY = {
  recommended_mode: 'automatic',
  interaction_posture: 'none',
  background_safe: true,
};

function fakeAdmitRunConnection() {
  return ({ connectorId, connectorInstanceId }: { connectorId: string; connectorInstanceId: string | null }) => {
    const exactId = connectorInstanceId ?? connectorId;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId: 'owner_local' });
  };
}

function freshDb(t: any) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), 'pdpp-recovery-continuation-db-')), 'pdpp.sqlite'));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

// A `runConnectorImpl` stub that reports one recovered detail gap on every
// call (simulating a run that made durable recovery progress, the condition
// `maybeContinueRecoveryAfterProgress` requires before it will even consider
// a continuation) and records each call so the test can assert how many runs
// actually happened.
function fakeRunConnectorImplReportingRecoveredGap(calls: any[]) {
  return (opts: any): Promise<RuntimeRunConnectorResult> => {
    calls.push(opts);
    return Promise.resolve({
      status: 'succeeded',
      records_emitted: 0,
      detail_gaps: [{ gap_id: `gap_${calls.length}`, stream: 'items', status: 'recovered', reason: null }],
    });
  };
}

async function withRecoveringController(t: any, fn: any) {
  freshDb(t);
  const calls: any[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => '/tmp/unused-connector-path.mjs',
    runConnectorImpl: fakeRunConnectorImplReportingRecoveredGap(calls),
    detailGapStore: fakeDetailGapStoreWithRecoverableGap(CONNECTOR_ID),
    logger: { error: () => {}, warn: () => {} },
  });
  try {
    await fn(controller, calls);
  } finally {
    await controller.drainActiveRuns(2000).catch(() => {});
  }
}

// The continuation fires from the `.finally()` of the FIRST run's own promise
// chain (see controller.ts `maybeContinueRecoveryAfterProgress` / `runNow`'s
// `.finally()` wiring), so it is not observable synchronously after `runNow`
// resolves (`runNow` returns as soon as the run is admitted, not when it
// settles). Poll briefly for the call count to stabilize instead of
// asserting immediately.
async function waitForCallCountToSettle(calls: any[], { quietMs = 200, timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = calls.length;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (calls.length !== lastCount) {
      lastCount = calls.length;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return lastCount;
    }
  }
  return lastCount;
}

test('manual-only connector: successful manual run does NOT auto-launch a hidden recovery continuation', async (t) => {
  await withRecoveringController(t, async (controller: any, calls: any[]) => {
    const result = await controller.runNow(CONNECTOR_ID, {
      manifest: manifestWith(USAA_LIKE_REFRESH_POLICY),
      ownerToken: 'owner-token',
    });
    assert.equal(result.status, 'started');

    // This is exactly the live incident: the manual run succeeds and
    // recovers a detail gap, then — with no owner POST and no enabled
    // schedule — the runtime must NOT spawn a second connector run to
    // "continue" recovery, because this manifest declares background_safe:
    // false / recommended_mode: "manual".
    const finalCallCount = await waitForCallCountToSettle(calls);
    assert.equal(
      finalCallCount,
      1,
      `expected exactly 1 connector run (the manual run only); got ${finalCallCount} — ` +
        'a recovery continuation was launched without owner presence',
    );
    // Every call the continuation WOULD have made is tagged manual — assert
    // there is only the one, genuinely owner-initiated call.
    assert.equal(calls[0].triggerKind, 'manual');
  });
});

test('background-safe connector: successful manual run MAY still auto-continue recovery', async (t) => {
  await withRecoveringController(t, async (controller: any, calls: any[]) => {
    const result = await controller.runNow(CONNECTOR_ID, {
      manifest: manifestWith(BACKGROUND_SAFE_REFRESH_POLICY),
      ownerToken: 'owner-token',
    });
    assert.equal(result.status, 'started');

    // For a background-safe connector the automation-policy gate added in
    // maybeContinueRecoveryAfterProgress must NOT block the continuation —
    // proving the fix is policy-specific, not a blanket "never continue"
    // regression. The fake connector always reports a fresh recovered gap, so
    // the continuation keeps re-triggering until the
    // MAX_RECOVERY_CONTINUATION_ENVELOPES cap is hit; asserting >1 is enough
    // to prove at least one continuation was allowed to start.
    const finalCallCount = await waitForCallCountToSettle(calls, { timeoutMs: 6000 });
    assert.ok(
      finalCallCount > 1,
      `expected more than 1 connector run (continuation should be allowed); got ${finalCallCount}`,
    );
  });
});
