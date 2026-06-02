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
  pointInTimeGuidance,
  summarizeVersionChurn,
} from "./version-churn-summary.ts";

const HIGHEST_SIGNAL_RE = /ynab \/ budgets retains 273\.75 versions per current record\./;
const NOT_COMPACTABLE_RE = /[Nn]ot compactable/;
const APPEND_KEYED_RE = /append-keyed/;
const FOLLOWER_RE = /follower/;

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

test("summarizeVersionChurn returns null for an empty row set", () => {
  assert.equal(summarizeVersionChurn([]), null);
});

test("summarizeVersionChurn counts high and watch streams in the headline", () => {
  const rows = [
    row({ risk_level: "high", stream: "budgets" }),
    row({ risk_level: "high", stream: "accounts" }),
    row({ risk_level: "watch", stream: "categories" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.headline, "Version churn needs review: 2 high-risk, 1 watch streams.");
});

test("summarizeVersionChurn uses singular 'stream' for a single row", () => {
  const summary = summarizeVersionChurn([row({ risk_level: "watch" })]);
  assert.ok(summary);
  assert.equal(summary.headline, "Version churn needs review: 1 watch stream.");
});

test("summarizeVersionChurn highest signal reflects the first (highest-risk) row", () => {
  const summary = summarizeVersionChurn([row()]);
  assert.ok(summary);
  assert.match(summary.highestSignal, HIGHEST_SIGNAL_RE);
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

// ─── Compaction-vs-redesign classification ──────────────────────────────
//
// github/user and slack/channels version on a genuinely changing real field
// (follower counts, num_members), have NO compaction policy (the script exits
// 2 for them), and must be split into append-keyed point-in-time streams — not
// compacted. This pair set mirrors POINT_IN_TIME_REAL_FIELD_STREAMS in
// reference-implementation/test/compact-record-history.test.js. Every other
// churn row (gmail/labels, slack/channel_memberships, usaa/*, chase/accounts,
// ynab/*) is a compaction candidate and keeps its dry-run command.

test("classifyChurnRow flags github/user as a real-field point-in-time stream", () => {
  assert.equal(classifyChurnRow(row({ connector_id: "github", stream: "user" })), "point_in_time_real_field");
});

test("classifyChurnRow flags slack/channels as a real-field point-in-time stream", () => {
  assert.equal(classifyChurnRow(row({ connector_id: "slack", stream: "channels" })), "point_in_time_real_field");
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
});

test("classifyChurnRow treats the policied no-op/run-clock streams as compaction candidates", () => {
  // These eight are the live dashboard churn rows; six are compaction
  // candidates (registered policies), and the github/user + slack/channels
  // pair above are the two real-field exceptions.
  const compactable: [string, string][] = [
    ["gmail", "labels"],
    ["slack", "channel_memberships"],
    ["usaa", "accounts"],
    ["usaa", "credit_card_billing"],
    ["chase", "accounts"],
    ["usaa", "statements"],
  ];
  for (const [connector_id, stream] of compactable) {
    assert.equal(
      classifyChurnRow(row({ connector_id, stream })),
      "compaction_candidate",
      `${connector_id}/${stream} should be a compaction candidate`
    );
  }
});

test("classifyChurnRow does not over-match: slack/users and github/repos stay compaction candidates", () => {
  // Only the exact (connector, stream) pairs are real-field; a different slack
  // or github stream is not silently swept into the redesign bucket.
  assert.equal(classifyChurnRow(row({ connector_id: "slack", stream: "users" })), "compaction_candidate");
  assert.equal(classifyChurnRow(row({ connector_id: "github", stream: "repos" })), "compaction_candidate");
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
  assert.equal(built[0]?.remediation, "compaction_candidate");
  assert.ok(built[0]?.dryRunCommand, "compaction candidates keep their dry-run command");
  assert.equal(built[0]?.pointInTimeGuidance, null);
});

test("pointInTimeGuidance returns null for a compaction candidate", () => {
  assert.equal(pointInTimeGuidance(row({ connector_id: "ynab", stream: "budgets" })), null);
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
