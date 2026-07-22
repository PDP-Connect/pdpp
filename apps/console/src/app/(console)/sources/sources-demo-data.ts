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
    state,
    reason_code: null,
    last_success_at: "2026-06-12T08:00:00Z",
    next_attempt_at: null,
    badges: { stale: false, syncing: false },
    axes: EMPTY_AXES,
    next_action: null,
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
    // The TYPE label (distinct from the owner's per-instance display_name), so
    // the demo exercises the real "type · account" list line shape.
    connector_display_name: typeLabel(partial.connector_id),
    connector_instance_id: partial.connection_id,
    freshness: {},
    manifest_version: "1.0.0",
    last_run: {
      run_id: "run_demo_0001",
      status: "succeeded",
      started_at: "2026-06-12T08:00:00Z",
      finished_at: "2026-06-12T08:01:00Z",
      first_at: "2026-04-01T00:00:00Z",
      last_at: "2026-06-12T08:01:00Z",
      event_count: 42,
      failure_reason: null,
    },
    last_successful_run: {
      run_id: "run_demo_0001",
      status: "succeeded",
      started_at: "2026-06-12T08:00:00Z",
      finished_at: "2026-06-12T08:01:00Z",
      first_at: "2026-04-01T00:00:00Z",
      last_at: "2026-06-12T08:01:00Z",
      event_count: 42,
      failure_reason: null,
    },
    schedule: null,
    next_action: null,
    connection_health: health("healthy"),
    streams: ["messages", "threads"],
    stream_count: 2,
    total_records: 1234,
    ...partial,
  };
}

const GMAIL = summary({
  connector_id: "gmail",
  connection_id: "conn_gmail_personal_01",
  display_name: "Gmail (personal)",
  streams: ["messages", "threads", "labels", "attachments"],
  stream_count: 4,
  total_records: 48_201,
  connection_health: health("healthy"),
  schedule: {
    object: "schedule",
    connector_id: "gmail",
    trigger_kind: "scheduled",
    automation_mode: "unattended",
    automation_summary: "Runs automatically every day.",
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
    policy_warning: null,
    recommended_policy: null,
    scheduler_backoff: null,
    active_run_id: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-06-12T08:01:00Z",
  },
});

const CHATGPT = summary({
  connector_id: "chatgpt",
  connection_id: "conn_chatgpt_01",
  display_name: "ChatGPT",
  streams: ["conversations", "current_activity"],
  stream_count: 2,
  total_records: 5108,
  connection_health: health("needs_attention", {
    reason_code: "owner_refresh_due",
    next_action: {
      source: "structured",
      reason_code: "owner_refresh_due",
      owner_action: "act_elsewhere",
      action_target: "open_detail",
      attention_id: "att_demo_01",
      expires_at: null,
      response_contract: "none",
      notification_state: "sent",
    },
  }),
});

const CHASE = summary({
  connector_id: "chase",
  connection_id: "conn_chase_01",
  display_name: "Chase",
  streams: ["statements", "current_activity"],
  stream_count: 2,
  total_records: 902,
  connection_health: health("blocked", { reason_code: "reauthorize_required" }),
});

const SPOTIFY_REVOKED = summary({
  connector_id: "spotify",
  connection_id: "conn_spotify_01",
  display_name: "Spotify",
  streams: ["plays", "playlists"],
  stream_count: 2,
  total_records: 12_044,
  status: "revoked",
  revoked_at: "2026-06-01T00:00:00Z",
  connection_health: health("idle"),
});

const AMAZON = summary({
  connector_id: "amazon",
  connection_id: "conn_amazon_01",
  display_name: "Amazon",
  streams: ["orders", "returns", "addresses"],
  stream_count: 3,
  total_records: 311,
  connection_health: health("degraded", { reason_code: "partial_coverage" }),
});

export function buildSourcesDemoSummaries(scenario: SourcesDemoScenario): RefConnectorSummary[] {
  if (scenario === "healthy") {
    return [GMAIL, summary({ connector_id: "github", connection_id: "conn_github_01", display_name: "GitHub" })];
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
