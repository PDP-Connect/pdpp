/**
 * Pure presentation logic for the dashboard's record version-churn notice.
 *
 * The notice on /dashboard/records is fed by `/_ref/records/version-stats`
 * (see `listRecordVersionStats`). The route already returns metadata-only
 * rows — counts, risk, last-history timestamps — with no record payloads, AND a
 * reference-DERIVED `version_disposition` per row. This module turns that row
 * set into operator-readable strings without rendering JSX, so the summary and
 * per-row formatting are unit-testable in Node's test runner. The JSX view
 * imports these helpers; it does not re-derive any of this inline.
 *
 * Source of truth: disposition is now computed server-side (see
 * `reference-implementation/server/version-disposition.js`) from
 * reference-controlled signals — the registered compaction-policy registry, the
 * point-in-time / recurring-snapshot stream registries, and the owner-reviewed
 * residue evidence. The console no longer mirrors those registries; it consumes
 * `row.version_disposition` directly. A connector cannot influence it.
 *
 * Voice note: version churn is *retained history* (rows in `record_changes`),
 * not current-data loss. Copy here must explain that distinction and stay in
 * operator voice — this is the owner's own instance state, not a hosted
 * service promise. See `docs/voice-and-framing.md`.
 */
import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import type { RefRecordVersionDisposition, RefRecordVersionRisk, RefRecordVersionStatsRow } from "./ref-client.ts";

/**
 * A churn row's remediation disposition. This is now the same five-way
 * vocabulary the reference server derives (`version_disposition`), consumed
 * directly rather than re-derived. Mapping to the prior four-way console
 * vocabulary:
 *
 * - `active_defect_or_unclassified` (was `unclassified`): a high/watch churn
 *   row with no recognized disposition. The ONLY class that "needs review" — it
 *   may be a new no-op churn bug or an unmodeled real-field stream. It still
 *   gets a read-only dry-run command as the safe first diagnostic.
 * - `lossless_compaction_candidate`: a stream with a registered,
 *   fingerprint-mirrored compaction policy whose redundant adjacent versions
 *   are still removable. The read-only dry-run command is a real remediation.
 * - `reviewed_historical_residue` (was `reviewed_compaction_residue`): a
 *   policied stream the owner reviewed as expected pre-fix accumulation
 *   (`removableVersions = 0`, no new history since review). Not alarming; the
 *   dry-run command is still shown (the owner may run `--apply` to free disk).
 * - `point_in_time_retained_history` (was `point_in_time_real_field`): genuine
 *   real-field movement on a snapshot record whose sampled metric was split
 *   into an append-keyed sibling. Expected retained history; NOT compactable
 *   (no command — the script would exit 2). Carries redesign guidance.
 * - `recurring_point_in_time_snapshot`: an evolving local-agent session stream
 *   whose whole record is the moving observation. Expected retained history;
 *   NOT compactable and does NOT re-alarm on growth (growth is its expected,
 *   non-removable signal). No command; carries guidance copy.
 */
export type ChurnRemediation = RefRecordVersionDisposition;

/**
 * Display-only descriptions of the real field that legitimately moves on each
 * point-in-time split residual stream. This is NOT used to classify a row — the
 * server already decided the disposition. It only supplies the human-readable
 * field name in the operator guidance for a row the server classified as
 * `point_in_time_retained_history`. Keyed by bare `connector/stream`.
 */
const POINT_IN_TIME_REAL_FIELD_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ["github/user", "follower / repo / gist counts"],
  ["slack/channels", "num_members"],
  ["ynab/accounts", "balance / cleared_balance / uncleared_balance"],
]);

/** Dispositions that are expected retained history (never "needs review"). */
const EXPECTED_RETAINED_DISPOSITIONS: ReadonlySet<ChurnRemediation> = new Set<ChurnRemediation>([
  "reviewed_historical_residue",
  "point_in_time_retained_history",
  "recurring_point_in_time_snapshot",
]);

/** Dispositions that are not compactable (offer no dry-run command). */
const NOT_COMPACTABLE_DISPOSITIONS: ReadonlySet<ChurnRemediation> = new Set<ChurnRemediation>([
  "point_in_time_retained_history",
  "recurring_point_in_time_snapshot",
]);

/**
 * True when this row is expected retained history the operator should NOT be
 * alarmed about. These rows keep their full counts and risk chip in the table,
 * but they do not count toward the "needs review" headline.
 */
export function isExpectedRetainedHistory(row: RefRecordVersionStatsRow): boolean {
  return EXPECTED_RETAINED_DISPOSITIONS.has(classifyChurnRow(row));
}

/**
 * True when this row still needs operator review: the server-derived
 * disposition is `active_defect_or_unclassified`. These are the rows the
 * "needs review" headline counts.
 */
export function needsReview(row: RefRecordVersionStatsRow): boolean {
  return classifyChurnRow(row) === "active_defect_or_unclassified";
}

// Registry-URL connector id → bare connector id; also strips the
// `local-device:` multi-device prefix. Matches the server's normalization so
// guidance copy resolves for every connector_id form.
const REGISTRY_CONNECTOR_ID_RE = /\/connectors\/([^/]+)\/?$/;

function normalizeConnectorId(connectorId: string | null): string | null {
  if (!connectorId) {
    return null;
  }
  const match = connectorId.match(REGISTRY_CONNECTOR_ID_RE);
  const bare = match?.[1] ?? connectorId;
  return bare.startsWith("local-device:") ? bare.slice("local-device:".length) : bare;
}

/**
 * The row's remediation disposition. Now a straight read of the
 * reference-derived `version_disposition` — the console no longer mirrors the
 * server's registries. Falls back to `active_defect_or_unclassified` only if a
 * row somehow arrives without the field (defensive; the contract requires it).
 */
export function classifyChurnRow(row: RefRecordVersionStatsRow): ChurnRemediation {
  return row.version_disposition ?? "active_defect_or_unclassified";
}

/**
 * Operator guidance for a row that is expected, non-compactable retained
 * history (`point_in_time_retained_history` or `recurring_point_in_time_snapshot`):
 * why it is not compactable and what (if anything) the real fix is. Returns
 * null for compaction candidates and reviewed residue (they get a dry-run
 * command instead).
 */
export function pointInTimeGuidance(row: RefRecordVersionStatsRow): string | null {
  const disposition = classifyChurnRow(row);
  if (disposition === "recurring_point_in_time_snapshot") {
    return (
      "Recurring point-in-time snapshot — expected retained history. The whole " +
      "record is the evolving observation (it grows on each real session pass), " +
      "so it cannot be append-split or compacted. Not a defect; growth is normal."
    );
  }
  if (disposition === "point_in_time_retained_history") {
    const connector = normalizeConnectorId(row.connector_id);
    const realField = connector ? POINT_IN_TIME_REAL_FIELD_DESCRIPTIONS.get(`${connector}/${row.stream}`) : undefined;
    const fieldClause = realField ? ` (${realField})` : "";
    return (
      `Real-field point-in-time churn${fieldClause}. Not compactable — ` +
      "compaction would delete real history. The retained entity history is the " +
      "sole surviving copy of these observations after the append-keyed " +
      "point-in-time stream split."
    );
  }
  return null;
}

/** Human-readable connector/stream label for one churn row. */
export function churnRowLabel(row: RefRecordVersionStatsRow): string {
  const connector = formatConnectorNameForDisplay({
    connectorId: row.connector_id ?? row.connector_instance_id,
    displayName: row.display_name,
  });
  return `${connector} / ${row.stream}`;
}

/** Per-disposition counts over a churn row set. */
export interface ChurnDispositionCounts {
  /** Rows with a registered lossless compaction policy (not yet reviewed). */
  compactionCandidates: number;
  /** Rows that are expected retained point-in-time / recurring-snapshot history. */
  expectedRetained: number;
  /** Rows still needing operator review (unclassified high/watch churn). */
  needsReview: number;
  /**
   * Rows with a registered policy the owner reviewed as expected pre-fix
   * residue — the fingerprint-correct connector stopped producing no-op
   * versions, dry-run shows removableVersions=0.
   */
  reviewedResidueCount: number;
}

/**
 * Count the supplied churn rows by remediation disposition. Used both by the
 * headline and (via the view) to decide section framing.
 *
 * `expectedRetained` folds together `point_in_time_retained_history` and
 * `recurring_point_in_time_snapshot` — both are expected, non-compactable
 * retained history that reads the same in the headline. `reviewedResidueCount`
 * stays its own bucket because its copy and command differ.
 */
export function countChurnDispositions(rows: readonly RefRecordVersionStatsRow[]): ChurnDispositionCounts {
  let needsReviewCount = 0;
  let compactionCandidates = 0;
  let expectedRetained = 0;
  let reviewedResidueCount = 0;
  for (const row of rows) {
    switch (classifyChurnRow(row)) {
      case "active_defect_or_unclassified":
        needsReviewCount += 1;
        break;
      case "lossless_compaction_candidate":
        compactionCandidates += 1;
        break;
      case "point_in_time_retained_history":
      case "recurring_point_in_time_snapshot":
        expectedRetained += 1;
        break;
      case "reviewed_historical_residue":
        reviewedResidueCount += 1;
        break;
      default:
        break;
    }
  }
  return { needsReview: needsReviewCount, compactionCandidates, expectedRetained, reviewedResidueCount };
}

function pluralStreams(n: number): string {
  return n === 1 ? "stream" : "streams";
}

/**
 * Concise headline summarizing the non-normal churn rows. This is the
 * collapsed summary of the disclosure, so the highest-signal information is
 * visible without expanding.
 *
 * The headline is disposition-honest, not a blanket "needs review":
 *
 *   - if any row is unclassified, it leads with the count that genuinely needs
 *     review;
 *   - otherwise, if every row is already classified, it says so plainly — an
 *     owner whose only churn is expected retained history or known-safe
 *     compaction candidates is no longer told something is wrong;
 *   - the remaining dispositions are named in the same line so the banner is
 *     never silently hiding a count.
 *
 * Thresholds are untouched: every non-normal row still surfaces in the table.
 * What changes is whether the owner is alarmed.
 *
 * Returns null when there are no rows to summarize (caller renders nothing).
 */
export function summarizeVersionChurn(rows: readonly RefRecordVersionStatsRow[]): {
  /** The collapsed banner headline; honest about whether review is needed. */
  headline: string;
  /** "Highest signal: ynab / budgets retains 273.75 versions per current record." */
  highestSignal: string;
  /** True when at least one row is unclassified and genuinely needs review. */
  needsReview: boolean;
  /** Per-disposition counts, for the view's section framing. */
  dispositions: ChurnDispositionCounts;
} | null {
  const strongest = rows[0];
  if (!strongest) {
    return null;
  }
  const dispositions = countChurnDispositions(rows);
  const segments: string[] = [];
  if (dispositions.needsReview > 0) {
    segments.push(`${dispositions.needsReview} ${pluralStreams(dispositions.needsReview)} need review`);
  }
  if (dispositions.compactionCandidates > 0) {
    segments.push(
      `${dispositions.compactionCandidates} compaction ${dispositions.compactionCandidates === 1 ? "candidate" : "candidates"}`
    );
  }
  if (dispositions.reviewedResidueCount > 0) {
    segments.push(
      `${dispositions.reviewedResidueCount} reviewed ${dispositions.reviewedResidueCount === 1 ? "residue" : "residue streams"}`
    );
  }
  if (dispositions.expectedRetained > 0) {
    segments.push(`${dispositions.expectedRetained} expected retained history`);
  }
  const breakdown = segments.join(", ");

  // The leading clause is the honest verdict. Only an unclassified row makes
  // the banner say "needs review"; otherwise the churn is already accounted
  // for and the banner reads as informational.
  const headline =
    dispositions.needsReview > 0
      ? `Version churn needs review: ${breakdown}.`
      : `Version churn is classified — no review needed: ${breakdown}.`;

  return {
    headline,
    highestSignal: `Highest signal: ${churnRowLabel(strongest)} retains ${strongest.versions_per_record.toLocaleString()} versions per current record.`,
    needsReview: dispositions.needsReview > 0,
    dispositions,
  };
}

export interface ChurnRowCell {
  label: string;
  /** True when the underlying count was not available from the ground-truth source. */
  unknown?: boolean;
}

export interface ChurnDrilldownRow {
  /** Connector type id, when the version-stats source can name it. */
  connectorId: string | null;
  /** Concrete owner connection / connector instance that owns this history. */
  connectorInstanceId: string;
  /** Rows currently live in `records` (deleted = false). */
  current: ChurnRowCell;
  /**
   * Read-only operational command that reports what compaction would remove.
   * Null for non-compactable rows (`point_in_time_retained_history`,
   * `recurring_point_in_time_snapshot`): those have no compaction policy the
   * script would resolve (it would exit 2), so offering a command would hand
   * the operator a failing command and falsely imply compaction is the fix.
   * Such rows carry `pointInTimeGuidance` instead.
   */
  dryRunCommand: string | null;
  /** Total rows in `record_changes` for this (connection, stream). */
  history: ChurnRowCell;
  key: string;
  /** Distinct record keys observed in history; null when ground-truth lacks it. */
  keys: ChurnRowCell;
  label: string;
  /** Most recent history-write timestamp (ISO), or null when unavailable. */
  lastHistoryAt: string | null;
  /**
   * For non-compactable expected-history rows: why the row is not compactable
   * and what (if anything) the real fix is. Null for compaction candidates and
   * reviewed residue.
   */
  pointInTimeGuidance: string | null;
  /** Risk reasons supplied by the route, joined for a tooltip. */
  reasons: string | null;
  /** Remediation disposition (the server-derived version_disposition). */
  remediation: ChurnRemediation;
  risk: RefRecordVersionRisk;
  stream: string;
  /** Versions retained per current record — the headline ratio. */
  versionsPerRecord: ChurnRowCell;
}

function countCell(value: number | null | undefined): ChurnRowCell {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { label: "—", unknown: true };
  }
  return { label: value.toLocaleString() };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function churnDryRunCommand(row: RefRecordVersionStatsRow): string {
  const args = [
    "node",
    "reference-implementation/scripts/compact-record-history.mjs",
    `--connector-instance-id=${shellQuote(row.connector_instance_id)}`,
    `--stream=${shellQuote(row.stream)}`,
  ];
  if (row.connector_id) {
    args.push(`--connector-id=${shellQuote(row.connector_id)}`);
  }
  return args.join(" ");
}

/**
 * Build the operator-readable drilldown rows. One per supplied churn row, in
 * the order the route returned them (already risk-sorted, highest first).
 *
 * Metadata only: no record payloads are read or surfaced. Counts that the
 * ground-truth source did not provide render as "—" rather than a misleading
 * zero, matching the honest-by-default rule used elsewhere in the dashboard.
 */
export function buildChurnDrilldownRows(rows: readonly RefRecordVersionStatsRow[]): ChurnDrilldownRow[] {
  return rows.map((row) => {
    const remediation = classifyChurnRow(row);
    const notCompactable = NOT_COMPACTABLE_DISPOSITIONS.has(remediation);
    return {
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      key: `${row.connector_instance_id}:${row.stream}`,
      label: churnRowLabel(row),
      risk: row.risk_level,
      stream: row.stream,
      remediation,
      // Non-compactable rows have no compaction policy the script resolves (it
      // exits 2), so they carry redesign/expected-history guidance instead of a
      // command. Compaction candidates, reviewed residue, and unclassified rows
      // keep the read-only dry-run command: for a candidate it reports a real
      // plan, for reviewed residue `--apply` frees disk, and for an unclassified
      // row it is the safe first diagnostic (it prints whether a policy exists).
      dryRunCommand: notCompactable ? null : churnDryRunCommand(row),
      pointInTimeGuidance: notCompactable ? pointInTimeGuidance(row) : null,
      versionsPerRecord: {
        label: row.versions_per_record.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      },
      current: countCell(row.current_record_count),
      history: countCell(row.record_history_count),
      keys: countCell(row.record_key_count),
      lastHistoryAt: row.last_history_at,
      reasons: row.risk_reasons.length > 0 ? row.risk_reasons.join("; ") : null,
    };
  });
}
