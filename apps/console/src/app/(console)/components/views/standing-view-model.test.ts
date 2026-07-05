import assert from "node:assert/strict";
import test from "node:test";
import type {
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RefConnectorSummary,
  RunSummary,
  TraceSummary,
} from "../../lib/ref-client.ts";
import {
  EMPTY_SOURCE_WORK_GROUPS,
  sourceAttentionHeadline,
  sourceWorkFromConnectors,
} from "../../lib/source-actionability.ts";
import {
  advisoryOwnerActionsFromConnectors,
  attentionConnectionsFromConnectors,
  BEARER_PREVIEW_LIMIT,
  buildStandingData,
  computeHero,
  grantEndorseStatus,
  grantReads,
  joinHuman,
  relDay,
  type StandingHrefs,
  type StandingInputs,
  scopeHuman,
  sourceIssueConnectionsFromConnectors,
} from "./standing-view-model.ts";

const HREFS: StandingHrefs = {
  grants: "/grants",
  grantPackages: "/grants/packages",
  notifications: "/notifications",
  runs: "/syncs",
  sources: "/sources",
  traces: "/audit",
  deployment: "/deployment",
  deploymentTokens: "/deployment/tokens",
  connection: (id) => `/sources/${id}`,
  grant: (id) => `/grants/${id}`,
  run: (id) => `/syncs/${id}`,
  trace: (id) => `/audit/${id}`,
};

const NOW = new Date("2026-06-13T12:00:00Z");

const CALM_SUB_RE = /1 client holds 1 active owner token/;
const BEARER_HOW_RE = /2 active tokens/;
const BEARER_HOW_HAS_ISSUED_RE = /issued/;
const BEARER_HOW_HAS_DATE_RE = /\d{4}-\d{2}-\d{2}/;
const BULK_WRITE_UNKNOWN_CONNECTION_RE = /bulk write on unknown connection/;
const CODE_FIX_RE = /code fix/;
const DID_NOT_LOAD_RE = /did not load/;
const EXPIRED_OR_CREDENTIAL_RE = /grant had expired|you never allowed it|state_expired|github_credential/;
const INCOMPLETE_OR_GAP_RE = /incomplete|gap/;
const LATELY_READ_RE = /read 412 records/;
const LATEST_SAVED_POSTS_RE = /latest saved posts/;
const MAINTAINER_ACTION_RE = /maintainer action/;
const NO_OWNER_TOKEN_RE = /No owner token can act as you yet/;
const NOT_ALL_YOURS_RE = /all yours to read/i;
const NOT_NEEDS_YOU_RE = /needs you/i;
const OWNER_TOKEN_COUNT_RE = /1 client holds 2 active owner tokens/;
const PROJECTION_COPY_RE = /projection|rebuild|bulk write|unknown connection/i;
const PROJECTION_SQL_COPY_RE = /projection|rebuild|bulk write|unknown connection|SQL/i;
const RAW_ORPHANED_RUN_RE = /orphaned_started_run/;
const RAW_REASON_CODE_RE = /new_internal_reason_code/;
const REFRESH_PAGE_RE = /Refresh this page/;
const SAVED_RECORDS_RE = /saved records/;
const SQL_FAILED_RE = /SQL failed/;
const STALE_TOTALS_RE = /last completed update/;
const TOKEN_OVERCOUNT_RE = /2 tokens can act as you/;
const WILL_NOT_CLAIM_ALL_CLEAR_RE = /will not claim all-clear from partial data/;

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
    sourceWork: EMPTY_SOURCE_WORK_GROUPS,
    advisoryOwnerActions: [],
    attentionConnections: [],
    overviewLoadIssues: [],
    sourceIssues: [],
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

test("grantReads humanizes protocol audit stream names instead of raw event ids", () => {
  const auditGrant = {
    kinds: ["consent.approved", "token.issued", "query.received", "disclosure.served", "query.rejected"],
    connector_id: "pdpp",
  } as GrantSummary;

  assert.equal(
    grantReads(auditGrant),
    "reads only grant decisions, token activity, read requests, data disclosures, and rejected reads"
  );
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

test("hero ALARM for a DEVICE-LOCAL recovery: CTA NAVIGATES (does not restate the action)", () => {
  // Device-local recovery cannot run from the dashboard. The CTA must read as
  // navigation, route to the recovery panel (exact connection), and leave the
  // actual host command in the panel.
  const alarm = computeHero(
    baseInputs({
      attentionConnections: [
        {
          connectorKey: "claude-code",
          routeId: "ci_peregrine",
          deviceLocal: true,
          label: "peregrine Claude Code",
          what: "The local collector has saved records on its host that did not upload to this server.",
          actionLabel: "Recover local collector uploads",
        },
      ],
    })
  );
  assert.equal(alarm.tone, "alarm");
  assert.equal(alarm.kicker, "One thing needs you");
  assert.equal(alarm.line.text, "peregrine Claude Code ");
  assert.equal(alarm.cta?.href, HREFS.connection("ci_peregrine"));
  assert.notEqual(alarm.cta?.href, HREFS.traces);
  // The CTA is a NAVIGATION label, NOT the restated device action.
  assert.equal(alarm.cta?.label, "See what to do");
  assert.notEqual(alarm.cta?.label, "Recover local collector uploads");
  // The real condition still appears in the sub line.
  assert.match(alarm.sub, SAVED_RECORDS_RE);
});

test("hero ALARM for a DASHBOARD-ACTIONABLE recovery keeps its action verb", () => {
  // A reconnect/refresh the dashboard CAN initiate keeps its action label.
  const alarm = computeHero(
    baseInputs({
      attentionConnections: [
        {
          connectorKey: "chase",
          routeId: "cin_chase",
          deviceLocal: false,
          label: "Chase - Personal",
          what: "Reconnect Chase.",
          actionLabel: "Reconnect",
        },
      ],
    })
  );
  assert.equal(alarm.cta?.label, "Reconnect");
});

test("hero ALARM with several attention connections → CTA routes to the syncs triage list, not /traces", () => {
  const alarm = computeHero(
    baseInputs({
      attentionConnections: [
        {
          connectorKey: "claude-code",
          routeId: "ci_peregrine",
          deviceLocal: true,
          label: "peregrine Claude Code",
          what: "Check the collector.",
          actionLabel: "Check the collector",
        },
        {
          connectorKey: "chase",
          routeId: "cin_chase",
          deviceLocal: false,
          label: "Chase - Personal",
          what: "Reconnect Chase.",
          actionLabel: "Reconnect",
        },
      ],
    })
  );
  assert.equal(alarm.tone, "alarm");
  assert.equal(alarm.kicker, "2 things need you");
  assert.equal(alarm.cta?.href, HREFS.runs);
  assert.notEqual(alarm.cta?.href, HREFS.traces);
});

test("failed syncs/traces alone do NOT drive the alarm — only the rendered-verdict attention set does", () => {
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
      attentionConnections: [
        {
          connectorKey: "chase",
          routeId: "cin_chase",
          deviceLocal: false,
          label: "Chase - Personal",
          what: "x",
          actionLabel: "Reconnect",
        },
      ],
      pendingApprovals: [pending],
    })
  );
  assert.equal(both.tone, "decide");
});

// ─── attention truth (the single source the hero + /runs share) ───────────

function connector(over: Partial<RefConnectorSummary>): RefConnectorSummary {
  return {
    connection_health: legacyHealth("healthy"),
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

function legacyHealth(
  state: RefConnectorSummary["connection_health"]["state"]
): RefConnectorSummary["connection_health"] {
  return {
    axes: {
      attention: "none",
      coverage: "unknown",
      freshness: "unknown",
      outbox: "unknown",
    },
    badges: { stale: false, syncing: false },
    last_success_at: null,
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state,
    unknown_reasons: [],
  };
}

function verdict(
  over: Partial<NonNullable<RefConnectorSummary["rendered_verdict"]>>
): RefConnectorSummary["rendered_verdict"] {
  return {
    channel: "attention",
    pill: { label: "Can't collect", tone: "red" },
    forward_statement: "Check the collector before this source can make progress.",
    required_actions: [
      {
        affects: [],
        audience: "owner",
        cta: "Check the collector",
        kind: "add_info",
        satisfied_when: { kind: "attention_resolved" },
        terminal: false,
        urgency: "now",
        remediation: {
          cause: "dead_letter_backlog",
          commands: [],
          kind: "local_collector_recovery",
          label: "Recover local collector uploads",
          summary: "The local collector has saved records on its host that did not upload to this server.",
          target: { identity_source: "source_instance_bindings", kind: "local_device" },
        },
      },
    ],
    annotations: [],
    detail: undefined,
    ...over,
  } as RefConnectorSummary["rendered_verdict"];
}

test("attention truth: only attention-channel connections with an owner-satisfiable action count", () => {
  const connectors: RefConnectorSummary[] = [
    connector({ connector_id: "claude-code", connection_id: "cin_peregrine", rendered_verdict: verdict({}) }), // ✓ attention + owner action
    connector({ connector_id: "calm-source", rendered_verdict: verdict({ channel: "calm" }) }), // ✗ calm
    connector({ connector_id: "ynab", rendered_verdict: null }), // ✗ no verdict (e.g. healthy)
    connector({
      connector_id: "maintainer-only",
      rendered_verdict: verdict({
        required_actions: [
          {
            affects: [],
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
            urgency: "now",
          },
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
  // The local_device remediation target → deviceLocal true → hero/runs use a
  // navigation CTA instead of restating the action.
  assert.equal(attention[0]?.deviceLocal, true);
});

test("attention truth falls back to legacy blocked health when rendered verdict is absent", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "chase",
      connection_id: "cin_chase",
      connection_health: legacyHealth("blocked"),
      display_name: "Chase",
      rendered_verdict: null,
    }),
  ];

  const attention = attentionConnectionsFromConnectors(connectors);
  assert.equal(attention.length, 1);
  assert.equal(attention[0]?.connectorKey, "chase");
  assert.equal(attention[0]?.routeId, "cin_chase");
  assert.equal(attention[0]?.actionLabel, "Reconnect");

  const hero = computeHero(baseInputs({ attentionConnections: attention }));
  assert.equal(hero.tone, "alarm");
});

test("source issues show non-owner material verdicts without alarming as owner attention", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "chase",
      connection_id: "cin_chase",
      display_name: "Chase",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Can't collect", tone: "red" },
        forward_statement: "This connector needs a code fix before it can collect again.",
        required_actions: [
          {
            affects: [],
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
            urgency: "now",
          },
        ],
      }),
    }),
    connector({
      connector_id: "healthy",
      rendered_verdict: verdict({ channel: "calm", pill: { label: "Healthy", tone: "green" } }),
    }),
    connector({
      connector_id: "revoked",
      revoked_at: "2026-06-01T00:00:00Z",
      rendered_verdict: verdict({ pill: { label: "Can't collect", tone: "red" } }),
    }),
  ];

  assert.equal(attentionConnectionsFromConnectors(connectors).length, 0);

  const sourceIssues = sourceIssueConnectionsFromConnectors(connectors);
  assert.equal(sourceIssues.length, 1);
  assert.equal(sourceIssues[0]?.label, "Chase");
  assert.equal(sourceIssues[0]?.status, "can't collect");
  assert.equal(sourceIssues[0]?.routeId, "cin_chase");

  const data = buildStandingData(baseInputs({ sourceIssues }));
  assert.equal(data.attention.length, 0);
  assert.equal(data.sourceIssues.length, 1);
  assert.equal(data.sourceIssues[0]?.what, "Chase can't collect");
  assert.match(data.sourceIssues[0]?.why ?? "", CODE_FIX_RE);
});

test("advisory owner actions surface non-urgent Amazon retry work without calm all-clear copy", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "amazon",
      connection_id: "cin_amazon",
      display_name: "Amazon - Personal",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Degraded", tone: "amber" },
        forward_statement: "Some order detail is still outstanding. Retry this source to collect the missing detail.",
        required_actions: [
          {
            affects: ["orders"],
            audience: "owner",
            cta: "Retry detail gap",
            kind: "retry_gap",
            satisfied_when: { kind: "gap_recovered" },
            terminal: false,
            urgency: "soon",
          },
        ],
      }),
    }),
  ];

  const advisoryOwnerActions = advisoryOwnerActionsFromConnectors(connectors);
  assert.equal(attentionConnectionsFromConnectors(connectors).length, 0);
  assert.equal(advisoryOwnerActions.length, 1);
  assert.equal(advisoryOwnerActions[0]?.actionLabel, "Retry detail gap");

  const data = buildStandingData(baseInputs({ advisoryOwnerActions }));
  assert.equal(data.hero.tone, "decide");
  assert.equal(data.hero.kicker, "One optional action is available");
  assert.equal(data.hero.line.emphasis, "Retry detail gap");
  assert.equal(data.hero.line.text, "Amazon - Personal: ");
  assert.equal(data.hero.cta?.label, "Retry detail gap");
  assert.equal(data.hero.cta?.href, HREFS.connection("cin_amazon"));
  assert.doesNotMatch(`${data.hero.kicker} ${data.hero.line.text} ${data.hero.line.emphasis}`, NOT_NEEDS_YOU_RE);
  assert.doesNotMatch(
    `${data.hero.kicker} ${data.hero.line.text} ${data.hero.line.emphasis ?? ""} ${data.hero.line.tail ?? ""}`,
    NOT_ALL_YOURS_RE
  );
  assert.equal(data.advisoryOwnerActions.length, 1);
  assert.equal(data.advisoryOwnerActions[0]?.what, "Amazon - Personal has an action to review");
});

test("advisory owner actions surface Reddit refresh work in the home summary", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "reddit",
      connection_id: "cin_reddit",
      display_name: "Reddit",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Healthy", tone: "green" },
        forward_statement: "Run a refresh when you want the latest saved posts.",
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
    }),
  ];

  const advisoryOwnerActions = advisoryOwnerActionsFromConnectors(connectors);
  const data = buildStandingData(baseInputs({ advisoryOwnerActions }));
  assert.equal(data.advisoryOwnerActions.length, 1);
  assert.equal(data.advisoryOwnerActions[0]?.href, HREFS.connection("cin_reddit"));
  assert.match(data.advisoryOwnerActions[0]?.why ?? "", LATEST_SAVED_POSTS_RE);
  assert.notEqual(data.hero.tone, "calm");
});

test("source actionability groups live-shaped rows with scoped counts", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "chatgpt",
      connection_id: "cin_chatgpt",
      display_name: "ChatGPT - personal",
      rendered_verdict: verdict({
        channel: "attention",
        pill: { label: "Can't collect", tone: "red" },
        forward_statement: "Reconnect this account and collection resumes.",
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
    }),
    connector({
      connector_id: "usaa",
      connection_id: "cin_usaa",
      display_name: "USAA - Personal",
      rendered_verdict: verdict({
        channel: "attention",
        pill: { label: "Can't collect", tone: "red" },
        forward_statement: "Reconnect this account and collection resumes.",
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
    }),
    connector({
      connector_id: "claude-code",
      connection_id: "cin_claude",
      display_name: "Local Claude Code",
      rendered_verdict: verdict({}),
    }),
    connector({
      connector_id: "amazon",
      connection_id: "cin_amazon",
      display_name: "Amazon - Personal",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Degraded", tone: "amber" },
        forward_statement: "Run a refresh to bring this up to date.",
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
    }),
    connector({
      connector_id: "chase",
      connection_id: "cin_chase",
      display_name: "Chase - Personal",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Degraded", tone: "amber" },
        forward_statement: "Latest collection completed with known coverage gaps.",
        required_actions: [
          {
            affects: [],
            audience: "maintainer",
            cta: "Coverage gap needs review",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
            urgency: "soon",
          },
        ],
      }),
    }),
    connector({
      connector_id: "github",
      connection_id: "cin_github",
      display_name: "GitHub - Personal",
      rendered_verdict: verdict({
        channel: "calm",
        pill: { label: "Checking", tone: "grey" },
        forward_statement: "Checking coverage before deciding what the next run should do.",
        required_actions: [],
      }),
    }),
  ];

  const sourceWork = sourceWorkFromConnectors(connectors);
  const data = buildStandingData(baseInputs({ sourceWork }));

  assert.equal(sourceWork.needsOwner.length, 3);
  assert.equal(sourceWork.review.length, 1);
  assert.equal(sourceWork.systemIssues.length, 1);
  assert.equal(sourceWork.checking.length, 1);
  assert.equal(sourceAttentionHeadline(sourceWork).needsYou, sourceWork.needsOwner.length);
  assert.equal(data.hero.tone, "alarm");
  assert.equal(data.hero.kicker, "3 things need you");
  assert.equal(data.sourceWorkSections[0]?.title, "Needs you");
  assert.equal(data.sourceWorkSections[0]?.countLabel, "3 sources");
  assert.equal(data.sourceWorkSections[0]?.rows.length, 3);
  assert.equal(data.sourceWorkSections[1]?.title, "Available actions");
  assert.equal(data.sourceWorkSections[1]?.countLabel, "1 source");
  assert.equal(data.sourceWorkSections[2]?.title, "System or connector issue");
  assert.equal(data.sourceWorkSections[3]?.title, "Checking");
});

test("reviewable degraded source appears once rather than as review plus source issue", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "amazon",
      connection_id: "cin_amazon",
      display_name: "Amazon - Personal",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Degraded", tone: "amber" },
        forward_statement: "Retry now to give the recoverable gap another run.",
        required_actions: [
          {
            affects: [],
            audience: "owner",
            cta: "Retry now",
            kind: "retry_gap",
            satisfied_when: { kind: "gap_recovered" },
            terminal: false,
            urgency: "soon",
          },
        ],
      }),
    }),
  ];

  const sourceWork = sourceWorkFromConnectors(connectors);
  const data = buildStandingData(baseInputs({ sourceWork }));
  const rows = data.sourceWorkSections.flatMap((section) => section.rows);

  assert.equal(sourceWork.review.length, 1);
  assert.equal(sourceWork.systemIssues.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.what, "Amazon - Personal: Retry now");
});

test("source actionability follows primary-action parity with push policy", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "mixed",
      connection_id: "cin_mixed",
      display_name: "Mixed-action source",
      rendered_verdict: verdict({
        channel: "attention",
        pill: { label: "Can't collect", tone: "red" },
        forward_statement: "Connector code needs a fix before this can collect again.",
        required_actions: [
          {
            affects: [],
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
            urgency: "now",
          },
          {
            affects: [],
            audience: "owner",
            cta: "Reconnect this account",
            kind: "reauth",
            satisfied_when: { kind: "credential_present_and_unrejected" },
            terminal: false,
            urgency: "soon",
          },
        ],
      }),
    }),
  ];

  const sourceWork = sourceWorkFromConnectors(connectors);
  assert.equal(sourceWork.needsOwner.length, 0);
  assert.equal(sourceWork.review.length, 0);
  assert.equal(sourceWork.systemIssues.length, 1);
  assert.equal(sourceWork.systemIssues[0]?.label, "Mixed-action source");
});

test("maintainer-only actions are not advisory owner actions", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "maintainer-only",
      connection_id: "cin_maintainer",
      display_name: "Maintainer-only source",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Degraded", tone: "amber" },
        forward_statement: "This source needs a connector code fix before it can make progress.",
        required_actions: [
          {
            affects: [],
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
            urgency: "now",
          },
        ],
      }),
    }),
  ];

  assert.equal(advisoryOwnerActionsFromConnectors(connectors).length, 0);
  assert.equal(attentionConnectionsFromConnectors(connectors).length, 0);
  assert.equal(sourceIssueConnectionsFromConnectors(connectors).length, 1);
});

test("source issues omit healthy advisory refresh hints", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "reddit",
      connection_id: "cin_reddit",
      display_name: "Reddit - dondochaka",
      rendered_verdict: verdict({
        channel: "advisory",
        pill: { label: "Healthy", tone: "green" },
        forward_statement: "Run a refresh to bring this up to date.",
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
    }),
  ];

  assert.equal(attentionConnectionsFromConnectors(connectors).length, 0);
  assert.equal(sourceIssueConnectionsFromConnectors(connectors).length, 0);
  assert.equal(advisoryOwnerActionsFromConnectors(connectors).length, 1);

  const data = buildStandingData(baseInputs({ sourceIssues: sourceIssueConnectionsFromConnectors(connectors) }));
  assert.equal(data.sourceIssues.length, 0);
});

test("source issues surface attention verdicts that have no owner action, even with a green pill", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "maintainer-only",
      connection_id: "cin_maintainer",
      display_name: "Maintainer-only source",
      rendered_verdict: verdict({
        channel: "attention",
        pill: { label: "Healthy", tone: "green" },
        forward_statement: "This source needs a maintainer action before it can make progress.",
        required_actions: [
          {
            affects: [],
            audience: "maintainer",
            cta: "Connector code needs a fix",
            kind: "code_fix",
            satisfied_when: { kind: "none" },
            terminal: true,
            urgency: "now",
          },
        ],
      }),
    }),
  ];

  assert.equal(attentionConnectionsFromConnectors(connectors).length, 0);

  const sourceIssues = sourceIssueConnectionsFromConnectors(connectors);
  assert.equal(sourceIssues.length, 1);
  assert.equal(sourceIssues[0]?.label, "Maintainer-only source");
  assert.equal(sourceIssues[0]?.routeId, "cin_maintainer");
  assert.equal(sourceIssues[0]?.status, "is degraded");
  assert.match(sourceIssues[0]?.what ?? "", MAINTAINER_ACTION_RE);
});

test("source issues fall back to legacy degraded health when rendered verdict is absent", () => {
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "usaa",
      connection_id: "cin_usaa",
      connection_health: legacyHealth("degraded"),
      display_name: "USAA - Personal",
      rendered_verdict: null,
    }),
  ];

  assert.equal(attentionConnectionsFromConnectors(connectors).length, 0);

  const sourceIssues = sourceIssueConnectionsFromConnectors(connectors);
  assert.equal(sourceIssues.length, 1);
  assert.equal(sourceIssues[0]?.label, "USAA - Personal");
  assert.equal(sourceIssues[0]?.routeId, "cin_usaa");
  assert.equal(sourceIssues[0]?.status, "is degraded");
  assert.match(sourceIssues[0]?.what ?? "", INCOMPLETE_OR_GAP_RE);

  const data = buildStandingData(baseInputs({ sourceIssues }));
  assert.equal(data.hero.tone, "calm");
  assert.equal(data.sourceIssues.length, 1);
  assert.equal(data.attention.length, 0);
});

test("attention routeId targets the EXACT connection instance, not the connector type", () => {
  // The multi-account seam bug: three Claude Code devices share connector_id
  // "claude-code"; only peregrine is in attention. Routing by connector_id would
  // resolve to whichever connection is first (e.g. healthy Simon VM). The routeId
  // must be the connection identity (connector_instance_id ?? connection_id) so
  // the CTA lands on the connection that actually needs the owner.
  const connectors: RefConnectorSummary[] = [
    connector({
      connector_id: "claude-code",
      connection_id: "cin_simon",
      rendered_verdict: verdict({ channel: "calm" }),
    }), // healthy, first
    connector({
      connector_id: "claude-code",
      connection_id: "cin_peregrine",
      connector_instance_id: "ci_peregrine",
      rendered_verdict: verdict({}),
    }), // the attention one
  ];
  const attention = attentionConnectionsFromConnectors(connectors);
  assert.equal(attention.length, 1);
  // routeId is the instance id (preferred), which the records route resolves
  // exactly — NOT the shared connector_id "claude-code".
  assert.equal(attention[0]?.routeId, "ci_peregrine");
  assert.notEqual(attention[0]?.routeId, "claude-code");
  // And the hero CTA href uses that exact-connection routeId.
  const hero = computeHero(baseInputs({ attentionConnections: attention }));
  assert.equal(hero.cta?.href, HREFS.connection("ci_peregrine"));
});

test("hero ALARMs on a stale projection even with no failures", () => {
  const stale = baseInputs();
  stale.summary = {
    ...stale.summary,
    projection: {
      state: "stale",
      last_error: "bulk write on unknown connection",
    },
  } as StandingInputs["summary"];
  const hero = computeHero(stale);
  assert.equal(hero.tone, "alarm");
  assert.equal(hero.kicker, "Totals updating");
  assert.equal(hero.line.emphasis, "are still available");
  assert.match(hero.sub ?? "", STALE_TOTALS_RE);
  assert.equal(hero.cta?.label, "View status");
  assert.doesNotMatch(hero.sub ?? "", BULK_WRITE_UNKNOWN_CONNECTION_RE);
  assert.doesNotMatch(
    `${hero.kicker} ${hero.line.text} ${hero.line.emphasis} ${hero.line.tail} ${hero.sub}`,
    PROJECTION_COPY_RE
  );
});

test("hero uses owner-safe copy for failed projection details", () => {
  const failed = baseInputs();
  failed.summary = {
    ...failed.summary,
    projection: {
      state: "failed",
      last_error: "SQL failed: bulk write on unknown connection",
    },
  } as StandingInputs["summary"];
  const hero = computeHero(failed);
  assert.equal(hero.tone, "alarm");
  assert.equal(hero.kicker, "Totals update delayed");
  assert.equal(hero.line.emphasis, "are still available");
  assert.match(hero.sub ?? "", STALE_TOTALS_RE);
  assert.equal(hero.cta?.label, "View status");
  assert.doesNotMatch(hero.sub ?? "", BULK_WRITE_UNKNOWN_CONNECTION_RE);
  assert.doesNotMatch(hero.sub ?? "", SQL_FAILED_RE);
  assert.doesNotMatch(
    `${hero.kicker} ${hero.line.text} ${hero.line.emphasis} ${hero.line.tail} ${hero.sub}`,
    PROJECTION_SQL_COPY_RE
  );
});

test("hero ALARMs when dashboard inputs fail instead of claiming all-clear from partial data", () => {
  const data = buildStandingData(baseInputs({ overviewLoadIssues: ["source_status"] }));

  assert.equal(data.hero.tone, "alarm");
  assert.equal(data.hero.kicker, "Overview is incomplete");
  assert.match(data.hero.line.emphasis ?? "", DID_NOT_LOAD_RE);
  assert.match(data.hero.sub, WILL_NOT_CLAIM_ALL_CLEAR_RE);
  assert.equal(data.hero.cta?.href, HREFS.deployment);
  assert.equal(data.overviewIssues.length, 1);
  assert.equal(data.overviewIssues[0]?.what, "Overview could not check everything");
  assert.match(data.overviewIssues[0]?.why ?? "", REFRESH_PAGE_RE);
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

test("bearer section and hero count only active owner tokens", () => {
  const clients: OwnerIssuedClient[] = [
    { client_id: "inactive", client_name: "Old smoke client", active_token_count: 0, created_at: NOW.toISOString() },
    { client_id: "active", client_name: "Claude Desktop", active_token_count: 2, created_at: NOW.toISOString() },
  ];
  const data = buildStandingData(baseInputs({ bearerClients: clients }));

  assert.equal(data.bearers.length, 1);
  assert.equal(data.bearers[0]?.clientId, "active");
  assert.match(data.hero.sub, OWNER_TOKEN_COUNT_RE);
  assert.doesNotMatch(data.hero.sub, TOKEN_OVERCOUNT_RE);
});

test("hero says no owner token can act when all issued clients are inactive", () => {
  const clients: OwnerIssuedClient[] = [
    { client_id: "inactive", client_name: "Old smoke client", active_token_count: 0, created_at: NOW.toISOString() },
  ];
  const data = buildStandingData(baseInputs({ bearerClients: clients }));

  assert.equal(data.bearers.length, 0);
  assert.match(data.hero.sub, NO_OWNER_TOKEN_RE);
});

// ─── bearer timestamp consistency + honest "issued" copy (C2) ─────────────

test("bearer row carries the raw created_at for the shared IcTimestamp, not a prebaked date string", () => {
  const clients: OwnerIssuedClient[] = [
    { client_id: "c1", client_name: "Claude Desktop", active_token_count: 1, created_at: "2026-06-01T00:00:00Z" },
  ];
  const data = buildStandingData(baseInputs({ bearerClients: clients }));

  assert.equal(data.bearers.length, 1);
  // The datum is passed through verbatim so the component renders it with the
  // same <IcTimestamp> primitive the tokens page uses — one timestamp voice.
  assert.equal(data.bearers[0]?.issuedAt, "2026-06-01T00:00:00Z");
  // The `how` line no longer bakes in a relDay date string; the timestamp is
  // rendered separately by the component.
  assert.doesNotMatch(data.bearers[0]?.how ?? "", BEARER_HOW_HAS_ISSUED_RE);
  assert.doesNotMatch(data.bearers[0]?.how ?? "", BEARER_HOW_HAS_DATE_RE);
});

test('single-token bearer labels created_at "issued"; multi-token bearer degrades to "first issued"', () => {
  const single: OwnerIssuedClient[] = [
    { client_id: "one", client_name: "Solo", active_token_count: 1, created_at: NOW.toISOString() },
  ];
  const multi: OwnerIssuedClient[] = [
    { client_id: "many", client_name: "Legacy", active_token_count: 3, created_at: NOW.toISOString() },
  ];

  const singleData = buildStandingData(baseInputs({ bearerClients: single }));
  const multiData = buildStandingData(baseInputs({ bearerClients: multi }));

  // created_at is CLIENT REGISTRATION time; with one token it IS the issuance,
  // with several it is only the FIRST — so "issued" would be wrong for the rest.
  assert.equal(singleData.bearers[0]?.issuedLabel, "issued");
  assert.equal(multiData.bearers[0]?.issuedLabel, "first issued");
});

// ─── bearer preview cap + "+N more" (C4) ──────────────────────────────────

test("bearer block previews the most-recent few and reports the hidden overflow count", () => {
  const clients: OwnerIssuedClient[] = Array.from({ length: 7 }, (_, i) => ({
    client_id: `c${i}`,
    client_name: `Client ${i}`,
    active_token_count: 1,
    created_at: NOW.toISOString(),
  }));
  const data = buildStandingData(baseInputs({ bearerClients: clients }));

  // Overview reassures/summarizes — it caps the preview and links the rest to
  // the tokens page rather than rendering a wall.
  assert.equal(data.bearers.length, BEARER_PREVIEW_LIMIT);
  assert.equal(data.bearersOverflow, 7 - BEARER_PREVIEW_LIMIT);
});

test("bearer overflow is zero when active bearers fit within the preview cap", () => {
  const clients: OwnerIssuedClient[] = [
    { client_id: "c1", client_name: "Claude Desktop", active_token_count: 1, created_at: NOW.toISOString() },
  ];
  const data = buildStandingData(baseInputs({ bearerClients: clients }));

  assert.equal(data.bearers.length, 1);
  assert.equal(data.bearersOverflow, 0);
});

// ─── grant-package discovery from loaded grants (C7) ──────────────────────

test("grant packages are surfaced from loaded grants without a count endpoint", () => {
  const grants: GrantSummary[] = [
    {
      object: "grant_summary",
      grant_id: "g1",
      client_id: "App A",
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-12T00:00:00Z",
      event_count: 5,
      kinds: ["query.received"],
      failure: null,
      grant_package_id: "pkg_alpha",
    },
    {
      object: "grant_summary",
      grant_id: "g2",
      client_id: "App A",
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-12T00:00:00Z",
      event_count: 3,
      kinds: ["query.received"],
      failure: null,
      grant_package_id: "pkg_alpha",
    },
    {
      object: "grant_summary",
      grant_id: "g3",
      client_id: "App B",
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-12T00:00:00Z",
      event_count: 1,
      kinds: ["query.received"],
      failure: null,
      grant_package_id: "pkg_beta",
    },
  ];

  const data = buildStandingData(baseInputs({ grants }));

  // Two DISTINCT packages across the loaded grants; link targets the packages
  // management surface. Derived only from grant_package_id already in hand.
  assert.equal(data.grantPackages?.count, 2);
  assert.equal(data.grantPackages?.exact, false);
  assert.equal(data.grantPackages?.href, HREFS.grantPackages);
});

// ─── grant-package authoritative count (10.C.4) ───────────────────────────

test("the authoritative grant-package count drives the overview badge when present", () => {
  // A single loaded grant carries a package; the count endpoint reports more.
  // The overview must trust the endpoint (exact), not the loaded-grants floor,
  // so packages not represented in the preview still surface.
  const grant: GrantSummary = {
    object: "grant_summary",
    grant_id: "g1",
    client_id: "App A",
    connector_id: "pdpp",
    status: "active",
    first_at: "2026-06-01T00:00:00Z",
    last_at: "2026-06-12T00:00:00Z",
    event_count: 5,
    kinds: ["query.received"],
    failure: null,
    grant_package_id: "pkg_alpha",
  };

  const data = buildStandingData(baseInputs({ grants: [grant], grantPackageCount: 4 }));
  assert.equal(data.grantPackages?.count, 4);
  assert.equal(data.grantPackages?.exact, true);
  assert.equal(data.grantPackages?.href, HREFS.grantPackages);
});

test("an authoritative zero grant-package count collapses the badge even if a stale grant carries a package id", () => {
  const grant: GrantSummary = {
    object: "grant_summary",
    grant_id: "g1",
    client_id: "App A",
    connector_id: "pdpp",
    status: "active",
    first_at: "2026-06-01T00:00:00Z",
    last_at: "2026-06-12T00:00:00Z",
    event_count: 5,
    kinds: ["query.received"],
    failure: null,
    grant_package_id: "pkg_alpha",
  };

  const data = buildStandingData(baseInputs({ grants: [grant], grantPackageCount: 0 }));
  assert.equal(data.grantPackages, null);
});

test("a null grant-package count falls back to the loaded-grants floor", () => {
  const grant: GrantSummary = {
    object: "grant_summary",
    grant_id: "g1",
    client_id: "App A",
    connector_id: "pdpp",
    status: "active",
    first_at: "2026-06-01T00:00:00Z",
    last_at: "2026-06-12T00:00:00Z",
    event_count: 5,
    kinds: ["query.received"],
    failure: null,
    grant_package_id: "pkg_alpha",
  };

  const data = buildStandingData(baseInputs({ grants: [grant], grantPackageCount: null }));
  assert.equal(data.grantPackages?.count, 1);
  assert.equal(data.grantPackages?.exact, false);
});

test("grant packages are absent when no loaded grant carries a package id", () => {
  const grant: GrantSummary = {
    object: "grant_summary",
    grant_id: "g1",
    client_id: "App A",
    connector_id: "pdpp",
    status: "active",
    first_at: "2026-06-01T00:00:00Z",
    last_at: "2026-06-12T00:00:00Z",
    event_count: 5,
    kinds: ["query.received"],
    failure: null,
  };

  const data = buildStandingData(baseInputs({ grants: [grant] }));
  assert.equal(data.grantPackages, null);
});

test("a fully-revoked package does not advertise from the overview", () => {
  const grant: GrantSummary = {
    object: "grant_summary",
    grant_id: "g1",
    client_id: "App A",
    connector_id: "pdpp",
    status: "revoked",
    first_at: "2026-06-01T00:00:00Z",
    last_at: "2026-06-12T00:00:00Z",
    event_count: 5,
    kinds: ["query.received"],
    failure: null,
    grant_package_id: "pkg_dead",
  };

  const data = buildStandingData(baseInputs({ grants: [grant] }));
  assert.equal(data.grantPackages, null);
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
  assert.equal(data.relationships[0]?.actionLabel, "review");
  assert.equal(data.relationships[0]?.actionHref, HREFS.grant("g1"));
  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.deny, false);
  assert.match(data.lately[0]?.text.rest ?? "", LATELY_READ_RE);
  assert.equal(data.attention.length, 0);
});

test("lately uses trace client metadata instead of raw client ids", () => {
  const trace: TraceSummary = {
    object: "trace_summary",
    trace_id: "trc_named",
    status: "succeeded",
    actor_id: "client",
    actor_type: "client",
    client_id: "cli_named",
    client: {
      client_id: "cli_named",
      client_name: "Claude",
      registration_mode: "dynamic",
    },
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: "2026-06-13T00:00:00Z",
    last_at: "2026-06-13T00:00:00Z",
    event_count: 3,
    kinds: ["query.received"],
    failure: null,
  };

  const data = buildStandingData(baseInputs({ traces: [trace] }));

  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.text.who, "Claude");
  assert.notEqual(data.lately[0]?.text.who, "cli_named");
});

test("lately humanizes live denial reason codes instead of rendering raw diagnostics", () => {
  const trace: TraceSummary = {
    object: "trace_summary",
    trace_id: "trc_orphaned",
    status: "denied",
    actor_id: "slack",
    actor_type: "client",
    client_id: "slack",
    grant_id: null,
    run_id: "run_orphaned",
    request_id: null,
    first_at: "2026-06-13T00:00:00Z",
    last_at: "2026-06-13T00:00:00Z",
    event_count: 1,
    kinds: ["query.rejected"],
    failure: {
      event_type: "run.started",
      reason: "orphaned_started_run",
    },
  };

  const data = buildStandingData(baseInputs({ traces: [trace] }));

  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.text.rest, "tried to read — turned away, it was not tied to an active run.");
  assert.doesNotMatch(data.lately[0]?.text.rest ?? "", RAW_ORPHANED_RUN_RE);
});

test("lately does not fall through to unknown snake-case denial reasons", () => {
  const trace: TraceSummary = {
    object: "trace_summary",
    trace_id: "trc_unknown_denial",
    status: "denied",
    actor_id: "client",
    actor_type: "client",
    client_id: "client",
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: "2026-06-13T00:00:00Z",
    last_at: "2026-06-13T00:00:00Z",
    event_count: 1,
    kinds: ["query.rejected"],
    failure: {
      event_type: "query.rejected",
      reason: "new_internal_reason_code",
    },
  };

  const data = buildStandingData(baseInputs({ traces: [trace] }));

  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.text.rest, "tried to read — turned away, the server rejected it.");
  assert.doesNotMatch(data.lately[0]?.text.rest ?? "", RAW_REASON_CODE_RE);
});

test("lately does not overclaim off-surface expired or credential scope failures", () => {
  const traces: TraceSummary[] = [
    {
      object: "trace_summary",
      trace_id: "trc_state_expired",
      status: "denied",
      actor_id: "state_client",
      actor_type: "client",
      client_id: "state_client",
      grant_id: null,
      run_id: null,
      request_id: null,
      first_at: "2026-06-13T00:00:00Z",
      last_at: "2026-06-13T00:00:00Z",
      event_count: 1,
      kinds: ["query.rejected"],
      failure: {
        event_type: "query.rejected",
        reason: "state_expired",
      },
    },
    {
      object: "trace_summary",
      trace_id: "trc_credential_scope",
      status: "denied",
      actor_id: "credential_client",
      actor_type: "client",
      client_id: "credential_client",
      grant_id: null,
      run_id: null,
      request_id: null,
      first_at: "2026-06-13T00:00:01Z",
      last_at: "2026-06-13T00:00:01Z",
      event_count: 1,
      kinds: ["query.rejected"],
      failure: {
        event_type: "query.rejected",
        reason: "github_credential_insufficient_scope",
      },
    },
  ];

  const data = buildStandingData(baseInputs({ traces }));
  const rendered = data.lately.map((item) => item.text.rest);

  assert.ok(rendered.includes("tried to read — turned away, the server rejected it."));
  assert.ok(rendered.includes("tried to read — turned away, the app was not authorized."));
  assert.doesNotMatch(rendered.join("\n"), EXPIRED_OR_CREDENTIAL_RE);
});

test("lately does not bold raw technical client ids when metadata is missing", () => {
  const trace: TraceSummary = {
    object: "trace_summary",
    trace_id: "trc_raw",
    status: "succeeded",
    actor_id: "cli_raw",
    actor_type: "client",
    client_id: "cli_raw",
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: "2026-06-13T00:00:00Z",
    last_at: "2026-06-13T00:00:00Z",
    event_count: 3,
    kinds: ["query.received"],
    failure: null,
  };

  const data = buildStandingData(baseInputs({ traces: [trace] }));

  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.text.who, "An app");
  assert.notEqual(data.lately[0]?.text.who, "cli_raw");
});

test("lately does not render bare opaque client ids as names", () => {
  const opaqueClientId = "d9f1c1bb7a5c4a6f9e8d7c6b5a4f3210";
  const trace: TraceSummary = {
    object: "trace_summary",
    trace_id: "trc_opaque",
    status: "succeeded",
    actor_id: opaqueClientId,
    actor_type: "unknown",
    client_id: opaqueClientId,
    grant_id: null,
    run_id: null,
    request_id: null,
    first_at: "2026-06-13T00:00:00Z",
    last_at: "2026-06-13T00:00:00Z",
    event_count: 3,
    kinds: ["query.received"],
    failure: null,
  };

  const data = buildStandingData(baseInputs({ traces: [trace] }));

  assert.equal(data.lately.length, 1);
  assert.equal(data.lately[0]?.text.who, "Someone");
  assert.notEqual(data.lately[0]?.text.who, opaqueClientId);
});

test("lately summarizes identical recent reads instead of repeating the same row", () => {
  const repeated = Array.from(
    { length: 5 },
    (_, i): TraceSummary => ({
      object: "trace_summary",
      trace_id: `trc_longview_${i}`,
      status: "succeeded",
      actor_id: "client",
      actor_type: "client",
      client_id: "cli_longview",
      client: {
        client_id: "cli_longview",
        client_name: "Longview CLI",
        registration_mode: "pre_registered_public",
      },
      grant_id: null,
      run_id: null,
      request_id: null,
      first_at: "2026-06-13T00:00:00Z",
      last_at: "2026-06-13T00:00:00Z",
      event_count: 3,
      kinds: ["query.received"],
      failure: null,
    })
  );
  const baseRepeated = repeated[0];
  assert.ok(baseRepeated);
  const different: TraceSummary = {
    ...baseRepeated,
    trace_id: "trc_controller",
    actor_id: "controller",
    actor_type: "runtime",
    client_id: null,
    client: undefined,
    event_count: 1,
  };

  const data = buildStandingData(baseInputs({ traces: [...repeated, different] }));

  assert.equal(data.lately.length, 2);
  assert.equal(data.lately[0]?.text.who, "Longview CLI");
  assert.equal(data.lately[0]?.text.rest, "read 3 records 5 times.");
  assert.equal(data.lately[1]?.text.who, "controller");
  assert.equal(data.lately[1]?.text.rest, "read 1 record.");
});

test("relationships summarize grants by client instead of repeating one row per grant", () => {
  const grants: GrantSummary[] = [
    {
      object: "grant_summary",
      grant_id: "g1",
      client_id: "CLI agent",
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-10T00:00:00Z",
      event_count: 5,
      kinds: ["token.issued", "query.received"],
      failure: null,
    },
    {
      object: "grant_summary",
      grant_id: "g2",
      client_id: "CLI agent",
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-02T00:00:00Z",
      last_at: "2026-06-12T12:00:00Z",
      event_count: 7,
      kinds: ["disclosure.served", "query.rejected"],
      failure: null,
    },
  ];

  const data = buildStandingData(baseInputs({ grants }));

  assert.equal(data.relationships.length, 1);
  assert.equal(data.relationships[0]?.who, "CLI agent");
  assert.equal(
    data.relationships[0]?.reads,
    "reads only token activity, read requests, data disclosures, and rejected reads"
  );
  assert.equal(data.relationships[0]?.terms, "last active yesterday · 2 grants");
  assert.equal(data.relationships[0]?.actionLabel, "review");
  assert.equal(data.relationships[0]?.actionHref, HREFS.grants);
});

test("relationships use known client names without replacing the verified client id", () => {
  const grants: GrantSummary[] = [
    {
      object: "grant_summary",
      grant_id: "g1",
      client_id: "cli_known",
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-12T12:00:00Z",
      event_count: 7,
      kinds: ["query.received"],
      failure: null,
    },
  ];
  const clients: OwnerIssuedClient[] = [
    {
      active_token_count: 0,
      client_id: "cli_known",
      client_name: "Claude Code",
      created_at: "2026-06-01T00:00:00Z",
    },
  ];

  const data = buildStandingData(baseInputs({ bearerClients: clients, grants }));

  assert.equal(data.relationships.length, 1);
  assert.equal(data.relationships[0]?.who, "Claude Code");
  assert.equal(data.relationships[0]?.clientId, "cli_known");
  assert.equal(data.bearers.length, 0, "inactive owner clients still provide identity metadata only");
});

test("relationships prefer grant client metadata over owner-token labels", () => {
  const grants: GrantSummary[] = [
    {
      object: "grant_summary",
      grant_id: "g1",
      client_id: "cli_known",
      client: {
        client_id: "cli_known",
        client_name: "Claude Code",
        registration_mode: "dynamic",
      },
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-12T12:00:00Z",
      event_count: 7,
      kinds: ["query.received"],
      failure: null,
    },
  ];
  const clients: OwnerIssuedClient[] = [
    {
      active_token_count: 1,
      client_id: "cli_known",
      client_name: "Older owner-token label",
      created_at: "2026-06-01T00:00:00Z",
    },
  ];

  const data = buildStandingData(baseInputs({ bearerClients: clients, grants }));

  assert.equal(data.relationships.length, 1);
  assert.equal(data.relationships[0]?.who, "Claude Code");
  assert.equal(data.relationships[0]?.clientId, "cli_known");
});

test("relationships do not render raw URL client ids as owner-facing names", () => {
  const urlClientId = "https://chatgpt.com/oauth/Dyp26IIu2iQg/client.json?token_endpoint_auth_method=none";
  const grants: GrantSummary[] = [
    {
      object: "grant_summary",
      grant_id: "g1",
      client_id: urlClientId,
      connector_id: "pdpp",
      status: "active",
      first_at: "2026-06-01T00:00:00Z",
      last_at: "2026-06-12T12:00:00Z",
      event_count: 7,
      kinds: ["query.received"],
      failure: null,
    },
  ];

  const data = buildStandingData(baseInputs({ grants }));

  assert.equal(data.relationships.length, 1);
  assert.equal(data.relationships[0]?.who, "chatgpt.com");
  assert.equal(data.relationships[0]?.clientId, urlClientId);
  assert.equal(data.relationships[0]?.showClientId, false);
});

test("relationships do not render bare UUID or opaque client ids as owner-facing names", () => {
  for (const clientId of ["0b643449-9516-45e0-b375-7feb9ecb7a58", "d9f1c1bb7a5c4a6f9e8d7c6b5a4f3210"]) {
    const grants: GrantSummary[] = [
      {
        object: "grant_summary",
        grant_id: "g1",
        client_id: clientId,
        connector_id: "pdpp",
        status: "active",
        first_at: "2026-06-01T00:00:00Z",
        last_at: "2026-06-12T12:00:00Z",
        event_count: 7,
        kinds: ["query.received"],
        failure: null,
      },
    ];

    const data = buildStandingData(baseInputs({ grants }));

    assert.equal(data.relationships.length, 1);
    assert.equal(data.relationships[0]?.who, "Unnamed app");
    assert.equal(data.relationships[0]?.clientId, clientId);
    assert.equal(data.relationships[0]?.showClientId, false);
  }
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
