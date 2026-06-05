/**
 * Behavioral tests for the pure version-churn presentation module. These run
 * in Node's test runner without a JSX resolver because the module is plain
 * TypeScript — the JSX view imports these helpers rather than re-deriving the
 * logic inline.
 *
 * Disposition is now SERVER-DERIVED (`version_disposition` on each row). The
 * console consumes it; it no longer mirrors the reference server's compaction /
 * point-in-time registries. So these fixtures set `version_disposition`
 * explicitly (that is what the route returns) and the tests assert the console
 * renders/aggregates the field honestly — not that the console re-derives it.
 * The derivation itself is pinned server-side in
 * `reference-implementation/test/version-disposition.test.js` and
 * `record-version-stats.test.js`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RefRecordVersionDisposition, RefRecordVersionStatsRow } from "./ref-client.ts";
import {
  buildChurnDrilldownRows,
  churnDryRunCommand,
  churnRowLabel,
  classifyChurnRow,
  countChurnDispositions,
  isExpectedRetainedHistory,
  needsReview,
  pointInTimeGuidance,
  summarizeVersionChurn,
} from "./version-churn-summary.ts";

const HIGHEST_SIGNAL_RE = /ynab \/ budgets retains 273\.75 versions per current record\./;
const NOT_COMPACTABLE_RE = /[Nn]ot compactable/;
const CANNOT_COMPACT_RE = /compact(able|ed)/;
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
const REVIEWED_RESIDUE_RE = /reviewed residue/;
const COMPACTION_CANDIDATE_RE = /compaction candidate/;
const EXPECTED_RETAINED_HISTORY_RE = /expected retained history/;
const RECURRING_SNAPSHOT_RE = /[Rr]ecurring point-in-time snapshot/;

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
    version_disposition: "lossless_compaction_candidate",
    versions_per_record: 273.75,
    ...overrides,
  };
}

/** A row with a given server-derived disposition (the route's output). */
function rowWith(
  disposition: RefRecordVersionDisposition,
  overrides: Partial<RefRecordVersionStatsRow> = {}
): RefRecordVersionStatsRow {
  return row({ version_disposition: disposition, ...overrides });
}

const candidateRow = (o: Partial<RefRecordVersionStatsRow> = {}) => rowWith("lossless_compaction_candidate", o);
const expectedRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  rowWith("point_in_time_retained_history", { connector_id: "github", stream: "user", ...o });
const reviewedRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  rowWith("reviewed_historical_residue", { connector_id: "usaa", stream: "accounts", ...o });
const recurringRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  rowWith("recurring_point_in_time_snapshot", { connector_id: "claude-code", stream: "sessions", ...o });
const unclassifiedRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  rowWith("active_defect_or_unclassified", { connector_id: "mystery", stream: "widgets", ...o });

// ─── classifyChurnRow is now a straight read of the server field ─────────────

test("classifyChurnRow reads the server-derived version_disposition", () => {
  assert.equal(classifyChurnRow(candidateRow()), "lossless_compaction_candidate");
  assert.equal(classifyChurnRow(expectedRow()), "point_in_time_retained_history");
  assert.equal(classifyChurnRow(reviewedRow()), "reviewed_historical_residue");
  assert.equal(classifyChurnRow(recurringRow()), "recurring_point_in_time_snapshot");
  assert.equal(classifyChurnRow(unclassifiedRow()), "active_defect_or_unclassified");
});

// ─── Disposition-honest headline (the product bug) ───────────────────────────

test("summarizeVersionChurn returns null for an empty row set", () => {
  assert.equal(summarizeVersionChurn([]), null);
});

test("summarizeVersionChurn does NOT say 'needs review' when every row is expected retained history", () => {
  const rows = [
    expectedRow({ connector_id: "github", stream: "user", risk_level: "high" }),
    expectedRow({ connector_id: "slack", stream: "channels", risk_level: "high" }),
    expectedRow({ connector_id: "ynab", stream: "accounts", risk_level: "watch" }),
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

test("recurring snapshots fold into the 'expected retained history' headline bucket", () => {
  const rows = [
    recurringRow({ connector_id: "claude-code", stream: "sessions", risk_level: "watch" }),
    recurringRow({ connector_id: "codex", stream: "sessions", risk_level: "watch" }),
    expectedRow({ connector_id: "github", stream: "user", risk_level: "high" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.needsReview, false);
  assert.match(summary.headline, NO_REVIEW_NEEDED_RE);
  assert.match(summary.headline, THREE_EXPECTED_RETAINED_RE);
  assert.equal(summary.dispositions.expectedRetained, 3);
});

test("summarizeVersionChurn does NOT say 'needs review' when every row is a registered compaction candidate", () => {
  const rows = [
    candidateRow({ connector_id: "ynab", stream: "budgets", risk_level: "high" }),
    candidateRow({ connector_id: "gmail", stream: "labels", risk_level: "watch" }),
    candidateRow({ connector_id: "amazon", stream: "orders", risk_level: "watch" }),
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
    expectedRow({ connector_id: "github", stream: "user", risk_level: "high" }),
    candidateRow({ connector_id: "ynab", stream: "budgets", risk_level: "high" }),
    unclassifiedRow({ risk_level: "high" }),
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
    candidateRow({ connector_id: "ynab", stream: "budgets" }),
    expectedRow({ connector_id: "github", stream: "user" }),
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

// ─── countChurnDispositions ──────────────────────────────────────────────────

test("countChurnDispositions buckets rows by disposition", () => {
  const counts = countChurnDispositions([
    expectedRow({ connector_id: "github", stream: "user" }),
    expectedRow({ connector_id: "slack", stream: "channels" }),
    candidateRow({ connector_id: "ynab", stream: "budgets" }),
    unclassifiedRow(),
  ]);
  assert.deepEqual(counts, { needsReview: 1, compactionCandidates: 1, expectedRetained: 2, reviewedResidueCount: 0 });
});

test("countChurnDispositions folds recurring snapshots into expectedRetained", () => {
  const counts = countChurnDispositions([
    recurringRow({ connector_id: "claude-code", stream: "sessions" }),
    recurringRow({ connector_id: "codex", stream: "sessions" }),
    expectedRow({ connector_id: "github", stream: "user" }),
  ]);
  assert.deepEqual(counts, { needsReview: 0, compactionCandidates: 0, expectedRetained: 3, reviewedResidueCount: 0 });
});

test("isExpectedRetainedHistory / needsReview predicates agree with the disposition", () => {
  assert.equal(isExpectedRetainedHistory(expectedRow()), true);
  assert.equal(isExpectedRetainedHistory(recurringRow()), true);
  assert.equal(isExpectedRetainedHistory(reviewedRow()), true);
  assert.equal(isExpectedRetainedHistory(candidateRow()), false);
  assert.equal(isExpectedRetainedHistory(unclassifiedRow()), false);
  assert.equal(needsReview(expectedRow()), false);
  assert.equal(needsReview(recurringRow()), false);
  assert.equal(needsReview(candidateRow()), false);
  assert.equal(needsReview(unclassifiedRow()), true);
});

test("churnRowLabel falls back to the connector key when no display name is set", () => {
  assert.equal(churnRowLabel(row({ display_name: null, connector_id: "ynab" })), "ynab / budgets");
});

test("churnRowLabel prefers an owner-set display name", () => {
  assert.equal(churnRowLabel(row({ display_name: "Household YNAB" })), "Household YNAB / budgets");
});

// ─── buildChurnDrilldownRows ─────────────────────────────────────────────────

test("buildChurnDrilldownRows surfaces all supplied rows in order", () => {
  const rows = [candidateRow({ stream: "budgets" }), candidateRow({ stream: "accounts", risk_level: "watch" })];
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

// ─── Drilldown command/guidance per disposition ──────────────────────────────

test("buildChurnDrilldownRows omits the dry-run command for point-in-time rows and carries guidance", () => {
  const built = buildChurnDrilldownRows([
    expectedRow({ connector_id: "github", stream: "user", connector_instance_id: "cin_gh_1" }),
  ]);
  assert.equal(built[0]?.remediation, "point_in_time_retained_history");
  assert.equal(built[0]?.dryRunCommand, null, "point-in-time rows must not offer a (failing) compaction command");
  assert.ok(built[0]?.pointInTimeGuidance, "point-in-time rows must carry redesign guidance");
  const guidance = built[0]?.pointInTimeGuidance ?? "";
  assert.match(guidance, NOT_COMPACTABLE_RE);
  assert.match(guidance, APPEND_KEYED_RE);
  assert.match(guidance, FOLLOWER_RE);
});

test("buildChurnDrilldownRows omits the dry-run command for recurring snapshots and carries guidance", () => {
  const built = buildChurnDrilldownRows([
    recurringRow({ connector_id: "claude-code", stream: "sessions", connector_instance_id: "cin_cc_1" }),
  ]);
  assert.equal(built[0]?.remediation, "recurring_point_in_time_snapshot");
  assert.equal(built[0]?.dryRunCommand, null, "recurring snapshots are not compactable — no command");
  assert.ok(built[0]?.pointInTimeGuidance, "recurring snapshots carry expected-history guidance");
  assert.match(built[0]?.pointInTimeGuidance ?? "", RECURRING_SNAPSHOT_RE);
  assert.match(built[0]?.pointInTimeGuidance ?? "", CANNOT_COMPACT_RE);
});

test("buildChurnDrilldownRows keeps the dry-run command and no guidance for compaction candidates", () => {
  const built = buildChurnDrilldownRows([candidateRow({ connector_id: "ynab", stream: "budgets" })]);
  assert.equal(built[0]?.remediation, "lossless_compaction_candidate");
  assert.ok(built[0]?.dryRunCommand, "compaction candidates keep their dry-run command");
  assert.equal(built[0]?.pointInTimeGuidance, null);
});

test("buildChurnDrilldownRows keeps the dry-run command (as a diagnostic) for unclassified rows", () => {
  const built = buildChurnDrilldownRows([unclassifiedRow({ connector_instance_id: "cin_x" })]);
  assert.equal(built[0]?.remediation, "active_defect_or_unclassified");
  assert.ok(built[0]?.dryRunCommand, "unclassified rows keep the read-only dry-run as a safe diagnostic");
  assert.equal(built[0]?.pointInTimeGuidance, null);
});

test("buildChurnDrilldownRows keeps the dry-run command for reviewed residue rows", () => {
  const built = buildChurnDrilldownRows([
    reviewedRow({ connector_id: "usaa", stream: "accounts", connector_instance_id: "cin_usaa_1" }),
  ]);
  assert.equal(built[0]?.remediation, "reviewed_historical_residue");
  assert.ok(built[0]?.dryRunCommand, "reviewed residue rows keep the dry-run command (--apply frees disk)");
  assert.equal(built[0]?.pointInTimeGuidance, null);
});

// ─── pointInTimeGuidance copy ────────────────────────────────────────────────

test("pointInTimeGuidance returns null for a compaction candidate", () => {
  assert.equal(pointInTimeGuidance(candidateRow({ connector_id: "ynab", stream: "budgets" })), null);
});

test("pointInTimeGuidance returns null for reviewed residue", () => {
  assert.equal(pointInTimeGuidance(reviewedRow({ connector_id: "usaa", stream: "accounts" })), null);
});

test("pointInTimeGuidance names the ynab/accounts balance fields", () => {
  const guidance = pointInTimeGuidance(expectedRow({ connector_id: "ynab", stream: "accounts" })) ?? "";
  assert.match(guidance, NOT_COMPACTABLE_RE);
  assert.match(guidance, APPEND_KEYED_RE);
  assert.match(guidance, BALANCE_RE);
});

test("pointInTimeGuidance describes recurring snapshots as expected non-compactable history", () => {
  const guidance = pointInTimeGuidance(recurringRow()) ?? "";
  assert.match(guidance, RECURRING_SNAPSHOT_RE);
  assert.match(guidance, CANNOT_COMPACT_RE);
});

// ─── Reviewed residue + recurring snapshots in the headline together ─────────

test("summarizeVersionChurn names reviewed residue streams and says no review needed when all classified", () => {
  const rows = [
    reviewedRow({ connector_id: "usaa", stream: "accounts", risk_level: "watch" }),
    reviewedRow({ connector_id: "usaa", stream: "statements", risk_level: "watch" }),
    reviewedRow({ connector_id: "chase", stream: "statements", risk_level: "watch" }),
    recurringRow({ connector_id: "claude-code", stream: "sessions", risk_level: "watch" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.needsReview, false);
  assert.doesNotMatch(summary.headline, NEEDS_REVIEW_RE);
  assert.match(summary.headline, NO_REVIEW_NEEDED_RE);
  assert.match(summary.headline, REVIEWED_RESIDUE_RE);
  // 3 reviewed residue + 1 recurring snapshot (folded into expected retained).
  assert.equal(summary.dispositions.reviewedResidueCount, 3);
  assert.equal(summary.dispositions.expectedRetained, 1);
  assert.equal(summary.dispositions.needsReview, 0);
  assert.equal(summary.dispositions.compactionCandidates, 0);
});

test("summarizeVersionChurn includes reviewed residue count even alongside other dispositions", () => {
  const rows = [
    reviewedRow({ connector_id: "usaa", stream: "accounts", risk_level: "watch" }),
    candidateRow({ connector_id: "ynab", stream: "budgets", risk_level: "high" }),
    expectedRow({ connector_id: "github", stream: "user", risk_level: "high" }),
  ];
  const summary = summarizeVersionChurn(rows);
  assert.ok(summary);
  assert.equal(summary.needsReview, false);
  assert.match(summary.headline, NO_REVIEW_NEEDED_RE);
  assert.match(summary.headline, REVIEWED_RESIDUE_RE);
  assert.match(summary.headline, COMPACTION_CANDIDATE_RE);
  assert.match(summary.headline, EXPECTED_RETAINED_HISTORY_RE);
});

// ─── Defensive: a row missing the field falls back to needs-review ───────────

test("classifyChurnRow falls back to active_defect_or_unclassified when the field is absent", () => {
  // The contract requires version_disposition, but the console must not crash if
  // an older server omits it — conservative fallback is "needs review". Build the
  // row WITHOUT the field rather than deleting it (and exercise the same path an
  // older envelope would produce).
  const { version_disposition: _omitted, ...legacy } = row();
  assert.equal(classifyChurnRow(legacy as RefRecordVersionStatsRow), "active_defect_or_unclassified");
  assert.equal(needsReview(legacy as RefRecordVersionStatsRow), true);
});
