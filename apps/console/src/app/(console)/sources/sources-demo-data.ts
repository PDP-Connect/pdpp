// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DEV-ONLY seeded Sources fixtures.
 *
 * Lets a reviewer screenshot the Recordroom Sources view (every status flag,
 * the passport, the revoke ceremony, the stream manifest) without a live
 * reference server or real owner data. Imported ONLY when `?demo=` is present
 * AND `NODE_ENV !== "production"` (see records/page.tsx). The live path never
 * imports this module, so no fictional data can leak into a real deployment.
 *
 * The shapes are real `RefConnectorSummary`s so the same `toSourcesView`
 * mapping the live page uses runs unchanged against them — the demo exercises
 * the real projection, not a parallel one.
 */

import type { RefConnectionHealthSnapshot, RefConnectorSummary, RefRecordVersionStatsRow } from "../lib/ref-client.ts";

export type SourcesDemoScenario = "mixed" | "healthy" | "attention";

const VALID = new Set<SourcesDemoScenario>(["mixed", "healthy", "attention"]);

export function isSourcesDemoScenario(value: string): value is SourcesDemoScenario {
  return VALID.has(value as SourcesDemoScenario);
}

const EMPTY_AXES: RefConnectionHealthSnapshot["axes"] = {
  attention: {} as RefConnectionHealthSnapshot["axes"]["attention"],
  coverage: {} as RefConnectionHealthSnapshot["axes"]["coverage"],
  freshness: {} as RefConnectionHealthSnapshot["axes"]["freshness"],
  outbox: {} as RefConnectionHealthSnapshot["axes"]["outbox"],
};

function health(
  state: RefConnectionHealthSnapshot["state"],
  extra: Partial<RefConnectionHealthSnapshot> = {}
): RefConnectionHealthSnapshot {
  return {
    axes: EMPTY_AXES,
    badges: { stale: false, syncing: false },
    last_success_at: "2026-06-12T08:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state,
    unknown_reasons: [],
    ...extra,
  };
}

const TYPE_LABEL_SEP_RE = /[-_]/;

/** Title-case the connector key into a type label, e.g. "gmail" → "Gmail". */
function typeLabel(connectorId: string): string {
  return connectorId
    .split(TYPE_LABEL_SEP_RE)
    .map((part) => {
      const first = part.charAt(0);
      return first ? first.toUpperCase() + part.slice(1) : part;
    })
    .join(" ");
}

function summary(
  partial: Pick<RefConnectorSummary, "connector_id" | "connection_id" | "display_name"> & Partial<RefConnectorSummary>
): RefConnectorSummary {
  return {
    connection_health: health("healthy"),
    // The TYPE label (distinct from the owner's per-instance display_name), so
    // the demo exercises the real "type · account" list line shape.
    connector_display_name: typeLabel(partial.connector_id),
    connector_instance_id: partial.connection_id,
    freshness: {},
    last_run: {
      event_count: 42,
      failure_reason: null,
      finished_at: "2026-06-12T08:01:00Z",
      first_at: "2026-04-01T00:00:00Z",
      last_at: "2026-06-12T08:01:00Z",
      run_id: "run_demo_0001",
      started_at: "2026-06-12T08:00:00Z",
      status: "succeeded",
    },
    last_successful_run: {
      event_count: 42,
      failure_reason: null,
      finished_at: "2026-06-12T08:01:00Z",
      first_at: "2026-04-01T00:00:00Z",
      last_at: "2026-06-12T08:01:00Z",
      run_id: "run_demo_0001",
      started_at: "2026-06-12T08:00:00Z",
      status: "succeeded",
    },
    manifest_version: "1.0.0",
    next_action: null,
    schedule: null,
    stream_count: 2,
    streams: ["messages", "threads"],
    total_records: 1234,
    ...partial,
  };
}

const GMAIL = summary({
  connection_health: health("healthy"),
  connection_id: "conn_gmail_personal_01",
  connector_id: "gmail",
  display_name: "Gmail (personal)",
  schedule: {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: "Runs automatically every day.",
    connector_id: "gmail",
    created_at: "2026-04-01T00:00:00Z",
    effective_mode: "automatic",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 86_400,
    jitter_seconds: 600,
    last_error_code: null,
    last_finished_at: "2026-06-12T08:01:00Z",
    last_started_at: "2026-06-12T08:00:00Z",
    last_successful_at: "2026-06-12T08:01:00Z",
    minimum_interval_warning: null,
    next_due_at: "2026-06-13T08:00:00Z",
    notification_posture: "none",
    object: "schedule",
    policy_warning: null,
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "2026-06-12T08:01:00Z",
  },
  stream_count: 4,
  streams: ["messages", "threads", "labels", "attachments"],
  total_records: 48_201,
});

const CHATGPT = summary({
  connection_health: health("needs_attention", {
    next_action: {
      action_target: "open_detail",
      attention_id: "att_demo_01",
      expires_at: null,
      notification_state: "sent",
      owner_action: "act_elsewhere",
      reason_code: "owner_refresh_due",
      response_contract: "none",
      source: "structured",
    },
    reason_code: "owner_refresh_due",
  }),
  connection_id: "conn_chatgpt_01",
  connector_id: "chatgpt",
  display_name: "ChatGPT",
  stream_count: 2,
  streams: ["conversations", "current_activity"],
  total_records: 5108,
});

const CHASE = summary({
  connection_health: health("blocked", { reason_code: "reauthorize_required" }),
  connection_id: "conn_chase_01",
  connector_id: "chase",
  display_name: "Chase",
  stream_count: 2,
  streams: ["statements", "current_activity"],
  total_records: 902,
});

const SPOTIFY_REVOKED = summary({
  connection_health: health("idle"),
  connection_id: "conn_spotify_01",
  connector_id: "spotify",
  display_name: "Spotify",
  revoked_at: "2026-06-01T00:00:00Z",
  status: "revoked",
  stream_count: 2,
  streams: ["plays", "playlists"],
  total_records: 12_044,
});

const AMAZON = summary({
  connection_health: health("degraded", { reason_code: "partial_coverage" }),
  connection_id: "conn_amazon_01",
  connector_id: "amazon",
  display_name: "Amazon",
  stream_count: 3,
  streams: ["orders", "returns", "addresses"],
  total_records: 311,
});

export function buildSourcesDemoSummaries(scenario: SourcesDemoScenario): RefConnectorSummary[] {
  if (scenario === "healthy") {
    return [GMAIL, summary({ connection_id: "conn_github_01", connector_id: "github", display_name: "GitHub" })];
  }
  if (scenario === "attention") {
    return [CHATGPT, CHASE, AMAZON];
  }
  // mixed — one of everything for a full screenshot.
  return [GMAIL, CHATGPT, AMAZON, CHASE, SPOTIFY_REVOKED];
}

/** Build a seeded version-stats row so the demo can render a churn advisory. */
function churnRow(overrides: Partial<RefRecordVersionStatsRow> = {}): RefRecordVersionStatsRow {
  return {
    connector_id: "ynab",
    connector_instance_id: "cin_ynab_demo",
    current_record_count: 4,
    display_name: null,
    last_current_at: "2026-06-12T08:00:00Z",
    last_history_at: "2026-06-12T08:01:00Z",
    projection_authority: "record_changes_ground_truth",
    projection_dirty: false,
    projection_missing: false,
    record_history_count: 1095,
    record_key_count: 4,
    risk_level: "high",
    risk_reasons: ["versions_per_record_high"],
    stream: "budgets",
    version_disposition: "lossless_compaction_candidate",
    version_remediation: "none",
    versions_per_record: 273.75,
    ...overrides,
  };
}

/**
 * Seeded version-churn rows for the Sources demo. The `healthy` scenario has no
 * churn (proves the advisory is absent when nothing crosses the threshold); the
 * other scenarios surface a single classified compaction candidate so the quiet
 * advisory renders for a screenshot. Fictional — demo only.
 */
export function buildSourcesDemoChurnRows(scenario: SourcesDemoScenario): RefRecordVersionStatsRow[] {
  if (scenario === "healthy") {
    return [];
  }
  return [churnRow()];
}
