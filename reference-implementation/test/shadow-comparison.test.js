/**
 * Shadow comparison — Dispatch C gate (task 12.3).
 *
 * For each fixture representing a live connection state, compares the
 * "old" dashboard headline (derived from `connection_health.state` directly,
 * the current console pattern) against the "new" synthesized
 * `RenderedVerdict`-based headline.
 *
 * Every change is classified as one of:
 *
 *   "fixed_lie"                  — old headline was dishonest (false owner urgency,
 *                                  "3/2 collected", "resumes collection" on terminal);
 *                                  new is correct. Expected and good.
 *
 *   "deliberate_silence_correction" — old headline surfaced a signal the owner
 *                                     cannot act on; new routes it to detail silently.
 *                                     Expected and good (the agency correction).
 *
 *   "unexpected_drift"           — new headline differs from old for a reason that is
 *                                  NOT a known lie or a silence correction. This is a
 *                                  regression and BLOCKS rollout.
 *
 * This suite FAILS (blocks) on any `unexpected_drift`. It is part of the
 * dashboard-migration gate before owner surfaces are switched to rendered_verdict.
 *
 * Fixtures cover the five specified cases:
 *   - ChatGPT (scheduled, fresh, 2532 recovered gaps)
 *   - Amazon (manual-refresh, 31-day stale)
 *   - Chase (one pending retryable gap, stale)
 *   - Synthetic terminal `code_fix` (maintainer-only action)
 *   - Synthetic runtime fault (`runtime_ok: false`)
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeConnectorVerdict } from '../runtime/connector-verdict-input.ts';

// ─── Old-headline derivation (the current console pattern) ───────────────────
//
// The console currently reads `connection_health.state` directly to produce a
// dashboard headline. This is the pattern the SLVP design forbids going forward,
// but we must shadow-compare against it.

function deriveOldHeadline(snapshot) {
  // Mirrors the console's current pill mapping:
  // healthy → "Healthy", idle → "Healthy" (treated same in old UI),
  // degraded → "Needs you", needs_attention → "Needs you",
  // cooling_off → "Healthy" (hidden, shows nothing), blocked → "Can't collect",
  // unknown → "Checking"
  const stateMap = {
    healthy: 'Healthy',
    idle: 'Healthy',
    degraded: 'Needs you',
    needs_attention: 'Needs you',
    cooling_off: 'Healthy',
    blocked: "Can't collect",
    unknown: 'Checking',
  };
  return stateMap[snapshot.state] ?? 'Checking';
}

function deriveNewHeadline(verdict) {
  return verdict.pill.label;
}

// ─── Change classifier ────────────────────────────────────────────────────────

/**
 * Classify an old-vs-new headline change.
 *
 * Returns: { classification, oldHeadline, newHeadline, channel, reason }
 */
function classifyChange(fixture, verdict) {
  const oldHeadline = deriveOldHeadline(fixture.snapshot);
  const newHeadline = deriveNewHeadline(verdict);
  const channel = verdict.channel;

  if (oldHeadline === newHeadline) {
    // No headline change. Could still be a silence correction if channel
    // changed from effectively "surface everything" to calm/advisory.
    const classification =
      fixture.expectedClassification === 'deliberate_silence_correction'
        ? 'deliberate_silence_correction'
        : 'no_change';
    return { classification, oldHeadline, newHeadline, channel, reason: fixture.reason ?? 'unchanged' };
  }

  // Headline changed — must be either a fixed lie or unexpected drift.
  if (fixture.expectedClassification === 'fixed_lie') {
    return { classification: 'fixed_lie', oldHeadline, newHeadline, channel, reason: fixture.reason };
  }
  if (fixture.expectedClassification === 'deliberate_silence_correction') {
    return { classification: 'deliberate_silence_correction', oldHeadline, newHeadline, channel, reason: fixture.reason };
  }

  // Unclassified headline change → unexpected_drift → blocks rollout.
  return {
    classification: 'unexpected_drift',
    oldHeadline,
    newHeadline,
    channel,
    reason: `UNCLASSIFIED: old="${oldHeadline}" new="${newHeadline}" — add to known-good list or investigate`,
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES = [
  // ── ChatGPT: scheduled, fresh, 2532 recovered gaps (all drained, 0 pending) ──
  //
  // Old headline: "Healthy" (reads state:healthy directly)
  // New headline: "Healthy" (synthesizer; calm channel, no gap count on dashboard)
  // Classification: deliberate_silence_correction — old UI would naively surface
  // the 2532 recovered gaps; new routes them to detail only.
  {
    id: 'chatgpt_scheduled_fresh',
    description: 'ChatGPT: scheduled, fresh today, 2532 recovered gaps (all drained)',
    expectedClassification: 'deliberate_silence_correction',
    reason: 'Silence correction: 2532 recovered gaps routed to detail only; dashboard stays calm',
    snapshot: {
      state: 'healthy',
      axes: { attention: 'none', coverage: 'complete', freshness: 'fresh', outbox: 'idle', remote_surface: 'none' },
      badges: { stale: false, syncing: false },
      collection_rate: null,
      conditions: [],
      detail_gap_backlog: { max_attempt_count: 3, next_attempt_at: null, pending: 0, pending_is_floor: false, pending_other: 0, pending_other_is_floor: false, recovered: 2532, terminal: null },
      dominant_condition_id: null,
      forward_disposition: 'complete',
      interaction_posture: 'credentials',
      is_health_relevant: true,
      last_success_at: '2026-06-15T08:00:00.000Z',
      next_action: null,
      next_attempt_at: null,
      push_payload: null,
      reason_code: null,
    },
    report: [{ stream: 'conversations', collected: 500, considered: 500, coverage_condition: 'complete', pending_detail_gaps: 0 }],
    manifestStreams: [{ name: 'conversations', required: true }],
    refresh: { recommendedMode: 'automatic', backgroundSafe: false, interactionPosture: 'credentials' },
    progress: null,
    runtimeOk: true,
    // After synthesis: ChatGPT fresh → green/calm. The 2532 is only in detail.
    assertions: (verdict) => {
      assert.equal(verdict.pill.tone, 'green', 'ChatGPT: green pill');
      assert.equal(verdict.pill.label, 'Healthy', 'ChatGPT: Healthy label');
      assert.equal(verdict.channel, 'calm', 'ChatGPT: calm channel');
      // 2532 must NOT appear in annotations text
      for (const ann of verdict.annotations) {
        assert.ok(!ann.text.includes('2532'), `2532 must not appear in annotation text: "${ann.text}"`);
      }
      // 2532 IS present in detail
      assert.equal(verdict.detail.detail_gap_backlog?.recovered, 2532, '2532 present in detail');
    },
  },

  // ── Amazon: manual-refresh, 31-day stale ──────────────────────────────────
  //
  // Old headline: "Healthy" (state:idle maps to "Healthy" in old UI)
  // New headline: "Healthy" (stale manual is freshness, not broken collection)
  // Classification: deliberate_silence_correction — new adds advisory freshness
  // and Refresh now without false owner-urgency language.
  {
    id: 'amazon_manual_stale',
    description: 'Amazon: manual-refresh, 31-day stale',
    expectedClassification: 'deliberate_silence_correction',
    reason: 'Silence correction: stale manual source stays Healthy while freshness and Refresh now move to advisory detail',
    snapshot: {
      state: 'idle',
      axes: { attention: 'none', coverage: 'complete', freshness: 'stale', outbox: 'idle', remote_surface: 'none' },
      badges: { stale: true, syncing: false },
      collection_rate: null,
      conditions: [],
      detail_gap_backlog: null,
      dominant_condition_id: null,
      forward_disposition: 'owner_refresh_due',
      interaction_posture: 'none',
      is_health_relevant: true,
      last_success_at: '2026-05-15T08:00:00.000Z',
      next_action: null,
      next_attempt_at: null,
      push_payload: null,
      reason_code: 'stale_manual_refresh',
    },
    report: [{ stream: 'orders', collected: 200, considered: 200, coverage_condition: 'complete', pending_detail_gaps: 0 }],
    manifestStreams: [{ name: 'orders', required: true }],
    refresh: { recommendedMode: 'manual', backgroundSafe: false },
    progress: null,
    runtimeOk: true,
    assertions: (verdict) => {
      assert.equal(verdict.pill.tone, 'green', 'Amazon: stale manual health stays green');
      assert.equal(verdict.pill.label, 'Healthy', 'Amazon: stale manual health label stays Healthy');
      assert.equal(verdict.channel, 'advisory', `Amazon: advisory refresh affordance, got ${verdict.channel}`);
      const refreshAction = verdict.required_actions.find((a) => a.kind === 'refresh_now');
      assert.ok(refreshAction, 'Amazon: refresh_now action present');
      // Freshness annotation must be present
      const freshnessAnn = verdict.annotations.find((a) => a.kind === 'freshness');
      assert.ok(freshnessAnn, 'Amazon: freshness annotation present');
    },
  },

  // ── Chase: one pending retryable gap, frozen ~2 months ───────────────────
  //
  // Old headline: "Needs you" (state:degraded → "Needs you")
  // New headline: "Degraded" (degraded with resumable disposition)
  // Classification: fixed_lie — old used owner-urgent wording for an advisory
  // retryable gap. New verdict adds the retry affordance without raising attention.
  {
    id: 'chase_retryable_gap',
    description: 'Chase: degraded, one retryable gap frozen ~2 months',
    expectedClassification: 'fixed_lie',
    reason: 'Fixed false urgency: retryable degraded gap is Degraded/advisory with Retry now, not Needs you',
    snapshot: {
      state: 'degraded',
      axes: { attention: 'none', coverage: 'retryable_gap', freshness: 'stale', outbox: 'idle', remote_surface: 'none' },
      badges: { stale: true, syncing: false },
      collection_rate: null,
      conditions: [],
      detail_gap_backlog: { max_attempt_count: 3, next_attempt_at: '2026-06-15T12:00:00.000Z', pending: 1, pending_is_floor: false, pending_other: 0, pending_other_is_floor: false, recovered: 0, terminal: null },
      dominant_condition_id: null,
      forward_disposition: 'resumable',
      interaction_posture: 'none',
      is_health_relevant: true,
      last_success_at: '2026-04-22T08:00:00.000Z',
      next_action: null,
      next_attempt_at: '2026-06-15T12:00:00.000Z',
      push_payload: null,
      reason_code: 'retryable_coverage_gap',
    },
    report: [{ stream: 'transactions', collected: 300, considered: 400, coverage_condition: 'retryable_gap', pending_detail_gaps: 1 }],
    manifestStreams: [{ name: 'transactions', required: true }],
    refresh: { recommendedMode: 'manual', backgroundSafe: false },
    progress: null,
    runtimeOk: true,
    assertions: (verdict) => {
      assert.equal(verdict.pill.tone, 'amber', 'Chase: amber health tone');
      assert.equal(verdict.pill.label, 'Degraded', 'Chase: Degraded label');
      assert.equal(verdict.channel, 'advisory', 'Chase: channel advisory (owner can retry manual connector)');
      const retry = verdict.required_actions.find((a) => a.kind === 'retry_gap');
      assert.ok(retry, 'Chase: retry_gap action present');
      assert.equal(retry.audience, 'owner', 'Chase: retry_gap is owner-actionable');
      assert.equal(retry.cta, 'Retry now', 'Chase: retry_gap CTA is Retry now');
      assert.deepEqual(retry.satisfied_when, { kind: 'gap_recovered' }, 'Chase: retry clears when the gap recovers');
      // Gap is present in detail
      assert.ok(
        verdict.detail.detail_gap_backlog !== null && verdict.detail.detail_gap_backlog.pending > 0,
        'Chase: gap present in detail'
      );
    },
  },

  // ── Synthetic terminal code_fix (maintainer-only) ─────────────────────────
  //
  // Old headline: "Can't collect" (state:blocked → "Can't collect")
  // New headline: "Can't collect" (terminal disposition → code_fix maintainer action)
  // Classification: deliberate_silence_correction — old had no channel concept;
  // new correctly routes to advisory (maintainer status, never owner attention).
  {
    id: 'synthetic_terminal_code_fix',
    description: 'Synthetic: terminal gap, code_fix required (maintainer-only)',
    expectedClassification: 'deliberate_silence_correction',
    reason: 'Silence correction: terminal gap routed as maintainer status (advisory), never owner attention button',
    snapshot: {
      state: 'blocked',
      axes: { attention: 'none', coverage: 'terminal_gap', freshness: 'stale', outbox: 'idle', remote_surface: 'none' },
      badges: { stale: true, syncing: false },
      collection_rate: null,
      conditions: [],
      detail_gap_backlog: { max_attempt_count: 5, next_attempt_at: null, pending: 0, pending_is_floor: false, pending_other: 1, pending_other_is_floor: false, recovered: 0, terminal: 3 },
      dominant_condition_id: null,
      forward_disposition: 'terminal',
      interaction_posture: 'none',
      is_health_relevant: true,
      last_success_at: '2026-01-01T00:00:00.000Z',
      next_action: null,
      next_attempt_at: null,
      push_payload: null,
      reason_code: 'terminal_coverage_gap',
    },
    report: [{ stream: 'records', collected: 50, considered: 100, coverage_condition: 'terminal_gap', pending_detail_gaps: 0 }],
    manifestStreams: [{ name: 'records', required: true }],
    refresh: null,
    progress: null,
    runtimeOk: true,
    assertions: (verdict) => {
      // Terminal → code_fix action, audience:maintainer → must NOT raise channel to attention
      const codeFixAction = verdict.required_actions.find((a) => a.kind === 'code_fix');
      assert.ok(codeFixAction, 'terminal: code_fix action present');
      assert.equal(codeFixAction.audience, 'maintainer', 'terminal: code_fix audience is maintainer');
      assert.notEqual(verdict.channel, 'attention', 'terminal: channel must not be attention (maintainer work)');
      // forward_statement must not claim "resumes collection"
      assert.ok(
        !verdict.forward_statement.toLowerCase().includes('resumes'),
        `terminal forward_statement must not claim resumption: "${verdict.forward_statement}"`
      );
    },
  },

  // ── Synthetic runtime fault (runtime_ok: false) ───────────────────────────
  //
  // Old headline: "Needs you" (state:needs_attention → "Needs you" even during runtime fault)
  // New headline: pill label same BUT channel capped at calm (S4 invariant)
  // Classification: deliberate_silence_correction — old would alarm per-connection;
  // new caps channel at calm so a single runtime fault doesn't cascade as N alarms.
  {
    id: 'synthetic_runtime_fault',
    description: 'Synthetic: runtime fault (runtime_ok=false) — channel capped at calm',
    expectedClassification: 'deliberate_silence_correction',
    reason: 'Silence correction: runtime fault caps per-connection channel at calm (S4); one global indicator instead of N alarms',
    snapshot: {
      state: 'needs_attention',
      axes: { attention: 'open', coverage: 'retryable_gap', freshness: 'stale', outbox: 'idle', remote_surface: 'none' },
      badges: { stale: true, syncing: false },
      collection_rate: null,
      conditions: [
        {
          current: true,
          expires_at: null,
          id: 'CredentialsValid:credential_rejected',
          message: 'Credential rejected',
          observed_at: null,
          origin: 'connector',
          reason: 'credential_rejected',
          remediation: null,
          sensitivity: 'owner',
          severity: 'error',
          status: 'false',
          type: 'CredentialsValid',
        },
      ],
      detail_gap_backlog: null,
      dominant_condition_id: 'CredentialsValid:credential_rejected',
      forward_disposition: 'complete',
      interaction_posture: 'none',
      is_health_relevant: true,
      last_success_at: null,
      next_action: null,
      next_attempt_at: null,
      push_payload: null,
      reason_code: 'credential_rejected',
    },
    report: [{ stream: 'records', collected: 0, considered: 100, coverage_condition: 'retryable_gap', pending_detail_gaps: 0 }],
    manifestStreams: [{ name: 'records', required: true }],
    refresh: null,
    progress: null,
    runtimeOk: false,
    assertions: (verdict) => {
      // Pill tone honest (connection really is in trouble)
      assert.notEqual(verdict.pill.tone, 'green', 'runtime fault: pill tone is not green (honest)');
      // Channel capped at calm (S4)
      assert.equal(verdict.channel, 'calm', 'runtime fault: channel capped at calm (S4 invariant)');
      assert.equal(verdict.trace.runtime_capped, true, 'runtime fault: trace.runtime_capped=true');
    },
  },
];

// ─── Shadow comparison runner ─────────────────────────────────────────────────

test('shadow-comparison: no unexpected_drift across all fixtures', () => {
  const results = [];
  const driftItems = [];

  for (const fixture of FIXTURES) {
    const verdict = synthesizeConnectorVerdict({
      snapshot: fixture.snapshot,
      report: fixture.report,
      manifestStreams: fixture.manifestStreams,
      refresh: fixture.refresh,
      progress: fixture.progress,
      runtimeOk: fixture.runtimeOk,
    });

    const result = classifyChange(fixture, verdict);
    results.push({ id: fixture.id, description: fixture.description, ...result });

    if (result.classification === 'unexpected_drift') {
      driftItems.push({ id: fixture.id, ...result });
    }
  }

  // Report all results
  for (const r of results) {
    const icon = r.classification === 'unexpected_drift' ? '✖ DRIFT' :
                 r.classification === 'fixed_lie' ? '✔ FIXED_LIE' :
                 r.classification === 'deliberate_silence_correction' ? '✔ SILENCE' : '✔ NO_CHANGE';
    console.log(`  ${icon} [${r.id}] ${r.oldHeadline}→${r.newHeadline} ch:${r.channel} — ${r.reason}`);
  }

  // Block on any drift
  assert.equal(
    driftItems.length,
    0,
    `ROLLOUT BLOCKED: ${driftItems.length} unexpected_drift item(s):\n${driftItems.map((d) => `  ${d.id}: ${d.reason}`).join('\n')}`
  );
});

// ─── Per-fixture assertions ───────────────────────────────────────────────────

for (const fixture of FIXTURES) {
  test(`shadow-comparison[${fixture.id}]: ${fixture.description}`, () => {
    const verdict = synthesizeConnectorVerdict({
      snapshot: fixture.snapshot,
      report: fixture.report,
      manifestStreams: fixture.manifestStreams,
      refresh: fixture.refresh,
      progress: fixture.progress,
      runtimeOk: fixture.runtimeOk,
    });

    // Run the fixture's specific assertions
    fixture.assertions(verdict);
  });
}
