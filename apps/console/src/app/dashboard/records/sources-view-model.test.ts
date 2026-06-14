/**
 * Unit tests for the pure Sources view-model mapping.
 *
 * The mapping is the data-source seam between the live connector summaries and
 * the Recordroom presentation. These tests pin the load-bearing, non-fabricating
 * behaviors: health→status flag, schedule formatting, the Explore deep-link
 * shape, and the honest "unknown" defaults the spine did not declare.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorSummary,
  RefRecordVersionStatsRow,
  RefSchedule,
} from "../lib/ref-client.ts";
import {
  buildSourcesChurnAdvisory,
  deriveSourceStatus,
  exploreHrefFor,
  formatSchedule,
  manualUploadHrefForSource,
  toSourceInstanceView,
} from "./sources-view-model.ts";

const EXPLORE_HREF_RE = /^\/dashboard\/explore\?connection=conn_1&stream=/;
const CHURN_SIGNAL_RE = /ynab \/ budgets retains 273\.75 versions/;
const CHURN_CLASSIFIED_RE = /classified/;
const CHURN_NEEDS_REVIEW_RE = /needs review/;

const EMPTY_AXES = {
  attention: {} as RefConnectionHealthSnapshot["axes"]["attention"],
  coverage: {} as RefConnectionHealthSnapshot["axes"]["coverage"],
  freshness: {} as RefConnectionHealthSnapshot["axes"]["freshness"],
  outbox: {} as RefConnectionHealthSnapshot["axes"]["outbox"],
};

function health(state: RefConnectionHealthSnapshot["state"]): RefConnectionHealthSnapshot {
  return {
    state,
    reason_code: null,
    last_success_at: null,
    next_attempt_at: null,
    badges: { stale: false, syncing: false },
    axes: EMPTY_AXES,
    next_action: null,
    unknown_reasons: [],
  };
}

function summary(partial: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    connector_id: "gmail",
    connection_id: "conn_1",
    connector_instance_id: "conn_1",
    display_name: "Gmail",
    connector_display_name: "Gmail",
    freshness: {},
    manifest_version: "1.0.0",
    last_run: null,
    last_successful_run: null,
    schedule: null,
    next_action: null,
    connection_health: health("healthy"),
    streams: ["messages", "threads"],
    stream_count: 2,
    total_records: 100,
    ...partial,
  };
}

function manualUploadManifest(connectorId = "whatsapp") {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    setup: {
      modality: "manual_or_upload",
      manual_or_upload: {
        import_dir_env_var: "WHATSAPP_EXPORT_DIR",
        accepted_file_extensions: [".zip"],
      },
    },
  };
}

test("deriveSourceStatus maps healthy/idle to a green dot", () => {
  assert.equal(deriveSourceStatus(health("healthy"), false).tone, "success");
  assert.equal(deriveSourceStatus(health("idle"), false).kind, "healthy");
});

test("deriveSourceStatus maps degraded family to a warning half-dot", () => {
  for (const state of ["degraded", "cooling_off", "needs_attention"] as const) {
    const flag = deriveSourceStatus(health(state), false);
    assert.equal(flag.tone, "warning");
    assert.equal(flag.dot, "◐");
  }
});

test("deriveSourceStatus maps blocked to a destructive interdict", () => {
  const flag = deriveSourceStatus(health("blocked"), false);
  assert.equal(flag.kind, "blocked");
  assert.equal(flag.tone, "destructive");
});

test("deriveSourceStatus renders unknown (never green) when no projection", () => {
  const flag = deriveSourceStatus(undefined, false);
  assert.equal(flag.kind, "unknown");
  assert.equal(flag.tone, "muted");
});

test("revoked lifecycle overrides any health verdict", () => {
  const flag = deriveSourceStatus(health("healthy"), true);
  assert.equal(flag.kind, "revoked");
});

test("formatSchedule is honest about no schedule, paused, and policy-ineligible", () => {
  assert.equal(formatSchedule(null), "manual — no schedule");
  const base: RefSchedule = {
    object: "schedule",
    connector_id: "gmail",
    trigger_kind: "scheduled",
    automation_mode: "unattended",
    automation_summary: "",
    effective_mode: "automatic",
    enabled: true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: 86_400,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: null,
    notification_posture: "none",
    recommended_policy: null,
    scheduler_backoff: null,
    active_run_id: null,
    created_at: "",
    updated_at: "",
  };
  assert.equal(formatSchedule(base), "every 1d · automatic");
  assert.equal(formatSchedule({ ...base, enabled: false }), "paused");
  assert.equal(formatSchedule({ ...base, effective_mode: "paused" }), "paused");
  assert.equal(formatSchedule({ ...base, ineligibility_reason: "manifest_policy" }), "every 1d · paused by policy");
});

test("exploreHrefFor encodes connection + stream into the Explore deep link", () => {
  const href = exploreHrefFor("conn_1", "current_activity");
  assert.equal(href, "/dashboard/explore?connection=conn_1&stream=current_activity");
});

test("toSourceInstanceView never fabricates per-stream search/cursor", () => {
  const view = toSourceInstanceView(summary());
  assert.equal(view.streams.length, 2);
  for (const stream of view.streams) {
    assert.equal(stream.searchable, null, "search flag must be unknown, not guessed");
    assert.equal(stream.cursor, null, "cursor must be unknown, not guessed");
    assert.match(stream.exploreHref, EXPLORE_HREF_RE);
  }
});

test("toSourceInstanceView surfaces a revoked instance with a struck status", () => {
  const view = toSourceInstanceView(summary({ status: "revoked", revoked_at: "2026-06-01T00:00:00Z" }));
  assert.equal(view.revoked, true);
  assert.equal(view.status.kind, "revoked");
});

test("toSourceInstanceView links the detail page, never a raw action target", () => {
  const view = toSourceInstanceView(summary({ connection_id: "conn x/y" }));
  assert.equal(view.detailHref, "/dashboard/records/conn%20x%2Fy");
});

test("manual/upload sources link to importing another file into the same source", () => {
  const view = toSourceInstanceView(summary({ connector_id: "whatsapp", connection_id: "cin_whatsapp_1" }), {
    manifests: [manualUploadManifest()],
  });
  assert.equal(view.manualUploadHref, "/dashboard/connect/manual-upload/whatsapp?connection_id=cin_whatsapp_1");
  assert.deepEqual(
    view.passportFields.find((field) => field.k === "auth"),
    { k: "auth", value: "owner file import" }
  );
});

test("manual/upload source href is absent when the connector has no packaged import binding", () => {
  const href = manualUploadHrefForSource(summary({ connector_id: "whatsapp", connection_id: "cin_whatsapp_1" }), [
    {
      connector_id: "whatsapp",
      setup: {
        modality: "manual_or_upload",
        manual_or_upload: { accepted_file_extensions: [".zip"] },
      },
    },
  ]);
  assert.equal(href, null);
});

function churnRow(partial: Partial<RefRecordVersionStatsRow> = {}): RefRecordVersionStatsRow {
  return {
    connector_id: "ynab",
    connector_instance_id: "cin_ynab_1",
    current_record_count: 4,
    display_name: null,
    last_current_at: "2026-05-30T00:00:00.000Z",
    last_history_at: "2026-05-31T00:00:00.000Z",
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
    ...partial,
  };
}

test("buildSourcesChurnAdvisory surfaces an advisory for a churned source", () => {
  const advisory = buildSourcesChurnAdvisory([churnRow()]);
  assert.ok(advisory, "a churning (non-normal) stream must surface an advisory");
  assert.match(advisory.highestSignal, CHURN_SIGNAL_RE);
  // A classified compaction candidate is not "needs review" — the advisory
  // stays informational, reusing the disposition-honest summarizer verdict.
  assert.equal(advisory.needsReview, false);
  assert.match(advisory.headline, CHURN_CLASSIFIED_RE);
});

test("buildSourcesChurnAdvisory flags needsReview for an unclassified churn row", () => {
  const advisory = buildSourcesChurnAdvisory([churnRow({ version_disposition: "active_defect_or_unclassified" })]);
  assert.ok(advisory);
  assert.equal(advisory.needsReview, true);
  assert.match(advisory.headline, CHURN_NEEDS_REVIEW_RE);
});

test("buildSourcesChurnAdvisory returns null when no stream is churning", () => {
  // A fresh source: only normal-risk rows (or none) → no advisory at all.
  assert.equal(buildSourcesChurnAdvisory([]), null);
  assert.equal(buildSourcesChurnAdvisory([churnRow({ risk_level: "normal" })]), null);
});
