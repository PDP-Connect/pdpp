// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  RefRenderedVerdict,
  RefSchedule,
} from "../lib/ref-client.ts";
import { deriveRenderedSourceStatus } from "../lib/source-actionability.ts";
import {
  buildDuplicateSourceReview,
  buildSourcesChurnAdvisory,
  buildSourcesRuntimeAdvisory,
  collapseDuplicateFallbackSources,
  exploreHrefFor,
  formatSchedule,
  manualUploadHrefForSource,
  sourceDetailHrefFor,
  toSourceInstanceView,
  toSourcesView,
} from "./sources-view-model.ts";

const EXPLORE_HREF_RE = /^\/explore\?connection=conn_1&stream=/;
const MESSAGES_STREAM_HREF_RE = /stream=messages/;
const CHURN_SIGNAL_RE = /ynab \/ budgets retains 273\.75 versions/;
const CHURN_CLASSIFIED_RE = /classified/;
const CHURN_NEEDS_REVIEW_RE = /needs review/;
const RECORDS_42_RE = /42 records/;
const RECORDS_0_RE = /0 records/;
const RECORDS_42_UNVERIFIED_RE = /42 records \(unverified\)/;
const RECORDS_42_BARE_RE = /42 records ·/;
const RECORDS_0_UNVERIFIED_RE = /0 records \(unverified\)/;
const RECORDS_UNAVAILABLE_RE = /records unavailable/;
const NUMERIC_RECORDS_RE = /\d records/;
const PASSPORT_42_UNVERIFIED_RE = /42.*unverified/;
const PASSPORT_0_UNVERIFIED_RE = /0.*unverified/;

const EMPTY_AXES = {
  attention: {} as RefConnectionHealthSnapshot["axes"]["attention"],
  coverage: {} as RefConnectionHealthSnapshot["axes"]["coverage"],
  freshness: {} as RefConnectionHealthSnapshot["axes"]["freshness"],
  outbox: {} as RefConnectionHealthSnapshot["axes"]["outbox"],
};

function health(state: RefConnectionHealthSnapshot["state"]): RefConnectionHealthSnapshot {
  return {
    axes: EMPTY_AXES,
    badges: { stale: false, syncing: false },
    last_success_at: null,
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state,
    unknown_reasons: [],
  };
}

function summary(partial: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return {
    connection_health: health("healthy"),
    connection_id: "conn_1",
    connector_display_name: "Gmail",
    connector_id: "gmail",
    connector_instance_id: "conn_1",
    display_name: "Gmail",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: "1.0.0",
    next_action: null,
    schedule: null,
    stream_count: 2,
    streams: ["messages", "threads"],
    total_records: 100,
    ...partial,
  };
}

function lastRun(status: string): NonNullable<RefConnectorSummary["last_run"]> {
  return {
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-06-13T04:00:06Z",
    first_at: "2026-06-13T04:00:00Z",
    last_at: "2026-06-13T04:00:06Z",
    run_id: "run_1",
    started_at: "2026-06-13T04:00:00Z",
    status,
  } as NonNullable<RefConnectorSummary["last_run"]>;
}

function renderedVerdict(partial: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "Collection is current.",
    pill: { label: "Healthy", tone: "green" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Retained records are available.",
      last_refreshed_at: null,
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: 100,
    },
    required_actions: [],
    streams: [],
    trace: {},
    ...partial,
  };
}

function manualUploadManifest(connectorId = "whatsapp") {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    setup: {
      manual_or_upload: {
        accepted_file_extensions: [".zip"],
        import_dir_env_var: "WHATSAPP_EXPORT_DIR",
      },
      modality: "manual_or_upload",
    },
  };
}

function passportField(view: ReturnType<typeof toSourceInstanceView>, key: string): string | null | undefined {
  return view.passportFields.find((field) => field.k === key)?.value;
}

test("deriveRenderedSourceStatus prefers the server-owned verdict over raw health state", () => {
  const flag = deriveRenderedSourceStatus(renderedVerdict({ pill: { label: "Degraded", tone: "amber" } }), false);
  assert.equal(flag.kind, "degraded");
  assert.equal(flag.tone, "warning");
  assert.equal(flag.label, "Degraded");
});

test("deriveRenderedSourceStatus carries freshness annotations from rendered verdict", () => {
  const flag = deriveRenderedSourceStatus(
    renderedVerdict({
      annotations: [{ kind: "freshness", text: "Stale — this connector refreshes when you run it." }],
      pill: { label: "Healthy", tone: "green" },
    }),
    false
  );
  assert.equal(flag.kind, "healthy");
  assert.equal(flag.freshnessNote, "Stale — this connector refreshes when you run it.");
  assert.equal(flag.label, "Healthy · Stale — this connector refreshes when you run it.");
});

test("toSourceInstanceView reads status from rendered_verdict when present", () => {
  const view = toSourceInstanceView(
    summary({
      connection_health: health("healthy"),
      rendered_verdict: renderedVerdict({ pill: { label: "Can't collect", tone: "red" } }),
    })
  );
  assert.equal(view.status.kind, "blocked");
  assert.equal(view.status.label, "Can't collect");
});

test("toSourceInstanceView derives local-device modality from persisted source_kind, not heartbeat presence", () => {
  const localWithoutHeartbeat = toSourceInstanceView(
    summary({
      local_device_progress: null,
      source_kind: "local_device",
    })
  );
  const remoteWithHeartbeatShapedProgress = toSourceInstanceView(
    summary({
      local_device_progress: {
        last_heartbeat_at: "2026-06-03T11:59:00.000Z",
        last_heartbeat_status: "healthy",
        last_ingest_at: "2026-06-03T11:59:00.000Z",
        records_pending: 0,
        source_count: 1,
      },
      source_kind: "account",
    })
  );
  assert.equal(localWithoutHeartbeat.isLocalDevicePush, true);
  assert.equal(remoteWithHeartbeatShapedProgress.isLocalDevicePush, false);
});

test("toSourceInstanceView treats pending last_run as running and keeps terminal or unknown statuses out", () => {
  const cases: [string, boolean][] = [
    ["pending", true],
    ["started", true],
    ["in_progress", true],
    ["succeeded", false],
    ["error", false],
    ["future_status", false],
  ];

  for (const [status, expected] of cases) {
    const view = toSourceInstanceView(summary({ last_run: lastRun(status) }));
    assert.equal(view.isRunning, expected, `status ${status} should${expected ? "" : " not"} be running`);
  }
});

test("toSourceInstanceView reads owner CTA from rendered_verdict required actions", () => {
  const view = toSourceInstanceView(
    summary({
      connection_health: {
        ...health("needs_attention"),
        next_action: {
          action_target: "legacy_target",
          attention_id: "att_legacy",
          expires_at: null,
          owner_action: "act_elsewhere",
          reason_code: "legacy_action",
          response_contract: "none",
          source: "structured",
        },
      },
      rendered_verdict: renderedVerdict({
        required_actions: [
          {
            affects: [],
            audience: "owner",
            cta: "Refresh now",
            kind: "refresh_now",
            satisfied_when: { kind: "confirming_run_succeeded" },
            terminal: false,
            urgency: "soon",
          },
        ],
      }),
    })
  );
  assert.equal(view.nextAction, null, "owner-runnable verdict actions are not duplicated as body CTAs");
  assert.equal(view.ownerActionCue?.label, "Refresh now");
  assert.equal(view.primaryVerdictAction?.cta, "Refresh now");
  assert.equal(view.primaryVerdictAction?.ownerRunnable, true);
});

test("toSourceInstanceView surfaces owner-runnable advisory action cues for source rows", () => {
  const view = toSourceInstanceView(
    summary({
      connector_display_name: "Reddit",
      connector_id: "reddit",
      display_name: "Reddit",
      rendered_verdict: renderedVerdict({
        channel: "advisory",
        forward_statement: "Run a refresh when you want the latest saved posts.",
        pill: { label: "Healthy", tone: "green" },
        required_actions: [
          {
            affects: [],
            audience: "owner",
            cta: "Refresh now",
            kind: "refresh_now",
            satisfied_when: { kind: "confirming_run_succeeded" },
            terminal: false,
            urgency: "soon",
          },
        ],
      }),
    })
  );

  assert.deepEqual(view.ownerActionCue, { label: "Refresh now" });
  assert.equal(view.primaryVerdictAction?.ownerRunnable, true);
  assert.equal(view.primaryVerdictAction?.channel, "advisory");
});

test("toSourceInstanceView surfaces owner-runnable attention action cues for source rows", () => {
  const view = toSourceInstanceView(
    summary({
      rendered_verdict: renderedVerdict({
        channel: "attention",
        pill: { label: "Can't collect", tone: "red" },
        required_actions: [
          {
            affects: [],
            audience: "owner",
            cta: "Reconnect",
            kind: "reauth",
            satisfied_when: { kind: "attention_resolved" },
            terminal: false,
            urgency: "now",
          },
        ],
      }),
    })
  );

  assert.equal(view.nextAction, null, "reauth is rendered once as the footer/detail action");
  assert.deepEqual(view.ownerActionCue, { label: "Reconnect" });
  assert.equal(view.primaryVerdictAction?.ownerRunnable, true);
  assert.equal(view.primaryVerdictAction?.channel, "attention");
});

test("toSourceInstanceView does not fall back to raw health state or next_action when rendered_verdict is absent", () => {
  const view = toSourceInstanceView(
    summary({
      connection_health: {
        ...health("needs_attention"),
        next_action: {
          action_target: "legacy_target",
          attention_id: "att_legacy",
          expires_at: null,
          owner_action: "act_elsewhere",
          reason_code: "legacy_action",
          response_contract: "none",
          source: "structured",
        },
      },
      rendered_verdict: null,
    })
  );
  assert.equal(view.status.kind, "unknown");
  assert.equal(view.status.label, "Verdict unavailable");
  assert.equal(view.nextAction, null);
});

test("toSourceInstanceView does not render maintainer or wait actions as owner CTAs", () => {
  for (const action of [
    {
      affects: [],
      audience: "maintainer",
      cta: "Connector code needs a fix",
      kind: "code_fix",
      satisfied_when: { kind: "none" },
      terminal: true,
      urgency: "soon",
    },
    {
      affects: [],
      audience: "none",
      cta: "Waiting for the next retry window",
      kind: "wait",
      satisfied_when: { kind: "none" },
      terminal: false,
      urgency: "verifying",
    },
  ] as const) {
    const view = toSourceInstanceView(
      summary({
        rendered_verdict: renderedVerdict({ required_actions: [action] }),
      })
    );
    assert.equal(view.nextAction, null);
    assert.equal(view.ownerActionCue, null);
    assert.equal(view.primaryVerdictAction?.cta, action.cta);
    assert.equal(view.primaryVerdictAction?.ownerRunnable, false);
    assert.equal(view.primaryVerdictAction?.satisfiedWhenKind, "none");
  }
});

test("toSourceInstanceView renders calibrated live-journey verdict copy without inspection counts", () => {
  const chatgpt = toSourceInstanceView(
    summary({
      connector_display_name: "ChatGPT",
      connector_id: "chatgpt",
      display_name: "ChatGPT",
      rendered_verdict: renderedVerdict({
        annotations: [{ kind: "freshness", text: "Fresh today." }],
        detail: {
          suppressed: [
            {
              detail_field: "detail_gap_backlog",
              kind: "drain",
              reason: "2532 recovered gaps live in detail only",
            },
          ],
        },
        pill: { label: "Healthy", tone: "green" },
      }),
    })
  );
  assert.equal(chatgpt.status.label, "Healthy · Fresh today.");
  assert.equal(chatgpt.nextAction, null);
  assert.ok(!JSON.stringify(chatgpt).includes("2532"), "dashboard model must not expose drained gap counts");

  const amazon = toSourceInstanceView(
    summary({
      connector_display_name: "Amazon",
      connector_id: "amazon",
      display_name: "Amazon",
      rendered_verdict: renderedVerdict({
        annotations: [{ kind: "freshness", text: "Last refreshed 31 days ago." }],
        pill: { label: "Healthy", tone: "green" },
        required_actions: [
          {
            affects: [],
            audience: "owner",
            cta: "Refresh now",
            kind: "refresh_now",
            satisfied_when: { kind: "confirming_run_succeeded" },
            terminal: false,
            urgency: "soon",
          },
        ],
      }),
    })
  );
  assert.equal(amazon.status.label, "Healthy · Last refreshed 31 days ago.");
  assert.equal(amazon.nextAction, null);
  assert.equal(amazon.primaryVerdictAction?.cta, "Refresh now");

  const chase = toSourceInstanceView(
    summary({
      connector_display_name: "Chase",
      connector_id: "chase",
      display_name: "Chase",
      rendered_verdict: renderedVerdict({
        annotations: [{ kind: "freshness", text: "Transactions stuck since Apr 22." }],
        pill: { label: "Degraded", tone: "amber" },
        required_actions: [
          {
            affects: ["transactions"],
            audience: "owner",
            cta: "Retry now",
            kind: "retry_gap",
            satisfied_when: { kind: "gap_recovered" },
            terminal: false,
            urgency: "verifying",
          },
        ],
        streams: [
          {
            action_ref: 0,
            collected: 300,
            considered: 400,
            coverage: "retryable_gap",
            disposition: "resumable",
            statement: "The next run is expected to fill the rest.",
            stream_id: "transactions",
          },
        ],
      }),
    })
  );
  assert.equal(chase.status.label, "Degraded · Transactions stuck since Apr 22.");
  assert.equal(chase.nextAction, null);
  assert.equal(chase.primaryVerdictAction?.cta, "Retry now");
});

test("toSourceInstanceView does not label refresh/retry review actions as auth repair", () => {
  for (const kind of ["refresh_now", "retry_gap"] as const) {
    const view = toSourceInstanceView(
      summary({
        rendered_verdict: renderedVerdict({
          channel: "advisory",
          required_actions: [
            {
              affects: [],
              audience: "owner",
              cta: kind === "refresh_now" ? "Refresh now" : "Retry now",
              kind,
              satisfied_when: { kind: kind === "refresh_now" ? "confirming_run_succeeded" : "gap_recovered" },
              terminal: false,
              urgency: "soon",
            },
          ],
        }),
      })
    );

    assert.equal(passportField(view, "auth"), "session / stored credential");
    assert.equal(view.nextAction, null);
    assert.equal(view.primaryVerdictAction?.kind, kind);
  }
});

test("toSourceInstanceView labels auth repair only for reauth owner actions", () => {
  const view = toSourceInstanceView(
    summary({
      rendered_verdict: renderedVerdict({
        channel: "attention",
        required_actions: [
          {
            affects: [],
            audience: "owner",
            cta: "Reconnect this account",
            kind: "reauth",
            satisfied_when: { kind: "credential_present_and_unrejected" },
            terminal: false,
            urgency: "now",
          },
        ],
      }),
    })
  );

  assert.equal(passportField(view, "auth"), "owner action required");
  assert.equal(view.nextAction, null);
  assert.equal(view.primaryVerdictAction?.kind, "reauth");
});

test("toSourceInstanceView uses the same stream count for config and stream table", () => {
  const view = toSourceInstanceView(
    summary({
      stream_count: 5,
      stream_records: [{ last_updated: "2026-07-01T17:58:46.531Z", record_count: 133_848, stream: "messages" }],
      streams: ["conversations", "messages", "memories", "custom_gpts", "custom_instructions", "shared_conversations"],
    })
  );

  assert.equal(passportField(view, "config"), "6 streams");
  assert.equal(view.streams.length, 6);
});

test("buildSourcesRuntimeAdvisory renders one global runtime fault and ignores healthy runtime", () => {
  assert.equal(
    buildSourcesRuntimeAdvisory({
      label: "Collection runtime ready",
      message: null,
      object: "ref_runtime_status",
      ok: true,
      reason: null,
    }),
    null
  );
  assert.deepEqual(
    buildSourcesRuntimeAdvisory({
      label: "Collection runtime unavailable",
      message: null,
      object: "ref_runtime_status",
      ok: false,
      reason: "controller_unavailable",
    }),
    {
      headline: "Collection runtime unavailable",
      note: "Saved records remain available. Collection resumes when the reference runtime is back.",
    }
  );
});

test("formatSchedule is honest about no schedule, paused, and policy-ineligible", () => {
  assert.equal(formatSchedule(null), "manual — no schedule");
  const base: RefSchedule = {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: "",
    connector_id: "gmail",
    created_at: "",
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
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: "",
  };
  assert.equal(formatSchedule(base), "every 1d · automatic");
  assert.equal(formatSchedule({ ...base, enabled: false }), "paused");
  assert.equal(formatSchedule({ ...base, effective_mode: "paused" }), "paused");
  assert.equal(formatSchedule({ ...base, ineligibility_reason: "manifest_policy" }), "every 1d · paused by policy");
});

test("exploreHrefFor encodes connection + stream into the Explore deep link", () => {
  const href = exploreHrefFor("conn_1", "current_activity");
  assert.equal(href, "/explore?connection=conn_1&stream=current_activity");
});

test("toSourceInstanceView never fabricates per-stream search/cursor", () => {
  const view = toSourceInstanceView(summary());
  assert.equal(view.streams.length, 2);
  for (const stream of view.streams) {
    assert.equal(stream.searchable, null, "search flag must be unknown, not guessed");
    assert.equal(stream.cursor, null, "cursor must be unknown, not guessed");
    assert.equal(stream.collection, null, "collection facts must be absent when the reference did not provide them");
    assert.match(stream.exploreHref, EXPLORE_HREF_RE);
  }
});

test("toSourceInstanceView surfaces server-owned collection report facts per stream", () => {
  const view = toSourceInstanceView(
    summary({
      collection_report: [
        {
          checkpoint: "advanced",
          collected: 8,
          considered: 10,
          coverage_condition: "partial",
          forward_disposition: "resumable",
          pending_detail_gaps: 2,
          pending_detail_gaps_is_floor: true,
          skipped: null,
          stream: "messages",
        },
      ],
    })
  );

  const messages = view.streams.find((stream) => stream.name === "messages");
  const threads = view.streams.find((stream) => stream.name === "threads");
  assert.ok(messages?.collection, "matching streams should carry collection report facts");
  assert.equal(messages.collection.countsLabel, "8 / 10 collected");
  assert.equal(messages.collection.coverageLabel, "Coverage · partial");
  assert.equal(messages.collection.dispositionLabel, "Next run: resumes collection");
  assert.equal(messages.collection.pendingDetailGaps, 2);
  assert.equal(messages.collection.pendingDetailGapsIsFloor, true);
  assert.equal(messages.collection.pendingDetailGapsLabel, "at least 2 pending gaps");
  assert.equal(messages.collection.tone, "warning");
  assert.equal(threads?.collection, null, "streams without collection report facts stay explicitly unavailable");
});

test("toSourceInstanceView surfaces retained stream counts without conflating them with latest collection", () => {
  const view = toSourceInstanceView(
    summary({
      collection_report: [
        {
          checkpoint: "committed",
          collected: 8,
          considered: 10,
          coverage_condition: "retryable_gap",
          covered: 8,
          forward_disposition: "resumable",
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
      ],
      stream_records: [
        { last_updated: "2026-06-17T11:00:00.000Z", record_count: 42, stream: "messages" },
        { last_updated: "2026-06-16T11:00:00.000Z", record_count: 3, stream: "archived" },
      ],
    })
  );

  const messages = view.streams.find((stream) => stream.name === "messages");
  const archived = view.streams.find((stream) => stream.name === "archived");
  const threads = view.streams.find((stream) => stream.name === "threads");
  assert.equal(messages?.recordCount, 42);
  assert.equal(messages?.collection?.countsLabel, "8 / 10 covered · 8 collected");
  assert.equal(archived?.recordCount, 3, "retained-only streams remain visible");
  assert.equal(archived?.collection, null, "retained count is not relabeled as collection progress");
  assert.equal(threads?.recordCount, null, "manifest streams without retained rows stay explicitly unknown");
});

test("toSourceInstanceView keeps collection-report-only streams visible", () => {
  const view = toSourceInstanceView(
    summary({
      collection_report: [
        {
          checkpoint: "advanced",
          collected: 8,
          considered: 10,
          coverage_condition: "partial",
          forward_disposition: "resumable",
          pending_detail_gaps: 2,
          skipped: null,
          stream: "messages",
        },
      ],
      stream_count: 1,
      streams: [],
    })
  );

  assert.deepEqual(
    view.streams.map((stream) => stream.name),
    ["messages"]
  );
  assert.equal(view.streams[0]?.collection?.countsLabel, "8 / 10 collected");
  assert.match(view.streams[0]?.exploreHref ?? "", MESSAGES_STREAM_HREF_RE);
});

test("toSourceInstanceView drops blank stream names", () => {
  const view = toSourceInstanceView(summary({ stream_count: 1, streams: ["", "  ", "messages"] }));
  assert.deepEqual(
    view.streams.map((stream) => stream.name),
    ["messages"]
  );
});

test("toSourceInstanceView surfaces a revoked instance with a struck status", () => {
  const view = toSourceInstanceView(summary({ revoked_at: "2026-06-01T00:00:00Z", status: "revoked" }));
  assert.equal(view.revoked, true);
  assert.equal(view.status.kind, "revoked");
});

test("toSourceInstanceView omits passport identity rows that duplicate the source title", () => {
  const view = toSourceInstanceView(
    summary({
      connector_display_name: "Amazon",
      connector_id: "amazon",
      display_name: "Amazon - Personal",
    })
  );

  assert.equal(view.displayName, "Amazon - Personal");
  assert.equal(view.listKind, null);
  assert.deepEqual(view.passportFields.map((field) => field.k).slice(0, 2), ["config", "auth"]);
  assert.equal(
    view.passportFields.some((field) => field.k === "kind"),
    false
  );
  assert.equal(
    view.passportFields.some((field) => field.k === "account"),
    false
  );
  assert.equal(
    view.passportFields.some((field) => field.k === "type"),
    false
  );
});

test("toSourceInstanceView keeps connector type when the source title does not identify it", () => {
  const view = toSourceInstanceView(
    summary({
      connector_display_name: "Amazon",
      connector_id: "amazon",
      display_name: "Personal",
    })
  );

  assert.equal(view.displayName, "Personal");
  assert.equal(view.listKind, "Amazon");
  assert.deepEqual(view.passportFields[0], { k: "type", mono: false, value: "Amazon" });
});

test("toSourceInstanceView links the detail page, never a raw action target", () => {
  const view = toSourceInstanceView(summary({ connection_id: "conn x/y" }));
  assert.equal(view.detailHref, "/sources/conn%20x%2Fy");
});

// ─── draft (setup_in_progress) connection routing ──────────────────────────

function draftSummary(partial: Partial<RefConnectorSummary> = {}): RefConnectorSummary {
  return summary({
    owner_state: {
      evidence_as_of: null,
      owner_of_state: "owner",
      posture: "observed",
      resolver: "setup_in_progress",
    },
    rendered_verdict: null,
    status: "draft",
    ...partial,
  });
}

test("sourceDetailHrefFor routes a draft connection to /connect/status/:id, not /sources/:id", () => {
  assert.equal(sourceDetailHrefFor("conn_1", draftSummary()), "/connect/status/conn_1");
  assert.equal(sourceDetailHrefFor("conn_1", summary()), "/sources/conn_1");
});

test("toSourceInstanceView projects a draft connection as pending, links /connect/status/:id, and offers Continue setup", () => {
  const view = toSourceInstanceView(draftSummary());
  assert.equal(view.detailHref, "/connect/status/conn_1");
  assert.equal(view.status.kind, "pending");
  assert.equal(view.status.label, "Setup in progress");
  assert.equal(view.revoked, false);
  // `nextAction` is null for an owner-runnable primaryVerdictAction by design
  // (`toSourceInstanceView`'s nextAction/primaryVerdictAction split, mirrored
  // from `toSourceInstanceView` above) — the passport foot renders
  // `primaryVerdictAction` for this case, not `nextAction`.
  assert.equal(view.nextAction, null);
  assert.equal(view.ownerActionCue?.label, "Continue setup");
  assert.equal(view.primaryVerdictAction?.cta, "Continue setup");
  assert.equal(view.primaryVerdictAction?.ownerRunnable, true);
});

test("toSourceInstanceView: a revoked-and-draft row (should not arise in practice) still resolves one consistent status, never a fabricated healthy read", () => {
  // owner-state.ts guarantees `retired` (revoked) outranks `setup_in_progress`
  // server-side, and `updateStatus` sets `status='revoked'` + `revoked_at`
  // together, so a real `status:'draft'` + `revoked_at` row cannot arise
  // (independent-report Adversarial check, "Revoked/draft state precedence").
  // This fixture forces the inconsistent combination anyway to pin the
  // client's actual behavior rather than assume it: `isRevokedConnector`
  // reads `status`/`revoked_at` directly and wins the `view.revoked` +
  // `view.status.kind` fields, but `sourceDetailHrefFor` keys only off
  // `owner_state.resolver` (this fixture's forced "setup_in_progress"), so
  // the href does NOT independently re-check revoked. On real data these two
  // signals never disagree; if that guarantee ever breaks, this test is the
  // one that will start failing instead of silently drifting.
  const view = toSourceInstanceView(draftSummary({ revoked_at: "2026-07-10T00:00:00Z", status: "revoked" }));
  assert.equal(view.revoked, true);
  assert.equal(view.status.kind, "revoked");
  assert.equal(view.detailHref, "/connect/status/conn_1");
});

test("toSourcesView disambiguates duplicate unnamed connections without exposing ids", () => {
  const views = toSourcesView([
    summary({
      connection_id: "cin_a",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_b",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_named",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      display_name: "Amazon - Personal",
    }),
  ]);

  assert.equal(views[0]?.displayName, "Amazon · account 1");
  assert.equal(views[1]?.displayName, "Amazon · account 2");
  assert.equal(views[0]?.accountLine, "Unnamed source · 100 records · 2 streams");
  assert.equal(views[2]?.displayName, "Amazon - Personal");
  assert.equal(views[2]?.accountLine, "100 records · 2 streams");
  assert.equal(views[2]?.listKind, null);
});

test("duplicate source review flags same-type unnamed active sources without hiding them", () => {
  const views = toSourcesView([
    summary({
      connection_id: "cin_named",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_named",
      display_name: "Amazon - Personal",
    }),
    summary({
      connection_id: "cin_a",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_a",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_b",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_b",
      display_name: "Amazon",
    }),
  ]);

  assert.equal(views.length, 3, "duplicate configured sources remain visible");
  assert.deepEqual(
    views.map((view) => view.displayName),
    ["Amazon - Personal", "Amazon · account 1", "Amazon · account 2"]
  );
  const reviews = buildDuplicateSourceReview(views);
  assert.equal(reviews.length, 1);
  assert.deepEqual(
    {
      connectorId: reviews[0]?.connectorId,
      firstUnnamedHref: reviews[0]?.firstUnnamedHref,
      kind: reviews[0]?.kind,
      total: reviews[0]?.total,
      unnamed: reviews[0]?.unnamed,
    },
    {
      connectorId: "amazon",
      firstUnnamedHref: "/sources/cin_a",
      kind: "Amazon",
      total: 3,
      unnamed: 2,
    }
  );
});

test("duplicate source review ignores revoked fallback sources", () => {
  const views = toSourcesView([
    summary({
      connection_id: "cin_active",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_active",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_revoked",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_revoked",
      display_name: "Amazon",
      revoked_at: "2026-06-17T00:00:00Z",
      status: "revoked",
    }),
  ]);

  assert.equal(buildDuplicateSourceReview(views).length, 0);
});

test("duplicate fallback collapse keeps named sources visible and groups 3+ unnamed active sources", () => {
  const views = toSourcesView([
    summary({
      connection_id: "cin_named",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_named",
      display_name: "Amazon - Personal",
    }),
    summary({
      connection_id: "cin_a",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_a",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_b",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_b",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_c",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_c",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_gmail",
      connector_display_name: "Gmail",
      connector_id: "gmail",
      connector_instance_id: "cin_gmail",
      display_name: "Gmail",
    }),
  ]);

  const collapsed = collapseDuplicateFallbackSources(views);
  assert.deepEqual(
    collapsed.visibleActiveInstances.map((view) => view.id),
    ["cin_named", "cin_gmail"]
  );
  assert.equal(collapsed.duplicateGroups.length, 1);
  assert.equal(collapsed.duplicateGroups[0]?.connectorId, "amazon");
  assert.equal(collapsed.duplicateGroups[0]?.total, 3);
  assert.deepEqual(
    collapsed.duplicateGroups[0]?.items.map((view) => view.displayName),
    ["Amazon · account 1", "Amazon · account 2", "Amazon · account 3"]
  );
});

test("duplicate fallback collapse leaves small duplicate sets visible", () => {
  const views = toSourcesView([
    summary({
      connection_id: "cin_a",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_a",
      display_name: "Amazon",
    }),
    summary({
      connection_id: "cin_b",
      connector_display_name: "Amazon",
      connector_id: "amazon",
      connector_instance_id: "cin_b",
      display_name: "Amazon",
    }),
  ]);

  const collapsed = collapseDuplicateFallbackSources(views);
  assert.deepEqual(
    collapsed.visibleActiveInstances.map((view) => view.id),
    ["cin_a", "cin_b"]
  );
  assert.equal(collapsed.duplicateGroups.length, 0);
});

test("manual/upload sources link to importing another file into the same source", () => {
  const view = toSourceInstanceView(summary({ connection_id: "cin_whatsapp_1", connector_id: "whatsapp" }), {
    manifests: [manualUploadManifest()],
  });
  assert.equal(view.manualUploadHref, "/connect/manual-upload/whatsapp?connection_id=cin_whatsapp_1");
  assert.deepEqual(
    view.passportFields.find((field) => field.k === "auth"),
    { k: "auth", value: "owner file import" }
  );
});

test("manual/upload source href is absent when the connector has no packaged import binding", () => {
  const href = manualUploadHrefForSource(summary({ connection_id: "cin_whatsapp_1", connector_id: "whatsapp" }), [
    {
      connector_id: "whatsapp",
      setup: {
        manual_or_upload: { accepted_file_extensions: [".zip"] },
        modality: "manual_or_upload",
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

// ─── total_records_state on the PRIMARY list surface (Sol fourth-verdict P1.3) ──
//
// "The main source-list view model does not [use total_records_state] —
// formatSourceListFacts always formats summary.total_records numerically
// and ignores total_records_state. That output is the visible account line
// for every source. The source passport independently renders the raw
// number." Independent probe: total_records:0, total_records_state:"stale"
// returned accountLine = "Unnamed source · 0 records · 1 stream" and
// passport records = "0" — the exact authoritative-zero failure the change
// claims to close, just relocated from the header to the primary list
// surface. These tests prove `toSourceInstanceView` — the real production
// mapping every source-list row and passport is built from — no longer
// does this, for prior-zero, prior-nonzero, unobserved/unknown, known
// zero, and known nonzero states.

test("toSourceInstanceView: accountLine renders a genuine known-nonzero count as-is", () => {
  const view = toSourceInstanceView(summary({ total_records: 42, total_records_state: "known" }));
  assert.match(view.accountLine, RECORDS_42_RE);
});

test("toSourceInstanceView: accountLine renders a genuine known_zero count as an authoritative zero", () => {
  const view = toSourceInstanceView(summary({ total_records: 0, total_records_state: "known_zero" }));
  assert.match(view.accountLine, RECORDS_0_RE);
});

test("toSourceInstanceView: accountLine marks a stale prior-NONZERO count unverified, never a bare confident number", () => {
  const view = toSourceInstanceView(summary({ total_records: 42, total_records_state: "stale" }));
  assert.match(view.accountLine, RECORDS_42_UNVERIFIED_RE);
  assert.ok(
    !RECORDS_42_BARE_RE.test(view.accountLine),
    "must not render the bare confident phrasing for a stale count"
  );
});

test("toSourceInstanceView: accountLine marks a stale prior-ZERO count unverified — the exact reproduction Sol's verdict found (Unnamed source · 0 records · 1 stream)", () => {
  const view = toSourceInstanceView(summary({ total_records: 0, total_records_state: "stale" }));
  assert.match(
    view.accountLine,
    RECORDS_0_UNVERIFIED_RE,
    "a stale carried-over zero must never render as an indistinguishable authoritative '0 records'"
  );
});

test("toSourceInstanceView: accountLine never fabricates a numeric count for unobserved/unknown states", () => {
  const unobserved = toSourceInstanceView(summary({ total_records: 0, total_records_state: "unobserved" }));
  assert.match(unobserved.accountLine, RECORDS_UNAVAILABLE_RE);
  assert.ok(!NUMERIC_RECORDS_RE.test(unobserved.accountLine));

  const unknown = toSourceInstanceView(summary({ total_records: 0, total_records_state: "unknown" }));
  assert.match(unknown.accountLine, RECORDS_UNAVAILABLE_RE);
  assert.ok(!NUMERIC_RECORDS_RE.test(unknown.accountLine));
});

test("toSourceInstanceView: accountLine preserves the exact prior always-numeric rendering when total_records_state is omitted (a reference predating this field)", () => {
  const view = toSourceInstanceView(summary({ total_records: 42, total_records_state: undefined }));
  assert.match(view.accountLine, RECORDS_42_RE);
});

test("toSourceInstanceView: the passport 'records' row renders a genuine known count as-is", () => {
  const view = toSourceInstanceView(summary({ total_records: 42, total_records_state: "known" }));
  assert.equal(passportField(view, "records"), "42");
});

test("toSourceInstanceView: the passport 'records' row marks a stale prior-nonzero count unverified, never a bare number", () => {
  const view = toSourceInstanceView(summary({ total_records: 42, total_records_state: "stale" }));
  const value = passportField(view, "records");
  assert.notEqual(value, "42", "must not render the bare number for a stale count");
  assert.match(String(value), PASSPORT_42_UNVERIFIED_RE);
});

test("toSourceInstanceView: the passport 'records' row marks a stale prior-ZERO count unverified, never an authoritative bare '0'", () => {
  const view = toSourceInstanceView(summary({ total_records: 0, total_records_state: "stale" }));
  const value = passportField(view, "records");
  assert.notEqual(
    value,
    "0",
    "the exact Sol reproduction: passport records = '0' must not happen for a stale snapshot"
  );
  assert.match(String(value), PASSPORT_0_UNVERIFIED_RE);
});

test("toSourceInstanceView: the passport 'records' row never fabricates a number for unobserved/unknown states", () => {
  const view = toSourceInstanceView(summary({ total_records: 0, total_records_state: "unobserved" }));
  assert.equal(passportField(view, "records"), "records unavailable");
});

test("toSourceInstanceView: the passport 'records' row preserves the exact prior always-numeric rendering when total_records_state is omitted", () => {
  const view = toSourceInstanceView(summary({ total_records: 42, total_records_state: undefined }));
  assert.equal(passportField(view, "records"), "42");
});
