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
 * Classification of a churn row's remediation path. There are three, mapping
 * to the SLVP version-churn dispositions (see
 * design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md):
 *
 * - `lossless_compaction_candidate`: a no-op / run-clock re-emit on a stream
 *   that already has a registered, fingerprint-mirrored compaction policy. The
 *   read-only dry-run maintenance command is a real remediation here. This is
 *   the only class that gets a command, and it is the only class that is
 *   actually actionable as "clean up redundant history."
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
export type ChurnRemediation = "lossless_compaction_candidate" | "point_in_time_real_field" | "unclassified";

/**
 * True when this row is already classified as expected retained history that
 * the operator should NOT be alarmed about: a point-in-time real-field stream
 * (or, in future, any disposition the connector declares as expected). These
 * rows keep their full counts and risk chip in the table, but they do not
 * count toward the "needs review" headline.
 */
export function isExpectedRetainedHistory(row: RefRecordVersionStatsRow): boolean {
  return classifyChurnRow(row) === "point_in_time_real_field";
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
 *   2. else if it has a registered lossless compaction policy →
 *      `lossless_compaction_candidate` (dry-run command is a real fix);
 *   3. else → `unclassified` (genuinely needs review).
 *
 * The real-field list takes precedence: those pairs intentionally have NO
 * compaction policy, so this ordering is defensive only — a pair can never be
 * in both sets without failing the in-sync guardrail tests.
 */
export function classifyChurnRow(row: RefRecordVersionStatsRow): ChurnRemediation {
  const connector = normalizeConnectorId(row.connector_id);
  const isRealField = POINT_IN_TIME_REAL_FIELD_STREAMS.some(
    (entry) => entry.connector === connector && entry.stream === row.stream
  );
  if (isRealField) {
    return "point_in_time_real_field";
  }
  if (connector && LOSSLESS_COMPACTION_POLICY_STREAMS.has(`${connector}/${row.stream}`)) {
    return "lossless_compaction_candidate";
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
  /** Rows with a registered lossless compaction policy. */
  compactionCandidates: number;
  /** Rows that are expected retained point-in-time / real-field history. */
  expectedRetained: number;
  /** Rows still needing operator review (unclassified high/watch churn). */
  needsReview: number;
}

/**
 * Count the supplied churn rows by remediation disposition. Used both by the
 * headline and (via the view) to decide section framing.
 */
export function countChurnDispositions(rows: readonly RefRecordVersionStatsRow[]): ChurnDispositionCounts {
  let needsReviewCount = 0;
  let compactionCandidates = 0;
  let expectedRetained = 0;
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
      default:
        break;
    }
  }
  return { needsReview: needsReviewCount, compactionCandidates, expectedRetained };
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
