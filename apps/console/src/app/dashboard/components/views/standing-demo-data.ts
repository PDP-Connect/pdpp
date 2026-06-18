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
import type { StandingHrefs, StandingInputs } from "./standing-view-model.ts";

export type DemoScenario = "calm" | "alarm" | "decide";

const NOW = new Date("2026-06-13T12:00:00Z");

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

const BEARERS: OwnerIssuedClient[] = [
  { client_id: "cli_claude_desktop", client_name: "Claude Desktop", active_token_count: 1, created_at: iso(40) },
  { client_id: "cli_framework", client_name: "CLI on framework", active_token_count: 2, created_at: iso(120) },
  // Worst case: a real owner bearer with NO human name — the long machine
  // client_id IS the identity and must truncate without breaking the row.
  {
    client_id: "single-use-proof-1781473829100-7f3a9c2e-b04d-4e51-9a2f-6c8e1d0b5a73",
    client_name: null,
    active_token_count: 1,
    created_at: iso(3),
  },
  // Named client whose machine id is a full OAuth client URL — name stays
  // prominent, the long id rides beneath it, truncated.
  {
    client_id: "https://chatgpt.com/connector_platform_oauth_client/2f1a8b3c-9d4e-4f0a-8c7b-1e2d3f4a5b6c",
    client_name: "ChatGPT",
    active_token_count: 4,
    created_at: iso(7),
  },
];

const GRANTS: GrantSummary[] = [
  {
    object: "grant_summary",
    grant_id: "grant_atlas",
    client_id: "Atlas Mortgage",
    connector_id: "plaid",
    status: "active",
    first_at: iso(30),
    last_at: iso(0),
    event_count: 12,
    kinds: ["pay_statements", "transactions"],
    failure: null,
  },
  {
    object: "grant_summary",
    grant_id: "grant_northstar",
    client_id: "Northstar HR",
    connector_id: "employment",
    status: "issued",
    first_at: iso(14),
    last_at: iso(2),
    event_count: 4,
    kinds: ["employment"],
    failure: null,
  },
];

const TRACES: TraceSummary[] = [
  {
    object: "trace_summary",
    trace_id: "trace_1",
    status: "succeeded",
    actor_id: "Claude Desktop",
    actor_type: "client",
    client_id: "Claude Desktop",
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: iso(0),
    last_at: iso(0),
    event_count: 412,
    kinds: ["transactions"],
    failure: null,
  },
  {
    object: "trace_summary",
    trace_id: "trace_2",
    status: "succeeded",
    actor_id: "Atlas Mortgage",
    actor_type: "client",
    client_id: "Atlas Mortgage",
    grant_id: "grant_atlas",
    run_id: null,
    request_id: null,
    first_at: iso(1),
    last_at: iso(1),
    event_count: 38,
    kinds: ["pay_statements"],
    failure: null,
  },
  {
    object: "trace_summary",
    trace_id: "trace_3",
    status: "denied",
    actor_id: "Unknown app",
    actor_type: "client",
    client_id: "Unknown app",
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: iso(2),
    last_at: iso(2),
    event_count: 0,
    kinds: ["browsing"],
    failure: { event_type: "trace.denied", reason: "scope not granted" },
  },
];

const FAILED_RUNS: RunSummary[] = [
  {
    object: "run_summary",
    run_id: "run_meridian",
    status: "failed",
    connector_id: "current_activity",
    grant_id: null,
    provider_id: null,
    first_at: iso(2),
    last_at: iso(2),
    event_count: 3,
    kinds: ["run.failed"],
    needs_input: false,
    failure_reason: "First Meridian's connection expired. Reconnect to resume syncing.",
  },
];

const PENDING: PendingApproval[] = [
  {
    object: "approval",
    approval_id: "appr_atlas",
    client_id: "Atlas Mortgage",
    created_at: iso(0),
    kind: "consent",
    user_code: "WXYZ-1234",
    grant_preview: {
      source: null,
      streams: [{ name: "pay_statements" }, { name: "employment" }, { name: "transactions" }],
    },
  },
];

const SUMMARY = {
  object: "dataset_summary" as const,
  record_count: 48_120,
  connector_count: 10,
  stream_count: 24,
  total_retained_bytes: 1_073_741_824,
  blob_bytes: 0,
  record_json_bytes: 0,
  record_changes_json_bytes: 0,
  earliest_record_time: iso(365),
  latest_record_time: iso(0),
  earliest_ingested_at: iso(365),
  latest_ingested_at: iso(0),
  top_connectors: [],
  projection: { state: "fresh" as const, computed_at: iso(0) },
};

export function buildDemoInputs(scenario: DemoScenario, hrefs: StandingHrefs): StandingInputs {
  const base: StandingInputs = {
    now: NOW,
    hrefs,
    summary: SUMMARY,
    bearerClients: BEARERS,
    grants: GRANTS,
    traces: TRACES,
    pendingApprovals: [],
    failedTraces: [],
    failedRuns: [],
    attentionConnections: [],
    overviewLoadIssues: [],
    sourceIssues: [],
  };
  if (scenario === "decide") {
    return { ...base, pendingApprovals: PENDING };
  }
  if (scenario === "alarm") {
    return {
      ...base,
      failedRuns: FAILED_RUNS,
      attentionConnections: [
        {
          connectorKey: "claude-code",
          routeId: "cin_demo_claude_code",
          deviceLocal: true,
          what: "Check the collector before this source can make progress.",
          actionLabel: "Check the collector",
        },
      ],
    };
  }
  return base;
}

export function isDemoScenario(value: string | undefined): value is DemoScenario {
  return value === "calm" || value === "alarm" || value === "decide";
}
