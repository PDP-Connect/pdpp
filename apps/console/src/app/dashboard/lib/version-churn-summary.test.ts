/**
 * Behavioral tests for the pure version-churn presentation module. These run
 * in Node's test runner without a JSX resolver because the module is plain
 * TypeScript — the JSX view imports these helpers rather than re-deriving the
 * logic inline.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RefRecordVersionStatsRow } from "./ref-client.ts";
import {
  buildChurnDrilldownRows,
  churnDryRunCommand,
  churnRowLabel,
  classifyChurnRow,
  countChurnDispositions,
  isExpectedRetainedHistory,
  LOSSLESS_COMPACTION_POLICY_STREAMS,
  needsReview,
  POINT_IN_TIME_REAL_FIELD_STREAMS,
  pointInTimeGuidance,
  summarizeVersionChurn,
} from "./version-churn-summary.ts";

const HIGHEST_SIGNAL_RE = /ynab \/ budgets retains 273\.75 versions per current record\./;
const NOT_COMPACTABLE_RE = /[Nn]ot compactable/;
const APPEND_KEYED_RE = /append-keyed/;
const FOLLOWER_RE = /follower/;
const NEEDS_REVIEW_RE = /needs review/;
const NO_REVIEW_NEEDED_RE = /no review needed/;
const THREE_EXPECTED_RETAINED_RE = /3 expected retained history/;
const THREE_COMPACTION_CANDIDATES_RE = /3 compaction candidates/;
const ONE_STREAM_NEEDS_REVIEW_RE = /1 stream need(s)? review/;
const TWO_STREAMS_NEED_REVIEW_RE = /2 streams need review/;
const ONE_COMPACTION_CANDIDATE_RE = /1 compaction candidate/;
const ONE_EXPECTED_RETAINED_RE = /1 expected retained history/;
const BALANCE_RE = /balance/;

function row(overrides: Partial<RefRecordVersionStatsRow> = {}): RefRecordVersionStatsRow {
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
    versions_per_record: 273.75,
    ...overrides,
  };
}

// An unclassified high-churn stream: neither a known real-field stream nor a
// registered compaction policy. This is the only class that "needs review".
function unclassifiedRow(overrides: Partial<RefRecordVersionStatsRow> = {}): RefRecordVersionStatsRow {
  return row({ connector_id: "mystery", stream: "widgets", ...overrides });
}

test("summarizeVersionChurn returns null for an empty row set", () => {
  assert.equal(summarizeVersionChurn([]), null);
});

// ─── Disposition-honest headline (the product bug) ───────────────────────
//
// The banner must not scream "needs review" for rows that are already
// classified as expected retained point-in-time history or as known-safe
// compaction candidates. Only an UNCLASSIFIED row makes the banner say review
// is needed. This is acceptance criterion #1: known expected retained history
// is no longer treated as unresolved.

test("summarizeVersionChurn does NOT say 'needs review' when every row is expected retained history", () => {
  // github/user, slack/channels, ynab/accounts are all point-in-time real-field
  // — expected retained history, not a defect.
  const rows = [
    row({ connector_id: "github", stream: "user", risk_level: "high" }),
    row({ connector_id: "slack", stream: "channels", risk_level: "high" }),
    row({ connector_id: "ynab", stream: "accounts", risk_level: "watch" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.needsReview, false);
  assert.doesNotMatch(summary.headline, NEEDS_REVIEW_RE);
  assert.match(summary.headline, NO_REVIEW_NEEDED_RE);
  assert.match(summary.headline, THREE_EXPECTED_RETAINED_RE);
  assert.equal(summary.dispositions.expectedRetained, 3);
  assert.equal(summary.dispositions.needsReview, 0);
});

test("summarizeVersionChurn does NOT say 'needs review' when every row is a registered compaction candidate", () => {
  // ynab/budgets, gmail/labels, usaa/statements all have registered lossless
  // compaction policies — actionable cleanup, not "something is wrong".
  const rows = [
    row({ connector_id: "ynab", stream: "budgets", risk_level: "high" }),
    row({ connector_id: "gmail", stream: "labels", risk_level: "watch" }),
    row({ connector_id: "usaa", stream: "statements", risk_level: "watch" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.needsReview, false);
  assert.doesNotMatch(summary.headline, NEEDS_REVIEW_RE);
  assert.match(summary.headline, THREE_COMPACTION_CANDIDATES_RE);
  assert.equal(summary.dispositions.compactionCandidates, 3);
});

test("summarizeVersionChurn SAYS 'needs review' when at least one row is unclassified", () => {
  const rows = [
    row({ connector_id: "github", stream: "user", risk_level: "high" }), // expected
    row({ connector_id: "ynab", stream: "budgets", risk_level: "high" }), // compaction
    unclassifiedRow({ risk_level: "high" }), // genuinely needs review
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.needsReview, true);
  assert.match(summary.headline, NEEDS_REVIEW_RE);
  assert.match(summary.headline, ONE_STREAM_NEEDS_REVIEW_RE);
  assert.equal(summary.dispositions.needsReview, 1);
  assert.equal(summary.dispositions.compactionCandidates, 1);
  assert.equal(summary.dispositions.expectedRetained, 1);
});

test("summarizeVersionChurn headline names every non-zero disposition (never silently hides a count)", () => {
  const rows = [
    unclassifiedRow({ stream: "a" }),
    unclassifiedRow({ stream: "b" }),
    row({ connector_id: "ynab", stream: "budgets" }),
    row({ connector_id: "github", stream: "user" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.match(summary.headline, TWO_STREAMS_NEED_REVIEW_RE);
  assert.match(summary.headline, ONE_COMPACTION_CANDIDATE_RE);
  assert.match(summary.headline, ONE_EXPECTED_RETAINED_RE);
});

test("summarizeVersionChurn highest signal reflects the first (highest-risk) row", () => {
  const summary = summarizeVersionChurn([row()]);
  assert.ok(summary);
  assert.match(summary.highestSignal, HIGHEST_SIGNAL_RE);
});

// ─── countChurnDispositions ──────────────────────────────────────────────

test("countChurnDispositions buckets rows by remediation disposition", () => {
  const counts = countChurnDispositions([
    row({ connector_id: "github", stream: "user" }), // expected retained
    row({ connector_id: "slack", stream: "channels" }), // expected retained
    row({ connector_id: "ynab", stream: "budgets" }), // compaction candidate
    unclassifiedRow(), // needs review
  ]);
  assert.deepEqual(counts, { needsReview: 1, compactionCandidates: 1, expectedRetained: 2 });
});

test("isExpectedRetainedHistory / needsReview predicates agree with classifyChurnRow", () => {
  const realField = row({ connector_id: "github", stream: "user" });
  const compaction = row({ connector_id: "ynab", stream: "budgets" });
  const unclassified = unclassifiedRow();
  assert.equal(isExpectedRetainedHistory(realField), true);
  assert.equal(isExpectedRetainedHistory(compaction), false);
  assert.equal(isExpectedRetainedHistory(unclassified), false);
  assert.equal(needsReview(realField), false);
  assert.equal(needsReview(compaction), false);
  assert.equal(needsReview(unclassified), true);
});

test("churnRowLabel falls back to the connector key when no display name is set", () => {
  assert.equal(churnRowLabel(row({ display_name: null, connector_id: "ynab" })), "ynab / budgets");
});

test("churnRowLabel prefers an owner-set display name", () => {
  assert.equal(churnRowLabel(row({ display_name: "Household YNAB" })), "Household YNAB / budgets");
});

test("buildChurnDrilldownRows surfaces all supplied rows in order", () => {
  const rows = [row({ stream: "budgets" }), row({ stream: "accounts", risk_level: "watch" })];
  const built = buildChurnDrilldownRows(rows);
  assert.equal(built.length, 2);
  assert.equal(built[0]?.label, "ynab / budgets");
  assert.equal(built[0]?.risk, "high");
  assert.equal(built[0]?.connectorId, "ynab");
  assert.equal(built[0]?.connectorInstanceId, "cin_ynab_1");
  assert.equal(built[0]?.stream, "budgets");
  assert.equal(built[1]?.label, "ynab / accounts");
  assert.equal(built[1]?.risk, "watch");
});

test("buildChurnDrilldownRows renders ground-truth counts, not zeroes", () => {
  const built = buildChurnDrilldownRows([row()]);
  assert.equal(built[0]?.current.label, "4");
  assert.equal(built[0]?.history.label, "1,095");
  assert.equal(built[0]?.keys.label, "4");
  assert.equal(built[0]?.versionsPerRecord.label, "273.75");
});

test("buildChurnDrilldownRows marks a null key count as unknown rather than zero", () => {
  const built = buildChurnDrilldownRows([row({ record_key_count: null })]);
  assert.equal(built[0]?.keys.label, "—");
  assert.equal(built[0]?.keys.unknown, true);
  // A present count is never flagged unknown.
  assert.equal(built[0]?.current.unknown, undefined);
});

test("buildChurnDrilldownRows preserves last-history evidence and risk reasons", () => {
  const built = buildChurnDrilldownRows([
    row({ last_history_at: "2026-05-31T12:00:00.000Z", risk_reasons: ["a", "b"] }),
  ]);
  assert.equal(built[0]?.lastHistoryAt, "2026-05-31T12:00:00.000Z");
  assert.equal(built[0]?.reasons, "a; b");
});

test("buildChurnDrilldownRows leaves missing last-history evidence null", () => {
  const built = buildChurnDrilldownRows([row({ last_history_at: null, risk_reasons: [] })]);
  assert.equal(built[0]?.lastHistoryAt, null);
  assert.equal(built[0]?.reasons, null);
});

test("buildChurnDrilldownRows produces a stable, unique key per (connection, stream)", () => {
  const built = buildChurnDrilldownRows([
    row({ connector_instance_id: "cin_a", stream: "budgets" }),
    row({ connector_instance_id: "cin_b", stream: "budgets" }),
  ]);
  assert.equal(built[0]?.key, "cin_a:budgets");
  assert.equal(built[1]?.key, "cin_b:budgets");
});

test("churnDryRunCommand builds the default read-only maintenance command", () => {
  assert.equal(
    churnDryRunCommand(row()),
    "node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id='cin_ynab_1' --stream='budgets' --connector-id='ynab'"
  );
});

// ─── Three-way remediation classification ────────────────────────────────
//
// 1. point_in_time_real_field — github/user, slack/channels, ynab/accounts:
//    genuinely changing real field, NO compaction policy (script exits 2),
//    expected retained history; must be split, not compacted.
// 2. lossless_compaction_candidate — has a registered policy in
//    COMPACTION_POLICIES (ynab/budgets, gmail/labels, usaa/*, etc.): the
//    dry-run command is a real remediation.
// 3. unclassified — neither: genuinely needs review.

test("classifyChurnRow flags github/user as a real-field point-in-time stream", () => {
  assert.equal(classifyChurnRow(row({ connector_id: "github", stream: "user" })), "point_in_time_real_field");
});

test("classifyChurnRow flags slack/channels as a real-field point-in-time stream", () => {
  assert.equal(classifyChurnRow(row({ connector_id: "slack", stream: "channels" })), "point_in_time_real_field");
});

test("classifyChurnRow flags ynab/accounts as a real-field point-in-time stream", () => {
  // ynab/accounts split its balances into the append-keyed account_stats
  // observation stream; the retained accounts history churns only on the
  // now-removed balance fields. The split stream holds no backfill, so this
  // history is the sole surviving copy — it must be retained, never compacted.
  assert.equal(classifyChurnRow(row({ connector_id: "ynab", stream: "accounts" })), "point_in_time_real_field");
});

test("classifyChurnRow resolves the registry-URL connector-id form too", () => {
  assert.equal(
    classifyChurnRow(row({ connector_id: "https://registry.pdpp.org/connectors/github", stream: "user" })),
    "point_in_time_real_field"
  );
  assert.equal(
    classifyChurnRow(row({ connector_id: "https://registry.pdpp.org/connectors/slack", stream: "channels" })),
    "point_in_time_real_field"
  );
  assert.equal(
    classifyChurnRow(row({ connector_id: "https://registry.pdpp.org/connectors/ynab", stream: "accounts" })),
    "point_in_time_real_field"
  );
});

test("classifyChurnRow flags policied no-op/run-clock streams as lossless compaction candidates", () => {
  // These all have a registered policy in COMPACTION_POLICIES; the dry-run
  // command is a real remediation for them.
  const compactable: [string, string][] = [
    ["gmail", "labels"],
    ["slack", "channel_memberships"],
    ["usaa", "accounts"],
    ["usaa", "credit_card_billing"],
    ["chase", "accounts"],
    ["usaa", "statements"],
    ["ynab", "budgets"],
    ["amazon", "orders"],
    ["chatgpt", "custom_instructions"],
    ["codex", "messages"],
    ["claude-code", "sessions"],
  ];
  for (const [connector_id, stream] of compactable) {
    assert.equal(
      classifyChurnRow(row({ connector_id, stream })),
      "lossless_compaction_candidate",
      `${connector_id}/${stream} should be a lossless compaction candidate`
    );
  }
});

test("classifyChurnRow resolves the registry-URL form for compaction-policy streams", () => {
  assert.equal(
    classifyChurnRow(row({ connector_id: "https://registry.pdpp.org/connectors/gmail", stream: "labels" })),
    "lossless_compaction_candidate"
  );
});

test("classifyChurnRow returns 'unclassified' for a stream with no policy and not a known real-field", () => {
  // A genuinely unknown high-churn stream — the only class that needs review.
  assert.equal(classifyChurnRow(unclassifiedRow()), "unclassified");
  // slack/users and github/repos are NOT real-field exceptions; slack/users
  // happens to have a policy (compaction candidate); github/repos has neither.
  assert.equal(classifyChurnRow(row({ connector_id: "slack", stream: "users" })), "lossless_compaction_candidate");
  assert.equal(classifyChurnRow(row({ connector_id: "github", stream: "repos" })), "unclassified");
});

test("classifyChurnRow does not over-match: a different ynab stream is not silently a real-field", () => {
  // Only ynab/accounts is the real-field exception; ynab/payees is unclassified
  // (no policy registered for it, not in the real-field list).
  assert.equal(classifyChurnRow(row({ connector_id: "ynab", stream: "payees" })), "unclassified");
});

test("buildChurnDrilldownRows omits the dry-run command for real-field rows and carries guidance", () => {
  const built = buildChurnDrilldownRows([
    row({ connector_id: "github", stream: "user", connector_instance_id: "cin_gh_1" }),
  ]);
  assert.equal(built[0]?.remediation, "point_in_time_real_field");
  assert.equal(built[0]?.dryRunCommand, null, "real-field rows must not offer a (failing) compaction command");
  assert.ok(built[0]?.pointInTimeGuidance, "real-field rows must carry redesign guidance");
  const guidance = built[0]?.pointInTimeGuidance ?? "";
  assert.match(guidance, NOT_COMPACTABLE_RE);
  assert.match(guidance, APPEND_KEYED_RE);
  assert.match(guidance, FOLLOWER_RE);
});

test("buildChurnDrilldownRows keeps the dry-run command and no guidance for compaction candidates", () => {
  const built = buildChurnDrilldownRows([row({ connector_id: "ynab", stream: "budgets" })]);
  assert.equal(built[0]?.remediation, "lossless_compaction_candidate");
  assert.ok(built[0]?.dryRunCommand, "compaction candidates keep their dry-run command");
  assert.equal(built[0]?.pointInTimeGuidance, null);
});

test("buildChurnDrilldownRows keeps the dry-run command (as a diagnostic) for unclassified rows", () => {
  const built = buildChurnDrilldownRows([unclassifiedRow({ connector_instance_id: "cin_x" })]);
  assert.equal(built[0]?.remediation, "unclassified");
  assert.ok(built[0]?.dryRunCommand, "unclassified rows keep the read-only dry-run as a safe diagnostic");
  assert.equal(built[0]?.pointInTimeGuidance, null);
});

test("pointInTimeGuidance returns null for a compaction candidate", () => {
  assert.equal(pointInTimeGuidance(row({ connector_id: "ynab", stream: "budgets" })), null);
});

test("pointInTimeGuidance names the ynab/accounts balance fields", () => {
  const guidance = pointInTimeGuidance(row({ connector_id: "ynab", stream: "accounts" })) ?? "";
  assert.match(guidance, NOT_COMPACTABLE_RE);
  assert.match(guidance, APPEND_KEYED_RE);
  assert.match(guidance, BALANCE_RE);
});

test("churnDryRunCommand shell-quotes metadata and omits absent connector id", () => {
  assert.equal(
    churnDryRunCommand(
      row({
        connector_id: null,
        connector_instance_id: "cin_owner's_box",
        stream: "raw uploads",
      })
    ),
    "node reference-implementation/scripts/compact-record-history.mjs --connector-instance-id='cin_owner'\\''s_box' --stream='raw uploads'"
  );
});

// ─── Mirror-set integrity ────────────────────────────────────────────────
//
// The two known-lists are the dashboard's mirror of the reference server's
// truth. POINT_IN_TIME_REAL_FIELD_STREAMS mirrors the script's real-field
// guardrail; LOSSLESS_COMPACTION_POLICY_STREAMS mirrors COMPACTION_POLICIES.
// Both are pinned in-sync against the script in
// reference-implementation/test/compact-record-history.test.js. Here we guard
// the local invariant: the two sets must be DISJOINT — a pair can never be
// both "expected retained, never compact" and "has a compaction policy".

test("the real-field list and the compaction-policy list are disjoint", () => {
  for (const { connector, stream } of POINT_IN_TIME_REAL_FIELD_STREAMS) {
    assert.equal(
      LOSSLESS_COMPACTION_POLICY_STREAMS.has(`${connector}/${stream}`),
      false,
      `${connector}/${stream} must not be both a real-field stream and a compaction-policy stream`
    );
  }
});
