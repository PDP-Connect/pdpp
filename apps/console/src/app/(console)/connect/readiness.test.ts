// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RefConnectionHealthSnapshot,
  RefConnectorRunSummary,
  RefConnectorSummary,
  RefRenderedVerdict,
} from "../lib/ref-client.ts";
import { sourceReadinessRow } from "./readiness.ts";

const HEALTHY_RE = /healthy/;
const SUCCESSFUL_SYNC_RE = /successful sync/;
const THREE_RECORDS_RE = /3 records/;
const RETAINED_RECORDS_RE = /retained records/;
const NOT_HEALTHY_SOURCE_RE = /not currently project a healthy source/;
const STALE_OR_UNOBSERVED_RE = /stale or unobserved/;
const EVIDENCE_RE = /not yet provide enough evidence/;
const NEXT_PAGE_RE = /next page/;
const ADD_SOURCE_RE = /Add a source/;
const MISSING_SOURCE_READ_RE = /missing source read/;
const FRESHNESS_RE = /freshness/i;

const EMPTY_AXES = {
  attention: "none",
  coverage: "complete",
  freshness: "fresh",
  outbox: "idle",
} as const;

function health(
  state: RefConnectionHealthSnapshot["state"] = "healthy",
  freshness: RefConnectionHealthSnapshot["axes"]["freshness"] = "fresh"
): RefConnectionHealthSnapshot {
  return {
    axes: { ...EMPTY_AXES, freshness },
    badges: { stale: false, syncing: false },
    last_success_at: "2026-07-31T12:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state,
    unknown_reasons: [],
  };
}

function successfulRun(): RefConnectorRunSummary {
  return {
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-07-31T12:00:06Z",
    first_at: "2026-07-31T12:00:00Z",
    last_at: "2026-07-31T12:00:06Z",
    run_id: "run_success",
    started_at: "2026-07-31T12:00:00Z",
    status: "succeeded",
  };
}

function renderedVerdict(overrides: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "Collection is current.",
    pill: { label: "Healthy", tone: "green" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Retained records are available.",
      last_refreshed_at: "2026-07-31T12:00:06Z",
      mode: "scheduled",
      records_committed_last_run: 3,
      retained_records: 3,
    },
    required_actions: [],
    streams: [],
    trace: {},
    ...overrides,
  };
}

function summary(overrides: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    connection_health: health(),
    connection_id: "connection_example",
    connector_display_name: "Example source",
    connector_id: "example_source",
    connector_instance_id: "instance_example",
    display_name: "Example source",
    freshness: {},
    last_run: successfulRun(),
    last_successful_run: successfulRun(),
    manifest_version: "1.0.0",
    next_action: null,
    rendered_verdict: renderedVerdict(),
    schedule: null,
    streams: ["records"],
    total_records: 3,
    total_records_state: "known",
    ...overrides,
  };
}

test("sourceReadinessRow is ready only when one source proves fresh required evidence", () => {
  const row = sourceReadinessRow({ hasMore: false, summaries: [summary()] });

  assert.equal(row.status, "ok");
  assert.match(row.detail, HEALTHY_RE);
  assert.match(row.detail, SUCCESSFUL_SYNC_RE);
  assert.match(row.detail, THREE_RECORDS_RE);
});

test("sourceReadinessRow keeps a healthy-but-stale source from claiming readiness", () => {
  const row = sourceReadinessRow({
    hasMore: false,
    summaries: [
      summary({
        connection_health: health("healthy", "stale"),
        rendered_verdict: renderedVerdict({
          annotations: [{ kind: "freshness", text: "Stale — refresh is due." }],
        }),
      }),
    ],
  });

  assert.equal(row.status, "unknown");
  assert.match(row.hint ?? "", FRESHNESS_RE);
});

test("sourceReadinessRow keeps a healthy source with unknown freshness from claiming readiness", () => {
  const row = sourceReadinessRow({
    hasMore: false,
    summaries: [
      summary({
        connection_health: health("healthy", "unknown"),
        rendered_verdict: renderedVerdict({
          annotations: [{ kind: "freshness", text: "Freshness has not been measured yet." }],
        }),
      }),
    ],
  });

  assert.equal(row.status, "unknown");
  assert.match(row.hint ?? "", FRESHNESS_RE);
});

test("sourceReadinessRow is blocked when a source has not completed a successful sync", () => {
  const row = sourceReadinessRow({ hasMore: false, summaries: [summary({ last_successful_run: null })] });

  assert.equal(row.status, "error");
  assert.match(row.hint ?? "", SUCCESSFUL_SYNC_RE);
});

test("sourceReadinessRow is blocked when a source has no retained records", () => {
  const row = sourceReadinessRow({
    hasMore: false,
    summaries: [summary({ total_records: 0, total_records_state: "known_zero" })],
  });

  assert.equal(row.status, "error");
  assert.match(row.detail, RETAINED_RECORDS_RE);
});

test("sourceReadinessRow is blocked when the server-owned source projection is not healthy", () => {
  const row = sourceReadinessRow({
    hasMore: false,
    summaries: [
      summary({
        rendered_verdict: renderedVerdict({
          channel: "attention",
          forward_statement: "Collection needs attention.",
          pill: { label: "Degraded", tone: "amber" },
        }),
      }),
    ],
  });

  assert.equal(row.status, "error");
  assert.match(row.detail, NOT_HEALTHY_SOURCE_RE);
});

test("sourceReadinessRow keeps stale retained-count evidence unknown", () => {
  const row = sourceReadinessRow({
    hasMore: false,
    summaries: [summary({ total_records_state: "stale" })],
  });

  assert.equal(row.status, "unknown");
  assert.match(row.hint ?? "", STALE_OR_UNOBSERVED_RE);
});

test("sourceReadinessRow keeps a missing server-owned verdict unknown", () => {
  const row = sourceReadinessRow({ hasMore: false, summaries: [summary({ rendered_verdict: null })] });

  assert.equal(row.status, "unknown");
  assert.match(row.detail, EVIDENCE_RE);
});

test("sourceReadinessRow keeps an incomplete first page unknown", () => {
  const row = sourceReadinessRow({
    hasMore: true,
    summaries: [summary({ last_successful_run: null })],
  });

  assert.equal(row.status, "unknown");
  assert.match(row.hint ?? "", NEXT_PAGE_RE);
});

test("sourceReadinessRow blocks an empty source inventory", () => {
  const row = sourceReadinessRow({ hasMore: false, summaries: [] });

  assert.equal(row.status, "error");
  assert.match(row.hint ?? "", ADD_SOURCE_RE);
});

test("sourceReadinessRow treats an unavailable source response as unknown", () => {
  const row = sourceReadinessRow({ hasMore: false, summaries: null });

  assert.equal(row.status, "unknown");
  assert.match(row.hint ?? "", MISSING_SOURCE_READ_RE);
});
