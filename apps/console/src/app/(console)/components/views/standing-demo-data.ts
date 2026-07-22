// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded "Standing" fixtures — DEV-ONLY screenshot review aid.
 *
 * The real Overview computes its hero tone from live state, so a freshly-set-up
 * server is almost always CALM and the alarm/decide states are hard to capture.
 * These deterministic fixtures let a reviewer see every tone without mutating
 * real data. They are gated behind `?demo=` AND `NODE_ENV !== "production"` in
 * page.tsx — the live data path never touches them.
 *
 * Each fixture returns the SAME `StandingInputs` shape the live page assembles,
 * so the exact same view-model + component render it.
 */
import type {
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RunSummary,
  TraceSummary,
} from "../../lib/ref-client.ts";
import { EMPTY_SOURCE_WORK_GROUPS } from "../../lib/source-actionability.ts";
import type { StandingHrefs, StandingInputs } from "./standing-view-model.ts";

export type DemoScenario = "calm" | "alarm" | "decide";

const NOW = new Date("2026-06-13T12:00:00Z");

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

const BEARERS: OwnerIssuedClient[] = [
  { active_token_count: 1, client_id: "cli_claude_desktop", client_name: "Claude Desktop", created_at: iso(40) },
  { active_token_count: 2, client_id: "cli_framework", client_name: "CLI on framework", created_at: iso(120) },
  // Worst case: a real owner bearer with NO human name — the long machine
  // client_id IS the identity and must truncate without breaking the row.
  {
    active_token_count: 1,
    client_id: "single-use-proof-1781473829100-7f3a9c2e-b04d-4e51-9a2f-6c8e1d0b5a73",
    client_name: null,
    created_at: iso(3),
  },
  // Named client whose machine id is a full OAuth client URL — name stays
  // prominent, the long id rides beneath it, truncated.
  {
    active_token_count: 4,
    client_id: "https://chatgpt.com/connector_platform_oauth_client/2f1a8b3c-9d4e-4f0a-8c7b-1e2d3f4a5b6c",
    client_name: "ChatGPT",
    created_at: iso(7),
  },
];

const GRANTS: GrantSummary[] = [
  {
    client_id: "Atlas Mortgage",
    connector_id: "plaid",
    event_count: 12,
    failure: null,
    first_at: iso(30),
    grant_id: "grant_atlas",
    kinds: ["pay_statements", "transactions"],
    last_at: iso(0),
    object: "grant_summary",
    status: "active",
  },
  {
    client_id: "Northstar HR",
    connector_id: "employment",
    event_count: 4,
    failure: null,
    first_at: iso(14),
    grant_id: "grant_northstar",
    kinds: ["employment"],
    last_at: iso(2),
    object: "grant_summary",
    status: "issued",
  },
];

const TRACES: TraceSummary[] = [
  {
    actor_id: "Claude Desktop",
    actor_type: "client",
    client_id: "Claude Desktop",
    event_count: 412,
    failure: null,
    first_at: iso(0),
    grant_id: null,
    kinds: ["transactions"],
    last_at: iso(0),
    object: "trace_summary",
    request_id: null,
    run_id: null,
    status: "succeeded",
    trace_id: "trace_1",
  },
  {
    actor_id: "Atlas Mortgage",
    actor_type: "client",
    client_id: "Atlas Mortgage",
    event_count: 38,
    failure: null,
    first_at: iso(1),
    grant_id: "grant_atlas",
    kinds: ["pay_statements"],
    last_at: iso(1),
    object: "trace_summary",
    request_id: null,
    run_id: null,
    status: "succeeded",
    trace_id: "trace_2",
  },
  {
    actor_id: "Unknown app",
    actor_type: "client",
    client_id: "Unknown app",
    event_count: 0,
    failure: { event_type: "trace.denied", reason: "scope not granted" },
    first_at: iso(2),
    grant_id: null,
    kinds: ["browsing"],
    last_at: iso(2),
    object: "trace_summary",
    request_id: null,
    run_id: null,
    status: "denied",
    trace_id: "trace_3",
  },
];

const FAILED_RUNS: RunSummary[] = [
  {
    connector_id: "current_activity",
    event_count: 3,
    failure_reason: "First Meridian's connection expired. Reconnect to resume syncing.",
    first_at: iso(2),
    grant_id: null,
    kinds: ["run.failed"],
    last_at: iso(2),
    needs_input: false,
    object: "run_summary",
    provider_id: null,
    run_id: "run_meridian",
    status: "failed",
  },
];

const PENDING: PendingApproval[] = [
  {
    approval_id: "appr_atlas",
    client_id: "Atlas Mortgage",
    created_at: iso(0),
    grant_preview: {
      source: null,
      streams: [{ name: "pay_statements" }, { name: "employment" }, { name: "transactions" }],
    },
    kind: "consent",
    object: "approval",
    user_code: "WXYZ-1234",
  },
];

const SUMMARY = {
  blob_bytes: 0,
  connector_count: 10,
  earliest_ingested_at: iso(365),
  earliest_record_time: iso(365),
  latest_ingested_at: iso(0),
  latest_record_time: iso(0),
  object: "dataset_summary" as const,
  projection: { computed_at: iso(0), state: "fresh" as const },
  record_changes_json_bytes: 0,
  record_count: 48_120,
  record_json_bytes: 0,
  stream_count: 24,
  top_connectors: [],
  total_retained_bytes: 1_073_741_824,
};

export function buildDemoInputs(scenario: DemoScenario, hrefs: StandingHrefs): StandingInputs {
  const base: StandingInputs = {
    advisoryOwnerActions: [],
    attentionConnections: [],
    bearerClients: BEARERS,
    failedRuns: [],
    failedTraces: [],
    grants: GRANTS,
    hrefs,
    now: NOW,
    overviewLoadIssues: [],
    pendingApprovals: [],
    sourceIssues: [],
    sourceWork: EMPTY_SOURCE_WORK_GROUPS,
    summary: SUMMARY,
    traces: TRACES,
  };
  if (scenario === "decide") {
    return { ...base, pendingApprovals: PENDING };
  }
  if (scenario === "alarm") {
    return {
      ...base,
      attentionConnections: [
        {
          actionLabel: "Check the collector",
          connectorKey: "claude-code",
          deviceLocal: true,
          label: "Claude Code on workstation",
          routeId: "cin_demo_claude_code",
          what: "Check the collector before this source can make progress.",
        },
      ],
      failedRuns: FAILED_RUNS,
    };
  }
  return base;
}

export function isDemoScenario(value: string | undefined): value is DemoScenario {
  return value === "calm" || value === "alarm" || value === "decide";
}
