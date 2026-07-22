// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded demo Syncs model — for screenshot review of the honesty-critical
 * states without a live throttled connection.
 *
 * Rendered ONLY when the route is hit with `?demo=...`; the real data path is
 * untouched otherwise. The two failure cards are derived by running the REAL
 * {@link deriveFailureSummary} over hand-built health snapshots, so the demo
 * proves the actual guard rather than hard-coding copy:
 *   - a source-pressure cooldown (`cooling_off` + `source_pressure`) → the
 *     WAIT card (no reconnect button, next-attempt time stands in), and
 *   - a genuine `blocked` connection (no source-pressure backlog) → the
 *     reconnect card (copper owner-action button).
 * If the guard ever regressed, this seed would visibly flip a throttled card to
 * a false "Reconnect", making the regression obvious in review.
 */

import { deriveFailureSummary } from "../lib/connection-evidence.ts";
import type { RefConnectionHealthSnapshot } from "../lib/ref-client.ts";
import type { FailureCard, SyncRhythmTick, SyncRow, SyncsViewModel } from "./syncs-model.ts";

const OK_RHYTHM: SyncRhythmTick[] = ["ok", "ok", "ok", "ok", "ok"];
const FAIL_RHYTHM: SyncRhythmTick[] = ["ok", "ok", "ok", "ok", "fail"];
const COOLING_RHYTHM: SyncRhythmTick[] = ["ok", "ok", "ok", "ok", "ok"];

function row(partial: Partial<SyncRow> & Pick<SyncRow, "stream" | "cadence" | "browseHref">): SyncRow {
  return {
    next: "—",
    nextAt: null,
    failed: false,
    collectedThisRun: null,
    coverageCondition: null,
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
  last_success_at: "2026-06-13T04:10:00Z",
  next_action: null,
  next_attempt_at: "2026-06-13T09:00:00Z",
  reason_code: "source_pressure",
  state: "cooling_off",
  detail_gap_backlog: {
    max_attempt_count: 5,
    next_attempt_at: "2026-06-13T09:00:00Z",
    pending: 1280,
    pending_is_floor: true,
    recovered: 4200,
  },
  unknown_reasons: [],
} as RefConnectionHealthSnapshot;

function demoCard(input: {
  name: string;
  connectionId: string;
  connectorId: string;
  health: RefConnectionHealthSnapshot;
}): FailureCard {
  const summary = deriveFailureSummary(input.health);
  if (!summary) {
    throw new Error(`demo health for ${input.name} did not produce a failure summary`);
  }
  return { name: input.name, connectionId: input.connectionId, connectorId: input.connectorId, summary, work: null };
}

const FIRST_MERIDIAN = demoCard({
  name: "First Meridian — checking",
  connectionId: "cin_fm_206b11",
  connectorId: "first_meridian",
  health: BLOCKED_HEALTH,
});

const CHATGPT = demoCard({
  name: "ChatGPT — personal",
  connectionId: "cin_cg_91a0fe",
  connectorId: "chatgpt",
  health: COOLING_HEALTH,
});

export const DEMO_SYNCS_MODEL: SyncsViewModel = {
  band: { onSchedule: 6, needYourHand: 1, needsReview: 2, allClear: false },
  duplicateGroups: [],
  failureCards: [FIRST_MERIDIAN, CHATGPT],
  pendingSetupCards: [],
  groups: [
    {
      name: "Northstar HR",
      connectionId: "cin_nh_e3391c",
      activeRunId: null,
      connectorId: "northstar_hr",
      health: "ok",
      lastRunDelta: "+2 records",
      lastRunDuration: "18 s",
      lastRunAt: "2026-06-13T06:00:00Z",
      lastRunRhythm: OK_RHYTHM,
      streams: [
        row({
          stream: "pay_statements",
          cadence: "with payroll",
          collectedThisRun: 2,
          coverageCondition: "complete",
          next: "Jun 14 · 06:00Z",
          nextAt: "2026-06-14T06:00:00Z",
          browseHref: "/explore?connection=cin_nh_e3391c&stream=pay_statements",
        }),
        row({
          stream: "employment",
          cadence: "daily",
          collectedThisRun: 0,
          coverageCondition: "complete",
          next: "Jun 14 · 06:00Z",
          nextAt: "2026-06-14T06:00:00Z",
          browseHref: "/explore?connection=cin_nh_e3391c&stream=employment",
        }),
      ],
      totalStreamCount: 2,
    },
    {
      name: "ChatGPT — personal",
      connectionId: "cin_cg_91a0fe",
      activeRunId: null,
      connectorId: "chatgpt",
      health: "failing",
      lastRunDelta: "+34 records",
      lastRunDuration: "41 s",
      lastRunAt: "2026-06-13T04:10:00Z",
      lastRunRhythm: COOLING_RHYTHM,
      streams: [
        row({
          stream: "conversations",
          cadence: "daily",
          collectedThisRun: 34,
          coverageCondition: "partial",
          next: "2026-06-13T09:00:00Z",
          nextAt: "2026-06-13T09:00:00Z",
          browseHref: "/explore?connection=cin_cg_91a0fe&stream=conversations",
        }),
      ],
      totalStreamCount: 1,
    },
    {
      name: "First Meridian — checking",
      connectionId: "cin_fm_206b11",
      activeRunId: null,
      connectorId: "first_meridian",
      health: "failing",
      lastRunDelta: "sync failed",
      lastRunDuration: "2 s",
      lastRunAt: "2026-06-11T05:00:00Z",
      lastRunRhythm: FAIL_RHYTHM,
      streams: [
        row({
          stream: "transactions",
          cadence: "daily",
          failed: true,
          next: "held",
          browseHref: "/explore?connection=cin_fm_206b11&stream=transactions",
        }),
        row({
          stream: "balances",
          cadence: "daily",
          failed: true,
          next: "held",
          browseHref: "/explore?connection=cin_fm_206b11&stream=balances",
        }),
      ],
      totalStreamCount: 2,
    },
    {
      name: "Gmail — personal",
      connectionId: "cin_gm_410c2b",
      activeRunId: null,
      connectorId: "gmail",
      health: "ok",
      lastRunDelta: "+38 records",
      lastRunDuration: "6 s",
      lastRunAt: "2026-06-13T05:00:00Z",
      lastRunRhythm: OK_RHYTHM,
      streams: [
        row({
          stream: "messages",
          cadence: "every 15 min",
          collectedThisRun: 38,
          coverageCondition: "complete",
          next: "2026-06-13T05:45:00Z",
          nextAt: "2026-06-13T05:45:00Z",
          browseHref: "/explore?connection=cin_gm_410c2b&stream=messages",
        }),
      ],
      totalStreamCount: 1,
    },
  ],
  totalGroupCount: 4,
  totalReviewCardCount: 2,
  totalStreamCount: 6,
};
