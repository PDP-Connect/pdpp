// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * biome-ignore-all lint/performance/useTopLevelRegex: Copy assertions are
 * clearer as local regex literals in tests.
 *
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
  remediationChipLabel,
  remediationForRow,
  remediationGuidance,
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
    // Default remediation is `none`; remediation-specific fixtures override it.
    // The server derives both fields; these fixtures stand in for the route's
    // already-derived output (the console never re-derives them).
    version_remediation: "none",
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
    expectedRow({ connector_id: "github", risk_level: "high", stream: "user" }),
    expectedRow({ connector_id: "slack", risk_level: "high", stream: "channels" }),
    expectedRow({ connector_id: "ynab", risk_level: "watch", stream: "accounts" }),
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
    recurringRow({ connector_id: "claude-code", risk_level: "watch", stream: "sessions" }),
    recurringRow({ connector_id: "codex", risk_level: "watch", stream: "sessions" }),
    expectedRow({ connector_id: "github", risk_level: "high", stream: "user" }),
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
    candidateRow({ connector_id: "ynab", risk_level: "high", stream: "budgets" }),
    candidateRow({ connector_id: "gmail", risk_level: "watch", stream: "labels" }),
    candidateRow({ connector_id: "amazon", risk_level: "watch", stream: "orders" }),
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
    expectedRow({ connector_id: "github", risk_level: "high", stream: "user" }),
    candidateRow({ connector_id: "ynab", risk_level: "high", stream: "budgets" }),
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
  assert.deepEqual(counts, { compactionCandidates: 1, expectedRetained: 2, needsReview: 1, reviewedResidueCount: 0 });
});

test("countChurnDispositions folds recurring snapshots into expectedRetained", () => {
  const counts = countChurnDispositions([
    recurringRow({ connector_id: "claude-code", stream: "sessions" }),
    recurringRow({ connector_id: "codex", stream: "sessions" }),
    expectedRow({ connector_id: "github", stream: "user" }),
  ]);
  assert.deepEqual(counts, { compactionCandidates: 0, expectedRetained: 3, needsReview: 0, reviewedResidueCount: 0 });
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
  assert.equal(churnRowLabel(row({ connector_id: "ynab", display_name: null })), "ynab / budgets");
});

test("churnRowLabel prefers an owner-set display name", () => {
  assert.equal(churnRowLabel(row({ display_name: "Household YNAB" })), "Household YNAB / budgets");
});

// ─── buildChurnDrilldownRows ─────────────────────────────────────────────────

test("buildChurnDrilldownRows surfaces all supplied rows in order", () => {
  const rows = [candidateRow({ stream: "budgets" }), candidateRow({ risk_level: "watch", stream: "accounts" })];
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
    expectedRow({ connector_id: "github", connector_instance_id: "cin_gh_1", stream: "user" }),
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
    recurringRow({ connector_id: "claude-code", connector_instance_id: "cin_cc_1", stream: "sessions" }),
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
    reviewedRow({ connector_id: "usaa", connector_instance_id: "cin_usaa_1", stream: "accounts" }),
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
    reviewedRow({ connector_id: "usaa", risk_level: "watch", stream: "accounts" }),
    reviewedRow({ connector_id: "usaa", risk_level: "watch", stream: "statements" }),
    reviewedRow({ connector_id: "chase", risk_level: "watch", stream: "statements" }),
    recurringRow({ connector_id: "claude-code", risk_level: "watch", stream: "sessions" }),
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
    reviewedRow({ connector_id: "usaa", risk_level: "watch", stream: "accounts" }),
    candidateRow({ connector_id: "ynab", risk_level: "high", stream: "budgets" }),
    expectedRow({ connector_id: "github", risk_level: "high", stream: "user" }),
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

// ═══════════════════════════════════════════════════════════════════════════
// version_remediation — the orthogonal next-action axis the console consumes
// (OpenSpec add-version-remediation-disposition, AC-9 console rendering)
//
// The console does NOT re-derive remediation — these fixtures set the
// server-derived `version_remediation` explicitly (exactly what the route
// returns) and assert the console surfaces it honestly, with distinct copy for
// fingerprint-pending vs. migration-pending vs. retention-policy.
// ═══════════════════════════════════════════════════════════════════════════

// The four evidence rows, each carrying the disposition + remediation the server
// derives for it.
const fingerprintChaseRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  reviewedRow({
    connector_id: "chase",
    stream: "statements",
    version_remediation: "content_fingerprint_pending",
    ...o,
  });
const fingerprintUsaaRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  reviewedRow({
    connector_id: "usaa",
    stream: "statements",
    version_remediation: "content_fingerprint_pending",
    ...o,
  });
const migrationRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  reviewedRow({
    connector_id: "usaa",
    stream: "accounts",
    version_remediation: "owner_migration_pending",
    ...o,
  });
const retentionRow = (o: Partial<RefRecordVersionStatsRow> = {}) =>
  recurringRow({
    connector_id: "claude-code",
    stream: "sessions",
    version_remediation: "owner_retention_policy",
    ...o,
  });

const FINGERPRINT_PENDING_RE = /[Ff]ingerprint pending/;
const MIGRATION_PENDING_RE = /[Mm]igration pending/;
const RETENTION_POLICY_RE = /[Rr]etention policy/;
const DO_NOT_COMPACT_RE = /[Dd]o not compact/;

test("remediationForRow reads the server field directly (no re-derivation)", () => {
  assert.equal(remediationForRow(fingerprintChaseRow()), "content_fingerprint_pending");
  assert.equal(remediationForRow(migrationRow()), "owner_migration_pending");
  assert.equal(remediationForRow(retentionRow()), "owner_retention_policy");
  assert.equal(remediationForRow(candidateRow()), "none");
});

test("remediationForRow falls back to none when the field is absent", () => {
  const { version_remediation: _omitted, ...legacy } = reviewedRow();
  assert.equal(remediationForRow(legacy as RefRecordVersionStatsRow), "none");
});

test("remediationChipLabel is null for a none remediation and a short label otherwise", () => {
  assert.equal(remediationChipLabel(candidateRow()), null);
  assert.equal(remediationChipLabel(fingerprintChaseRow()), "fingerprint pending");
  assert.equal(remediationChipLabel(migrationRow()), "migration pending");
  assert.equal(remediationChipLabel(retentionRow()), "retention policy");
});

test("remediationGuidance gives distinct fingerprint-pending vs migration-pending copy", () => {
  const fingerprint = remediationGuidance(fingerprintChaseRow());
  const migration = remediationGuidance(migrationRow());
  assert.ok(fingerprint);
  assert.ok(migration);
  assert.match(fingerprint, FINGERPRINT_PENDING_RE);
  assert.match(migration, MIGRATION_PENDING_RE);
  // The two reviewed-residue rows must NOT read identically — that is the whole
  // point of the remediation axis.
  assert.notEqual(fingerprint, migration);
  // Fingerprint guidance says compaction frees nothing; migration says do not
  // compact (the strongest, most distinct signal).
  assert.match(fingerprint, /compaction frees nothing|frees nothing/);
  assert.match(migration, DO_NOT_COMPACT_RE);
});

test("remediationGuidance names the owner retention decision for a recurring snapshot", () => {
  const guidance = remediationGuidance(retentionRow());
  assert.ok(guidance);
  assert.match(guidance, RETENTION_POLICY_RE);
  // The owner may decline — the copy must say so (it is not a defect).
  assert.match(guidance, /decline/);
});

test("remediationGuidance is null for a none remediation", () => {
  assert.equal(remediationGuidance(candidateRow()), null);
  assert.equal(remediationGuidance(unclassifiedRow()), null);
});

test("buildChurnDrilldownRows surfaces the remediation chip, action, and guidance per row", () => {
  const built = buildChurnDrilldownRows([fingerprintChaseRow(), migrationRow(), retentionRow(), candidateRow()]);
  assert.equal(built.length, 4);

  assert.equal(built[0]?.remediationAction, "content_fingerprint_pending");
  assert.equal(built[0]?.remediationChip, "fingerprint pending");
  assert.match(built[0]?.remediationGuidance ?? "", FINGERPRINT_PENDING_RE);
  // A reviewed-residue row still keeps its read-only dry-run command — the
  // remediation line augments it, it does not replace it.
  assert.ok(built[0]?.dryRunCommand);

  assert.equal(built[1]?.remediationAction, "owner_migration_pending");
  assert.equal(built[1]?.remediationChip, "migration pending");
  assert.match(built[1]?.remediationGuidance ?? "", MIGRATION_PENDING_RE);
  assert.ok(built[1]?.dryRunCommand);

  assert.equal(built[2]?.remediationAction, "owner_retention_policy");
  assert.equal(built[2]?.remediationChip, "retention policy");
  assert.match(built[2]?.remediationGuidance ?? "", RETENTION_POLICY_RE);
  // A recurring snapshot is not compactable — no command, guidance instead.
  assert.equal(built[2]?.dryRunCommand, null);

  // A none-remediation candidate advertises no chip or guidance line, but keeps
  // its dry-run command (its action lives there).
  assert.equal(built[3]?.remediationAction, "none");
  assert.equal(built[3]?.remediationChip, null);
  assert.equal(built[3]?.remediationGuidance, null);
  assert.ok(built[3]?.dryRunCommand);
});

test("remediation never changes the disposition or the needs-review headline", () => {
  // A fingerprint-pending row is still reviewed residue (not needs-review); a
  // retention-policy row is still a recurring snapshot. Remediation is additive.
  assert.equal(classifyChurnRow(fingerprintChaseRow()), "reviewed_historical_residue");
  assert.equal(needsReview(fingerprintChaseRow()), false);
  assert.equal(classifyChurnRow(retentionRow()), "recurring_point_in_time_snapshot");
  assert.equal(needsReview(retentionRow()), false);

  // The "needs review" headline counts ONLY unclassified rows, regardless of any
  // remediation on the other rows.
  const summary = summarizeVersionChurn([fingerprintChaseRow(), fingerprintUsaaRow(), migrationRow(), retentionRow()]);
  assert.ok(summary);
  assert.equal(summary.needsReview, false);
});
