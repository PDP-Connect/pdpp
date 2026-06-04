/**
 * Pure presentation logic for the dashboard's record version-churn notice.
 *
 * The notice on /dashboard/records is fed by `/_ref/records/version-stats`
 * (see `listRecordVersionStats`). The route already returns metadata-only
 * rows — counts, risk, and last-history timestamps — with no record payloads.
 * This module turns that row set into operator-readable strings without
 * rendering JSX, so the summary and per-row formatting are unit-testable in
 * Node's test runner. The JSX view imports these helpers; it does not
 * re-derive any of this inline.
 *
 * Voice note: version churn is *retained history* (rows in `record_changes`),
 * not current-data loss. Copy here must explain that distinction and stay in
 * operator voice — this is the owner's own instance state, not a hosted
 * service promise. See `docs/voice-and-framing.md`.
 */
import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import type { RefRecordVersionRisk, RefRecordVersionStatsRow } from "./ref-client.ts";

/**
 * Streams that version on a GENUINELY changing real field carried on the same
 * record as a stable identity — not on a run clock or a byte-identical no-op
 * re-emit. These are NOT compaction candidates: the accepted direction is to
 * split the volatile observation into its own append-keyed point-in-time
 * stream (see design-notes/real-field-version-churn-point-in-time-streams-
 * 2026-06-02.md), never a fingerprint exclusion or a compaction policy that
 * would collapse real history.
 *
 * This list mirrors `POINT_IN_TIME_REAL_FIELD_STREAMS` in
 * `reference-implementation/test/compact-record-history.test.js`, which pins a
 * regression guard asserting these (connector, stream) pairs have NO
 * compaction policy. Because they have no policy,
 * `compact-record-history.mjs` exits with code 2 ("no compaction policy
 * registered") when handed one of these rows — so emitting a dry-run command
 * for them would hand the operator a command that fails and falsely imply
 * compaction is the remediation. Keep the two lists in sync; the console test
 * `version-churn-summary.test.ts` and the script guard test both anchor on
 * this same pair set.
 *
 * Connector id is matched against both the short id (`github`) and the
 * registry-URL form (`https://registry.pdpp.org/connectors/github`), matching
 * the script's `findPolicy` which resolves either.
 */
export const POINT_IN_TIME_REAL_FIELD_STREAMS: ReadonlyArray<{
  connector: string;
  stream: string;
  /** The real field that legitimately moves; surfaced in operator guidance. */
  realField: string;
}> = [
  { connector: "github", stream: "user", realField: "follower / repo / gist counts" },
  { connector: "slack", stream: "channels", realField: "num_members" },
  // ynab/accounts already shipped its forward split: balances moved to the
  // append-keyed `account_stats` observation stream and the current
  // accountRecord no longer carries these fields, so the retained `accounts`
  // history churns ONLY on them — genuine point-in-time observations that are
  // the sole surviving copy (the split stream backfilled nothing). A
  // compaction policy would delete real history; the guardrail test in
  // reference-implementation/test/compact-record-history.test.js forbids one.
  { connector: "ynab", stream: "accounts", realField: "balance / cleared_balance / uncleared_balance" },
];

/**
 * (connector, stream) pairs that have a registered lossless compaction policy
 * in `reference-implementation/scripts/compact-record-history.mjs`
 * (`COMPACTION_POLICIES`). For these — and ONLY these — the read-only dry-run
 * command is a real remediation: the script resolves a policy, prints what it
 * would remove, and (with `--apply`) backs up and deletes provably-redundant
 * adjacent versions. A churn row whose pair is NOT here gets `exit 2` ("no
 * compaction policy registered") if an operator runs the command, so we must
 * not present one for it.
 *
 * This mirrors the script's registry one entry per (connectorId, stream). The
 * script is a Node `.mjs` operational tool in a different workspace; importing
 * it into this browser-bundled module would couple the console build to the
 * reference server's runtime, so the pair-set is duplicated here the same way
 * `POINT_IN_TIME_REAL_FIELD_STREAMS` mirrors its script-side guardrail. The
 * console test `version-churn-summary.test.ts` and the script test
 * `compact-record-history.test.js` both anchor on the registry, so a registry
 * change that is not reflected here fails a test loudly. Connector ids match
 * the same short-or-registry-URL dual form the script's `findPolicy` resolves
 * (we normalize the registry-URL form before lookup).
 */
export const LOSSLESS_COMPACTION_POLICY_STREAMS: ReadonlySet<string> = new Set([
  // connector-fingerprint family
  "gmail/threads",
  "slack/workspace",
  "slack/users",
  "slack/files",
  "slack/channel_memberships",
  "ynab/payee_locations",
  // run-clock / stored-body mirror family
  "gmail/labels",
  "usaa/statements",
  "chase/accounts",
  "chase/statements",
  "chase/transactions",
  "usaa/accounts",
  "usaa/credit_card_billing",
  "ynab/budgets",
  "usaa/transactions",
  "usaa/inbox_messages",
  "chase/current_activity",
  "amazon/orders",
  "chatgpt/custom_instructions",
  "chatgpt/shared_conversations",
  // exact stable-JSON identity family (codex)
  "codex/messages",
  "codex/function_calls",
  "codex/sessions",
  "codex/skills",
  "codex/prompts",
  "codex/rules",
  // exact stable-JSON identity family (claude-code)
  "claude-code/messages",
  "claude-code/attachments",
  "claude-code/sessions",
  "claude-code/skills",
  "claude-code/memory_notes",
  "claude-code/slash_commands",
  // inventory churn-gate family (claude-code)
  "claude-code/backup_inventory",
  "claude-code/cache_inventory",
  "claude-code/config_inventory",
  "claude-code/file_history",
  // inventory churn-gate family (codex)
  "codex/history",
  "codex/session_index",
  "codex/shell_snapshots",
  "codex/config_inventory",
  "codex/cache_inventory",
  "codex/logs",
]);

/**
 * Per-stream review evidence: the ISO 8601 timestamp at which the owner
 * inspected a stream and confirmed it was expected residue. A row can only
 * be classified as `reviewed_compaction_residue` when its `last_history_at`
 * is at or before this timestamp — if new history has been written since the
 * review, the stream re-alarms as a `lossless_compaction_candidate`.
 *
 * Keys are `"connector/stream"` in bare-id form (same normalization as
 * `LOSSLESS_COMPACTION_POLICY_STREAMS`). Values are ISO 8601 UTC strings.
 *
 * Adding an entry here is an explicit owner acknowledgement that:
 *   1. The connector is now fingerprint-correct (no new no-op versions).
 *   2. The dry-run at review time showed `removableVersions=0`.
 *   3. Any `last_history_at` after this timestamp is fresh churn that
 *      post-dates the review and must re-alarm.
 *
 * All keys here MUST also be in `LOSSLESS_COMPACTION_POLICY_STREAMS`; the
 * console test `version-churn-summary.test.ts` guards this invariant.
 */
export const REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT: ReadonlyMap<string, string> = new Map([
  // These four streams accumulated no-op/run-clock history before the
  // fingerprint fix deployed. The dry-run confirmed removableVersions=0 (no
  // adjacent identical versions remain to compact). Values are the observed
  // max(record_changes.emitted_at) at review time; any later history write
  // re-alarms the row.
  ["usaa/accounts", "2026-06-03T19:19:53.633Z"],
  ["usaa/statements", "2026-06-03T04:23:03.255Z"],
  ["chase/statements", "2026-06-03T16:03:36.643Z"],
  ["claude-code/sessions", "2026-06-04T19:15:01.028Z"],
]);

/**
 * (connector, stream) pairs that have a registered lossless compaction policy
 * AND have been owner-reviewed as "expected residue" — history that accumulated
 * before the fingerprint fix was deployed. The fingerprint-correct connector
 * now stops producing no-op versions, so the dry-run returns
 * `removableVersions=0`: there is nothing actionable to compact. The history is
 * legitimate (pre-fix versions that were real at the time they were written).
 *
 * Streams in this set are still in `LOSSLESS_COMPACTION_POLICY_STREAMS` — the
 * compaction policy is valid and the command still works. The distinction is
 * purely presentational: "reviewed residue" means the owner has inspected this
 * state and confirmed it is expected, not actively-growing no-op churn that
 * needs a corrective action now. The dry-run command is still shown (it remains
 * the correct tool for applying `--apply` if the owner ever wants to free the
 * disk space), but the row is no longer framed as "actionable today."
 *
 * Adding a pair to this set is an explicit owner acknowledgement. Do not add
 * pairs whose churn is still actively growing from no-op connector behaviour —
 * those belong in `LOSSLESS_COMPACTION_POLICY_STREAMS` only until the
 * connector is fixed and the state is reviewed.
 *
 * All pairs here MUST also be in `LOSSLESS_COMPACTION_POLICY_STREAMS`; the
 * console test `version-churn-summary.test.ts` guards this invariant.
 *
 * This set is derived from `REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT`'s keys.
 * `classifyChurnRow` uses the map directly (for timestamp comparison); this
 * export exists for the subset invariant test and backwards-compat imports.
 */
export const REVIEWED_COMPACTION_RESIDUE_STREAMS: ReadonlySet<string> = new Set(
  REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.keys()
);

/**
 * Classification of a churn row's remediation path. There are four, mapping
 * to the SLVP version-churn dispositions (see
 * design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md):
 *
 * - `lossless_compaction_candidate`: a no-op / run-clock re-emit on a stream
 *   that already has a registered, fingerprint-mirrored compaction policy. The
 *   read-only dry-run maintenance command is a real remediation here. This is
 *   the only class that gets a command, and it is the only class that is
 *   actually actionable as "clean up redundant history."
 * - `reviewed_compaction_residue`: a stream with a registered compaction policy
 *   that has been owner-reviewed as expected residue. The connector is now
 *   fingerprint-correct (no new no-op versions), and the dry-run confirms
 *   `removableVersions=0`. The history is legitimate pre-fix accumulation. Not
 *   alarming — the dry-run command is still shown for completeness (the owner
 *   may run `--apply` later to free disk space), but this row does not count
 *   as "needs review."
 * - `point_in_time_real_field`: genuine real-field movement on a snapshot
 *   record (a follower count, a member count, a balance). This is EXPECTED
 *   RETAINED HISTORY, not a defect — the observations are the product. NOT
 *   compactable; the durable fix is an append-keyed point-in-time split, which
 *   is owner/OpenSpec-gated. The dashboard must not offer a compaction command
 *   and must not alarm as "needs review."
 * - `unclassified`: a high/watch churn row that is neither a known
 *   compaction-policy stream nor a known real-field stream. This is the only
 *   class that genuinely "needs review" — it may be a new active no-op churn
 *   bug or an unmodeled real-field stream, and the operator should investigate.
 *   It still gets a dry-run command (the read-only script is the safe first
 *   diagnostic step; it will report whether a policy exists).
 */
export type ChurnRemediation =
  | "lossless_compaction_candidate"
  | "reviewed_compaction_residue"
  | "point_in_time_real_field"
  | "unclassified";

/**
 * True when this row is already classified as expected retained history that
 * the operator should NOT be alarmed about: a point-in-time real-field stream
 * or an owner-reviewed compaction residue stream. These rows keep their full
 * counts and risk chip in the table, but they do not count toward the "needs
 * review" headline.
 */
export function isExpectedRetainedHistory(row: RefRecordVersionStatsRow): boolean {
  const classification = classifyChurnRow(row);
  return classification === "point_in_time_real_field" || classification === "reviewed_compaction_residue";
}

/**
 * True when this row still needs operator review: a churn row that is neither
 * an expected real-field point-in-time stream nor a registered lossless
 * compaction candidate. These are the rows the "needs review" headline counts.
 */
export function needsReview(row: RefRecordVersionStatsRow): boolean {
  return classifyChurnRow(row) === "unclassified";
}

// Registry-URL connector id → bare connector id (last path segment), matching
// the dual-form resolution the compaction script's findPolicy performs.
const REGISTRY_CONNECTOR_ID_RE = /\/connectors\/([^/]+)\/?$/;

function normalizeConnectorId(connectorId: string | null): string | null {
  if (!connectorId) {
    return null;
  }
  const match = connectorId.match(REGISTRY_CONNECTOR_ID_RE);
  return match?.[1] ?? connectorId;
}

/**
 * Classify a churn row's remediation path:
 *
 *   1. in the real-field known-list → `point_in_time_real_field`
 *      (expected retained history; never compacted);
 *   2. else if it is in the reviewed-residue map AND `last_history_at` is at
 *      or before the review timestamp → `reviewed_compaction_residue` (policy
 *      exists, dry-run shows 0 removable, owner has reviewed as expected
 *      pre-fix accumulation, and no new history has been written since);
 *   3. else if it has a registered lossless compaction policy →
 *      `lossless_compaction_candidate` (dry-run command is a real fix; this
 *      also catches reviewed-residue streams where new history appeared after
 *      the review, re-alarming them as actionable);
 *   4. else → `unclassified` (genuinely needs review).
 *
 * The real-field list takes precedence over both compaction sets: those pairs
 * intentionally have NO compaction policy, so the ordering is defensive.
 * Reviewed residue requires both list membership AND timestamp evidence: if
 * `last_history_at` is after `reviewed_at`, or if the row has no
 * `last_history_at` (ground-truth unavailable), the guard is treated as
 * unverifiable and the row is demoted to `lossless_compaction_candidate` so
 * the dashboard re-alarms rather than silently suppressing growing churn.
 */
export function classifyChurnRow(row: RefRecordVersionStatsRow): ChurnRemediation {
  const connector = normalizeConnectorId(row.connector_id);
  const isRealField = POINT_IN_TIME_REAL_FIELD_STREAMS.some(
    (entry) => entry.connector === connector && entry.stream === row.stream
  );
  if (isRealField) {
    return "point_in_time_real_field";
  }
  if (connector) {
    const key = `${connector}/${row.stream}`;
    const reviewedAt = REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.get(key);
    if (reviewedAt !== undefined) {
      // Only suppress re-alarm when we have ground-truth evidence that no new
      // history has been written since the review. If last_history_at is null
      // (ground-truth unavailable), we cannot verify the guard — treat as
      // lossless_compaction_candidate so the dashboard re-alarms.
      if (row.last_history_at !== null && row.last_history_at <= reviewedAt) {
        return "reviewed_compaction_residue";
      }
      // last_history_at is absent or after the review timestamp: new churn has
      // appeared since the review. Fall through to lossless_compaction_candidate.
    }
    if (LOSSLESS_COMPACTION_POLICY_STREAMS.has(key)) {
      return "lossless_compaction_candidate";
    }
  }
  return "unclassified";
}

/**
 * Operator guidance for a `point_in_time_real_field` row: why it is not
 * compactable and what the real fix is. Returns null for compaction
 * candidates (they get a dry-run command instead).
 */
export function pointInTimeGuidance(row: RefRecordVersionStatsRow): string | null {
  const connector = normalizeConnectorId(row.connector_id);
  const entry = POINT_IN_TIME_REAL_FIELD_STREAMS.find(
    (candidate) => candidate.connector === connector && candidate.stream === row.stream
  );
  if (!entry) {
    return null;
  }
  return (
    `Real-field point-in-time churn (${entry.realField}). Not compactable — ` +
    "compaction would delete real history. Needs an append-keyed point-in-time " +
    "stream split (see design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md)."
  );
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
  /** Rows that are expected retained point-in-time / real-field history. */
  expectedRetained: number;
  /** Rows still needing operator review (unclassified high/watch churn). */
  needsReview: number;
  /**
   * Rows with a registered policy that have been owner-reviewed as expected
   * pre-fix residue — the fingerprint-correct connector stopped producing
   * no-op versions, dry-run shows removableVersions=0.
   */
  reviewedResidueCount: number;
}

/**
 * Count the supplied churn rows by remediation disposition. Used both by the
 * headline and (via the view) to decide section framing.
 */
export function countChurnDispositions(rows: readonly RefRecordVersionStatsRow[]): ChurnDispositionCounts {
  let needsReviewCount = 0;
  let compactionCandidates = 0;
  let expectedRetained = 0;
  let reviewedResidueCount = 0;
  for (const row of rows) {
    switch (classifyChurnRow(row)) {
      case "unclassified":
        needsReviewCount += 1;
        break;
      case "lossless_compaction_candidate":
        compactionCandidates += 1;
        break;
      case "point_in_time_real_field":
        expectedRetained += 1;
        break;
      case "reviewed_compaction_residue":
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
 *   - otherwise, if every row is already classified (compaction candidates
 *     and/or expected retained history), it says so plainly — an owner whose
 *     only churn is expected point-in-time history or known-safe compaction
 *     candidates is no longer told something is wrong;
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
   * Null for `point_in_time_real_field` rows: those have no compaction policy
   * (the script would exit 2), so offering a command would hand the operator a
   * command that fails and falsely imply compaction is the fix. Such rows
   * carry `pointInTimeGuidance` instead.
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
   * For `point_in_time_real_field` rows: why the row is not compactable and
   * what the real fix is. Null for compaction candidates.
   */
  pointInTimeGuidance: string | null;
  /** Risk reasons supplied by the route, joined for a tooltip. */
  reasons: string | null;
  /** Remediation path: compaction vs append-keyed point-in-time redesign. */
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
    const isRealField = remediation === "point_in_time_real_field";
    return {
      connectorId: row.connector_id,
      connectorInstanceId: row.connector_instance_id,
      key: `${row.connector_instance_id}:${row.stream}`,
      label: churnRowLabel(row),
      risk: row.risk_level,
      stream: row.stream,
      remediation,
      // Real-field rows have no compaction policy (the script exits 2), so they
      // carry redesign guidance instead of a command. Both compaction
      // candidates and unclassified rows keep the read-only dry-run command:
      // for a candidate it reports a real plan; for an unclassified row it is
      // the safe first diagnostic (it prints whether a policy exists at all).
      dryRunCommand: isRealField ? null : churnDryRunCommand(row),
      pointInTimeGuidance: isRealField ? pointInTimeGuidance(row) : null,
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
