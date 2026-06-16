import assert from "node:assert/strict";
import test from "node:test";
import type {
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RunSummary,
  TraceSummary,
} from "../../lib/ref-client.ts";
import type { RefConnectorSummary } from "../../lib/ref-client.ts";
import {
  attentionConnectionsFromConnectors,
  buildStandingData,
  computeHero,
  grantEndorseStatus,
  grantReads,
  joinHuman,
  relDay,
  type StandingHrefs,
  type StandingInputs,
  scopeHuman,
} from "./standing-view-model.ts";

const HREFS: StandingHrefs = {
  grants: "/dashboard/grants",
  runs: "/dashboard/runs",
  traces: "/dashboard/traces",
  deployment: "/dashboard/deployment",
  deploymentTokens: "/dashboard/deployment/tokens",
  connection: (id) => `/dashboard/records/${id}`,
  grant: (id) => `/dashboard/grants/${id}`,
  run: (id) => `/dashboard/runs/${id}`,
  trace: (id) => `/dashboard/traces/${id}`,
};

const NOW = new Date("2026-06-13T12:00:00Z");

const CALM_SUB_RE = /1 token can act as you/;
const BEARER_HOW_RE = /2 active tokens/;
const LATELY_READ_RE = /read 412 records/;

function baseInputs(over: Partial<StandingInputs> = {}): StandingInputs {
  return {
    now: NOW,
    hrefs: HREFS,
    summary: {
      object: "dataset_summary",
      record_count: 48_120,
      connector_count: 10,
      stream_count: 24,
      total_retained_bytes: 0,
      blob_bytes: 0,
      record_json_bytes: 0,
      record_changes_json_bytes: 0,
      earliest_record_time: null,
      latest_record_time: null,
      earliest_ingested_at: null,
      latest_ingested_at: null,
      top_connectors: [],
      projection: { state: "fresh" },
    },
    bearerClients: [],
    grants: [],
    traces: [],
    pendingApprovals: [],
    failedTraces: [],
    failedRuns: [],
    attentionConnections: [],
    ...over,
  };
}

// ─── scope → human lexicon (honest fallback) ──────────────────────

test("scopeHuman maps known scopes and strips .read + connector prefix", () => {
  assert.equal(scopeHuman("pay_statements.read"), "your pay");
  assert.equal(scopeHuman("transactions"), "your spending");
  assert.equal(scopeHuman("chase:transactions"), "your spending");
});

test("scopeHuman falls back to a spaced name when no mapping is honest", () => {
  assert.equal(scopeHuman("loyalty_points.read"), "loyalty points");
  assert.equal(scopeHuman("weird_stream"), "weird stream");
});

test("joinHuman uses an Oxford-comma join", () => {
  assert.equal(joinHuman(["a"]), "a");
  assert.equal(joinHuman(["a", "b"]), "a and b");
  assert.equal(joinHuman(["a", "b", "c"]), "a, b, and c");
});

// ─── grant vocab → endorse status ─────────────────────────────────

test("grantEndorseStatus collapses the live vocab to active", () => {
  for (const s of ["succeeded", "issued", "approved", "active"]) {
    assert.equal(grantEndorseStatus(s), "active");
  }
  assert.equal(grantEndorseStatus("revoked"), "revoked");
  assert.equal(grantEndorseStatus("denied"), "denied");
});

test("grantReads humanizes kinds, falls back to connector, then generic", () => {
  const withKinds = { kinds: ["pay_statements", "transactions"], connector_id: "plaid" } as GrantSummary;
  assert.equal(grantReads(withKinds), "reads only your pay and your spending");
  const onlyConnector = { kinds: ["read"], connector_id: "employment" } as GrantSummary;
  assert.equal(grantReads(onlyConnector), "reads only your employment history");
  const nothing = { kinds: [], connector_id: null } as unknown as GrantSummary;
  assert.equal(grantReads(nothing), "reads a scoped slice of your data");
});

// ─── relative time ────────────────────────────────────────────────

test("relDay produces calm relative labels", () => {
  assert.equal(relDay("2026-06-13T08:00:00Z", NOW), "today");
  assert.equal(relDay("2026-06-12T08:00:00Z", NOW), "yesterday");
  assert.equal(relDay("2026-06-10T08:00:00Z", NOW), "3 days ago");
  assert.equal(relDay("2026-01-01T08:00:00Z", NOW), "2026-01-01");
  assert.equal(relDay(null, NOW), "—");
});

// ─── hero tone precedence ─────────────────────────────────────────

test("hero is DECIDE when an approval is pending", () => {
  const pending: PendingApproval = {
    object: "approval",
    approval_id: "a1",
    client_id: "Atlas Mortgage",
    created_at: NOW.toISOString(),
    kind: "consent",
    grant_preview: { streams: [{ name: "pay_statements" }, { name: "transactions" }] },
  };
  const hero = computeHero(baseInputs({ pendingApprovals: [pending] }));
  assert.equal(hero.tone, "decide");
  assert.equal(hero.line.emphasis, "your pay and your spending");
  assert.equal(hero.cta?.href, HREFS.grants);
});

test("hero is ALARM when a connection needs the owner; single → CTA routes to its recovery panel, NOT /traces", () => {
  const alarm = computeHero(
    baseInputs({
      attentionConnections: [
        { connectorKey: "claude-code", what: "Check the collector before this source can make progress.", actionLabel: "Check the collector" },
      ],
    })
  );
  assert.equal(alarm.tone, "alarm");
  assert.equal(alarm.kicker, "One thing needs you");
  // The fix: the CTA lands on the focused recovery panel, never the audit log.
  assert.equal(alarm.cta?.href, HREFS.connection("claude-code"));
  assert.notEqual(alarm.cta?.href, HREFS.traces);
  // The CTA verb is the owner-resolvable action, and the sub names the real condition.
  assert.equal(alarm.cta?.label, "Check the collector");
  assert.match(alarm.sub, /Check the collector/);
});

test("hero ALARM with several attention connections → CTA routes to the syncs triage list, not /traces", () => {
  const alarm = computeHero(
    baseInputs({
      attentionConnections: [
        { connectorKey: "claude-code", what: "Check the collector.", actionLabel: "Check the collector" },
        { connectorKey: "chase", what: "Reconnect Chase.", actionLabel: "Reconnect" },
      ],
    })
  );
  assert.equal(alarm.tone, "alarm");
  assert.equal(alarm.kicker, "2 things need you");
  assert.equal(alarm.cta?.href, HREFS.runs);
  assert.notEqual(alarm.cta?.href, HREFS.traces);
});

test("failed runs/traces alone do NOT drive the alarm — only the rendered-verdict attention set does", () => {
  // The old bug: a failed YNAB trace inflated the alarm while YNAB was healthy.
  const run = { run_id: "r1", connector_id: "current_activity", failure_reason: "expired" } as RunSummary;
  const trace = { trace_id: "t1", client_id: "ynab" } as TraceSummary;
  const hero = computeHero(baseInputs({ failedRuns: [run], failedTraces: [trace], attentionConnections: [] }));
  assert.notEqual(hero.tone, "alarm");
});

test("decide wins over alarm", () => {
  const pending = {
    object: "approval",
    approval_id: "a1",
    created_at: NOW.toISOString(),
    kind: "consent",
  } as PendingApproval;
  const both = computeHero(
    baseInputs({
      attentionConnections: [{ connectorKey: "chase", what: "x", actionLabel: "Reconnect" }],
      pendingApprovals: [pending],
    })
  );
  assert.equal(both.tone, "decide");
});

// ─── attention truth (the single source the hero + /runs share) ───────────

function connector(over: Partial<RefConnectorSummary>): RefConnectorSummary {
  return {
    connection_health: {} as RefConnectorSummary["connection_health"],
    connection_id: "cin_x",
    connector_id: "claude-code",
    display_name: "Claude Code",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    schedule: null,
    streams: [],
    total_records: 0,
    ...over,
  };
}

function verdict(over: Partial<NonNullable<RefConnectorSummary["rendered_verdict"]>>): RefConnectorSummary["rendered_verdict"] {
  return {
    channel: "attention",
    pill: { label: "Can't collect", tone: "red" },
    forward_statement: "Check the collector before this source can make progress.",
    required_actions: [
      { affects: [], audience: "owner", cta: "Check the collector", kind: "add_info", satisfied_when: { kind: "attention_resolved" }, terminal: false, urgency: "now" },
    ],
    annotations: [],
    detail: undefined,
    ...over,
  } as RefConnectorSummary["rendered_verdict"];
}

test("attention truth: only attention-channel connections with an owner-satisfiable action count", () => {
  const connectors: RefConnectorSummary[] = [
    connector({ connector_id: "claude-code", rendered_verdict: verdict({}) }), // ✓ attention + owner action
    connector({ connector_id: "calm-source", rendered_verdict: verdict({ channel: "calm" }) }), // ✗ calm
    connector({ connector_id: "ynab", rendered_verdict: null }), // ✗ no verdict (e.g. healthy)
    connector({
      connector_id: "maintainer-only",
      rendered_verdict: verdict({
        required_actions: [
          { affects: [], audience: "maintainer", cta: "Connector code needs a fix", kind: "code_fix", satisfied_when: { kind: "none" }, terminal: true, urgency: "now" },
        ],
      }),
    }), // ✗ attention but no owner-satisfiable action (S1 — code_fix is the maintainer's, not the owner's)
    connector({ connector_id: "revoked", revoked_at: "2026-06-01T00:00:00Z", rendered_verdict: verdict({}) }), // ✗ revoked
  ];
  const attention = attentionConnectionsFromConnectors(connectors);
  assert.deepEqual(
    attention.map((a) => a.connectorKey),
    ["claude-code"]
  );
  assert.equal(attention[0]?.actionLabel, "Check the collector");
  assert.equal(attention[0]?.what, "Check the collector before this source can make progress.");
});

test("hero ALARMs on a stale projection even with no failures", () => {
  const stale = baseInputs();
  stale.summary = { ...stale.summary, projection: { state: "stale" } } as StandingInputs["summary"];
  const hero = computeHero(stale);
  assert.equal(hero.tone, "alarm");
});

test("hero is CALM with reassurance when all is well", () => {
  const clients: OwnerIssuedClient[] = [
    { client_id: "c1", client_name: "Claude Desktop", active_token_count: 1, created_at: NOW.toISOString() },
  ];
  const hero = computeHero(baseInputs({ bearerClients: clients }));
  assert.equal(hero.tone, "calm");
  assert.equal(hero.line.emphasis, "all yours to read");
  assert.match(hero.sub, CALM_SUB_RE);
});

// ─── full builder ─────────────────────────────────────────────────

test("buildStandingData wires bearers, relationships, lately, attention", () => {
  const clients: OwnerIssuedClient[] = [
    { client_id: "c1", client_name: "Claude Desktop", active_token_count: 2, created_at: "2026-06-01T00:00:00Z" },
  ];
  const grant: GrantSummary = {
    object: "grant_summary",
    grant_id: "g1",
    client_id: "Atlas Mortgage",
    connector_id: "plaid",
    status: "active",
    first_at: "2026-06-01T00:00:00Z",
    last_at: "2026-06-12T00:00:00Z",
    event_count: 5,
    kinds: ["pay_statements"],
    failure: null,
  };
  const readTrace: TraceSummary = {
    object: "trace_summary",
    trace_id: "t1",
    status: "succeeded",
    actor_id: "Claude Desktop",
    actor_type: "client",
    client_id: "Claude Desktop",
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: "2026-06-13T00:00:00Z",
    last_at: "2026-06-13T00:00:00Z",
    event_count: 412,
    kinds: ["transactions"],
    failure: null,
  };
  const data = buildStandingData(baseInputs({ bearerClients: clients, grants: [grant], traces: [readTrace] }));
  assert.equal(data.bearers.length, 1);
  assert.match(data.bearers[0]?.how ?? "", BEARER_HOW_RE);
  assert.equal(data.relationships.length, 1);
  assert.equal(data.relationships[0]?.reads, "reads only your pay");
  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.deny, false);
  assert.match(data.lately[0]?.text.rest ?? "", LATELY_READ_RE);
  assert.equal(data.attention.length, 0);
});

test("revoked grants are excluded from relationships", () => {
  const revoked: GrantSummary = {
    object: "grant_summary",
    grant_id: "g2",
    client_id: "Old App",
    connector_id: null,
    status: "revoked",
    first_at: "2026-05-01T00:00:00Z",
    last_at: "2026-05-02T00:00:00Z",
    event_count: 0,
    kinds: [],
    failure: null,
  };
  const data = buildStandingData(baseInputs({ grants: [revoked] }));
  assert.equal(data.relationships.length, 0);
});
