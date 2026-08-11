// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded demo Syncs model — for screenshot review of the honesty-critical
 * states without a live throttled connection.
 *
 * Rendered ONLY when the route is hit with `?demo=...`; the real data path is
 * untouched otherwise. The two failure cards are derived by running the REAL
 * {@link deriveFailureSummary} over hand-built health snapshots plus
 * server-shaped rendered verdicts, so the demo exercises formatting without
 * reintroducing a raw-health fallback classifier:
 *   - a source-pressure cooldown (`cooling_off` + `source_pressure`) → the
 *     WAIT card (no reconnect button, next-attempt time stands in), and
 *   - a genuine `blocked` connection (no source-pressure backlog) → the
 *     reconnect card (copper owner-action button).
 * If the guard ever regressed, this seed would visibly flip a throttled card to
 * a false "Reconnect", making the regression obvious in review.
 */

import { deriveFailureSummary } from "../lib/connection-evidence.ts";
import type { RefConnectionHealthSnapshot, RefRenderedVerdict } from "../lib/ref-client.ts";
import type { FailureCard, SyncRhythmTick, SyncRow, SyncsViewModel } from "./syncs-model.ts";

const OK_RHYTHM: SyncRhythmTick[] = ["ok", "ok", "ok", "ok", "ok"];
const FAIL_RHYTHM: SyncRhythmTick[] = ["ok", "ok", "ok", "ok", "fail"];
const COOLING_RHYTHM: SyncRhythmTick[] = ["ok", "ok", "ok", "ok", "ok"];

function row(partial: Partial<SyncRow> & Pick<SyncRow, "stream" | "browseHref">): SyncRow {
  return {
    collectedThisRun: null,
    coverageCondition: null,
    failed: false,
    streamSkipped: false,
    ...partial,
  };
}

// A genuine credential/provider block: blocked, NO source-pressure backlog and
// NO scheduled next attempt → the guard does NOT fire, so the card is a real
// reconnect prompt.
const BLOCKED_HEALTH: RefConnectionHealthSnapshot = {
  axes: { attention: "open", coverage: "complete", freshness: "stale", outbox: "idle" },
  badges: { stale: true, syncing: false },
  last_success_at: "2026-06-11T05:00:00Z",
  next_action: null,
  next_attempt_at: null,
  reason_code: "credentials_expired",
  state: "blocked",
  unknown_reasons: [],
};

// A self-resolving source-pressure cooldown: the source is throttling, captured
// progress is retained, a next attempt is scheduled → the guard fires and the
// card MUST be WAIT copy, never "reconnect".
const COOLING_HEALTH: RefConnectionHealthSnapshot = {
  axes: { attention: "none", coverage: "partial", freshness: "fresh", outbox: "idle" },
  badges: { stale: false, syncing: false },
  detail_gap_backlog: {
    max_attempt_count: 5,
    next_attempt_at: "2026-06-13T09:00:00Z",
    pending: 1280,
    pending_is_floor: true,
    recovered: 4200,
  },
  last_success_at: "2026-06-13T04:10:00Z",
  next_action: null,
  next_attempt_at: "2026-06-13T09:00:00Z",
  reason_code: "source_pressure",
  state: "cooling_off",
  unknown_reasons: [],
} as RefConnectionHealthSnapshot;

const BLOCKED_VERDICT = {
  annotations: [],
  channel: "attention",
  detail: {},
  forward_statement: "Reconnect this account to resume collection.",
  pill: { label: "Can't collect", tone: "red" },
  progress: {
    gaps_drained_last_run: null,
    headline: "Collection needs attention.",
    last_refreshed_at: null,
    mode: "manual",
    records_committed_last_run: null,
    retained_records: null,
  },
  required_actions: [
    {
      affects: [],
      audience: "owner",
      cta: "Reconnect this account",
      kind: "reauth",
      satisfied_when: { kind: "credential_present_and_unrejected" },
      terminal: true,
      urgency: "now",
    },
  ],
  streams: [],
  trace: null,
} as RefRenderedVerdict;

const COOLING_VERDICT = {
  annotations: [],
  channel: "advisory",
  detail: {},
  forward_statement: "The source is throttling this connection; it will retry automatically.",
  pill: { label: "Degraded", tone: "amber" },
  progress: {
    gaps_drained_last_run: null,
    headline: "Waiting for the next attempt.",
    last_refreshed_at: null,
    mode: "scheduled",
    records_committed_last_run: null,
    retained_records: null,
  },
  required_actions: [
    {
      affects: [],
      audience: "none",
      cta: "No action needed",
      kind: "wait",
      satisfied_when: { kind: "none" },
      terminal: false,
      urgency: "soon",
    },
  ],
  streams: [],
  trace: null,
} as RefRenderedVerdict;

function demoCard(input: {
  name: string;
  connectionId: string;
  connectorId: string;
  health: RefConnectionHealthSnapshot;
  verdict: RefRenderedVerdict;
}): FailureCard {
  const summary = deriveFailureSummary(input.health, input.verdict);
  if (!summary) {
    throw new Error(`demo health for ${input.name} did not produce a failure summary`);
  }
  return { connectionId: input.connectionId, connectorId: input.connectorId, name: input.name, summary, work: null };
}

const FIRST_MERIDIAN = demoCard({
  connectionId: "cin_fm_206b11",
  connectorId: "first_meridian",
  health: BLOCKED_HEALTH,
  verdict: BLOCKED_VERDICT,
  name: "First Meridian — checking",
});

const CHATGPT = demoCard({
  connectionId: "cin_cg_91a0fe",
  connectorId: "chatgpt",
  health: COOLING_HEALTH,
  verdict: COOLING_VERDICT,
  name: "ChatGPT — personal",
});

export const DEMO_SYNCS_MODEL: SyncsViewModel = {
  band: { allClear: false, needsReview: 2, needYourHand: 1, onSchedule: 6 },
  duplicateGroups: [],
  failureCards: [FIRST_MERIDIAN, CHATGPT],
  groups: [
    {
      activeRunId: null,
      cadence: "daily",
      connectionId: "cin_nh_e3391c",
      connectorId: "northstar_hr",
      health: "ok",
      lastRunAt: "2026-06-13T06:00:00Z",
      lastRunDelta: "+2 records",
      lastRunDuration: "18 s",
      lastRunRhythm: OK_RHYTHM,
      name: "Northstar HR",
      next: "Jun 14 · 06:00Z",
      nextAt: "2026-06-14T06:00:00Z",
      streams: [
        row({
          browseHref: "/explore?connection=cin_nh_e3391c&stream=pay_statements",
          collectedThisRun: 2,
          coverageCondition: "complete",
          stream: "pay_statements",
        }),
        row({
          browseHref: "/explore?connection=cin_nh_e3391c&stream=employment",
          collectedThisRun: 0,
          coverageCondition: "complete",
          stream: "employment",
        }),
      ],
      totalStreamCount: 2,
    },
    {
      activeRunId: null,
      cadence: "daily",
      connectionId: "cin_cg_91a0fe",
      connectorId: "chatgpt",
      health: "failing",
      lastRunAt: "2026-06-13T04:10:00Z",
      lastRunDelta: "+34 records",
      lastRunDuration: "41 s",
      lastRunRhythm: COOLING_RHYTHM,
      name: "ChatGPT — personal",
      next: "2026-06-13T09:00:00Z",
      nextAt: "2026-06-13T09:00:00Z",
      streams: [
        row({
          browseHref: "/explore?connection=cin_cg_91a0fe&stream=conversations",
          collectedThisRun: 34,
          coverageCondition: "partial",
          stream: "conversations",
        }),
      ],
      totalStreamCount: 1,
    },
    {
      activeRunId: null,
      cadence: "daily",
      connectionId: "cin_fm_206b11",
      connectorId: "first_meridian",
      health: "failing",
      lastRunAt: "2026-06-11T05:00:00Z",
      lastRunDelta: "sync failed",
      lastRunDuration: "2 s",
      lastRunRhythm: FAIL_RHYTHM,
      name: "First Meridian — checking",
      next: "held",
      nextAt: null,
      streams: [
        row({
          browseHref: "/explore?connection=cin_fm_206b11&stream=transactions",
          failed: true,
          stream: "transactions",
        }),
        row({
          browseHref: "/explore?connection=cin_fm_206b11&stream=balances",
          failed: true,
          stream: "balances",
        }),
      ],
      totalStreamCount: 2,
    },
    {
      activeRunId: null,
      cadence: "every 15 min",
      connectionId: "cin_gm_410c2b",
      connectorId: "gmail",
      health: "ok",
      lastRunAt: "2026-06-13T05:00:00Z",
      lastRunDelta: "+38 records",
      lastRunDuration: "6 s",
      lastRunRhythm: OK_RHYTHM,
      name: "Gmail — personal",
      next: "2026-06-13T05:45:00Z",
      nextAt: "2026-06-13T05:45:00Z",
      streams: [
        row({
          browseHref: "/explore?connection=cin_gm_410c2b&stream=messages",
          collectedThisRun: 38,
          coverageCondition: "complete",
          stream: "messages",
        }),
      ],
      totalStreamCount: 1,
    },
  ],
  pendingSetupCards: [],
  recentSyncs: [
    {
      at: "2026-06-13T06:00:18Z",
      connectionId: "cin_nh_e3391c",
      connectionName: "Northstar HR",
      connectorId: "northstar_hr",
      duration: "18 s",
      eventCount: 2,
      href: "/syncs/run_nh_88c1",
      live: false,
      outcome: "ok",
      runId: "run_nh_88c1",
      status: "succeeded",
    },
    {
      at: "2026-06-13T05:00:06Z",
      connectionId: "cin_gm_410c2b",
      connectionName: "Gmail — personal",
      connectorId: "gmail",
      duration: "6 s",
      eventCount: 38,
      href: "/syncs/run_gm_41f0",
      live: false,
      outcome: "ok",
      runId: "run_gm_41f0",
      status: "succeeded",
    },
    {
      at: "2026-06-13T04:10:41Z",
      connectionId: "cin_cg_91a0fe",
      connectionName: "ChatGPT — personal",
      connectorId: "chatgpt",
      duration: "41 s",
      eventCount: 34,
      href: "/syncs/run_cg_7b20",
      live: false,
      outcome: "partial",
      runId: "run_cg_7b20",
      status: "succeeded_with_gaps",
    },
    {
      at: "2026-06-11T05:00:02Z",
      connectionId: "cin_fm_206b11",
      connectionName: "First Meridian — checking",
      connectorId: "first_meridian",
      duration: "2 s",
      eventCount: 0,
      href: "/syncs/run_fm_1d94",
      live: false,
      outcome: "failed",
      runId: "run_fm_1d94",
      status: "failed",
    },
  ],
  totalGroupCount: 4,
  totalReviewCardCount: 2,
  totalStreamCount: 6,
};
