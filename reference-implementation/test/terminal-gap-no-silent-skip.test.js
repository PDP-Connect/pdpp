// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * §10-A "impossible by construction" — no gap path silently skips terminalization.
 *
 * These tests pin the GAP 1 (terminal) + GAP 2 fixes from the adversarial
 * SLVP-ideal review. Before the fix:
 *   - `terminalGapProfileForConnector(connectorId)` returned `null` for any
 *     connector not in the chatgpt-only registry, and the runtime DETAIL_GAP
 *     handler wrapped terminalization in `if (terminalProfile) { ... }` — so a
 *     non-chatgpt connector emitting a 404/410/permanent gap SILENTLY skipped
 *     terminalization and the gap stayed `pending` forever (the §10-A silent
 *     "100% done" lie).
 *   - gap CREATION is connector-agnostic (`emitDetailGap` is a generic SDK
 *     helper; the runtime handler is connector-agnostic) but gap TERMINALIZATION
 *     was opt-in. A connector could emit a gap that could never go terminal.
 *
 * After the fix (`resolveTerminalGapPolicy` always returns a real policy — the
 * explicit per-connector profile OR the safe `DEFAULT_TERMINAL_GAP_PROFILE`):
 *   - every connector terminalizes unfillable gaps; opt-out is impossible.
 *   - the decision site never branches on a null policy.
 *
 * Each test below FAILS against the pre-fix code (no resolver; null-skip handler).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-A, §3 rule 6
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import { createSqliteConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import {
  CHATGPT_PROVIDER_PROFILE,
  DEFAULT_TERMINAL_GAP_PROFILE,
  maybeTerminateGap,
  resolveTerminalGapPolicy,
  terminalGapProfileForConnector,
} from '../server/stores/terminal-gap-classifier.js';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-terminal-no-skip-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ─── GAP 1 (terminal): resolution is required, never a silent skip ───────────

test('DEFAULT_TERMINAL_GAP_PROFILE is a real declared policy (finite positive integer budget)', () => {
  assert.ok(
    Number.isInteger(DEFAULT_TERMINAL_GAP_PROFILE.maxRecoveryAttempts) &&
      DEFAULT_TERMINAL_GAP_PROFILE.maxRecoveryAttempts > 0,
    'the safe default must carry a real terminalization budget, not Infinity/0',
  );
});

test('resolveTerminalGapPolicy ALWAYS returns a real policy — there is no null-skip branch (GAP 1/2)', () => {
  // The explicit registry value for chatgpt.
  assert.equal(resolveTerminalGapPolicy('chatgpt'), CHATGPT_PROVIDER_PROFILE);
  assert.equal(resolveTerminalGapPolicy('chatgpt:default'), CHATGPT_PROVIDER_PROFILE);

  // Every OTHER connector — declared or not — resolves to the safe default,
  // never null. This is the seam that makes "a connector silently skips
  // terminalization" impossible by construction.
  for (const id of ['github', 'notion', 'oura', 'spotify', 'strava', 'ynab', 'some-brand-new-connector', '', undefined]) {
    const policy = resolveTerminalGapPolicy(id);
    assert.ok(policy, `resolveTerminalGapPolicy(${String(id)}) must return a policy, never null`);
    assert.ok(
      Number.isInteger(policy.maxRecoveryAttempts) && policy.maxRecoveryAttempts > 0,
      `resolved policy for ${String(id)} must carry a real budget`,
    );
  }
});

test('the per-connector registry resolver still returns null for unknown (no OVERRIDE) — the resolver, not the registry, is the seam', () => {
  // terminalGapProfileForConnector is the OVERRIDE lookup (null = no override),
  // NOT the terminalization gate. Callers must use resolveTerminalGapPolicy.
  assert.equal(terminalGapProfileForConnector('github'), null, 'no explicit override for github');
  assert.notEqual(resolveTerminalGapPolicy('github'), null, 'but it still terminalizes via the default');
});

test('maybeTerminateGap fails LOUD (throws) when handed a null/invalid profile — the .js build-error equivalent', async () => {
  // The decision site MUST throw rather than silently skip when a profile is
  // missing. Combined with resolveTerminalGapPolicy always supplying one, this
  // makes a silent skip impossible at the seam.
  const fakeStore = { getGapById: async () => null, markGapStatus: async () => null };
  await assert.rejects(
    () => maybeTerminateGap(fakeStore, 'gap_x', { status: 404 }, null),
    /requires providerProfile\.maxRecoveryAttempts/,
    'a null profile at the decision site must be a loud throw, not a silent skip',
  );
  await assert.rejects(
    () => maybeTerminateGap(fakeStore, 'gap_x', { status: 404 }, {}),
    /requires providerProfile\.maxRecoveryAttempts/,
    'an invalid profile (no maxRecoveryAttempts) must throw',
  );
});

// ─── GAP 2: a non-chatgpt connector's permanent gap REACHES terminal ─────────
//
// This is the §10-A-no-bypass pin: simulate the runtime DETAIL_GAP handler path
// for a NON-chatgpt connector that emits a gap on a permanent (404) error. With
// the safe default policy resolving for every connector, the gap reaches
// `terminal` — it never stays `pending` forever. Against the pre-fix code
// (terminalGapProfileForConnector('github') === null → `if (terminalProfile)`
// skip) this gap would stay pending and this test FAILS.

test(
  'a NON-chatgpt connector emitting a gap on a permanent 404 reaches terminal (never permanently pending) — §10-A no bypass',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'github'; // a connector with NO explicit terminal profile

    // The connector emitted a detail gap that re-defers with a permanent 404.
    const gap = await store.upsertPendingGap({
      connectorId,
      grantId: 'grant_gh',
      stream: 'pull_requests',
      recordKey: 'pr_deleted_999',
      reason: 'retry_exhausted',
      detailLocator: { kind: 'github.pull_request', id: 'pr_deleted_999' },
      lastError: { http_status: 404, class: 'http_404' },
    });

    // The runtime handler resolves a policy for the connector — ALWAYS non-null.
    const policy = resolveTerminalGapPolicy(connectorId);
    assert.ok(policy, 'github must resolve a terminal policy (the GAP 2 fix)');

    // Drive the gap to its recovery budget against the 404 (mirrors the runtime
    // marking in_progress before each recovery attempt).
    for (let i = 1; i <= policy.maxRecoveryAttempts; i++) {
      await store.markGapStatus(gap.gap_id, 'in_progress');
    }

    const errorInfo = { status: 404, errorClass: 'http_404' };
    const outcome = await maybeTerminateGap(store, gap.gap_id, errorInfo, policy);
    assert.equal(outcome.terminated, true, 'the github 404 gap MUST reach terminal');

    // It is gone from the fillable pending set (cannot lie "still pending / not done").
    const pending = await store.listPendingGapsForConnector(connectorId, { limit: 100 });
    assert.equal(pending.length, 0, 'the terminal github gap must NOT remain in the pending set');

    // And it is counted separately — never silently dropped.
    const terminalCount = await store.countGapsByStatusForConnector(connectorId, { status: 'terminal' });
    assert.equal(terminalCount, 1, 'the terminal github gap must be counted, not dropped');
  }),
);

test(
  'a NON-chatgpt connector emitting a gap on a TRANSIENT error (429) stays pending — terminalization is permanent-only',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = 'notion';
    const gap = await store.upsertPendingGap({
      connectorId,
      grantId: 'grant_n',
      stream: 'pages',
      recordKey: 'page_busy',
      reason: 'rate_limited',
      detailLocator: { kind: 'notion.page', id: 'page_busy' },
      lastError: { http_status: 429 },
    });
    const policy = resolveTerminalGapPolicy(connectorId);
    for (let i = 1; i <= policy.maxRecoveryAttempts + 2; i++) {
      await store.markGapStatus(gap.gap_id, 'in_progress');
    }
    const outcome = await maybeTerminateGap(store, gap.gap_id, { status: 429 }, policy);
    assert.equal(outcome.terminated, false, 'a 429 (source pressure) must NEVER terminalize, even with a default policy');
    const terminalCount = await store.countGapsByStatusForConnector(connectorId, { status: 'terminal' });
    assert.equal(terminalCount, 0, 'no terminal gap for a transient error');
  }),
);
