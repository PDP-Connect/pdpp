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
const POINT_IN_TIME_REAL_FIELD_STREAMS: ReadonlyArray<{
  connector: string;
  stream: string;
  /** The real field that legitimately moves; surfaced in operator guidance. */
  realField: string;
}> = [
  { connector: "github", stream: "user", realField: "follower / repo / gist counts" },
  { connector: "slack", stream: "channels", realField: "num_members" },
];

/**
 * Classification of a churn row's remediation path.
 *
 * - `compaction_candidate`: the churn is no-op / run-clock re-emit; the
 *   read-only dry-run maintenance command is the safe place to start.
 * - `point_in_time_real_field`: the churn is genuine real-field movement on a
 *   snapshot record. NOT compactable — needs an append-keyed point-in-time
 *   split. The dashboard must not offer a compaction command here.
 */
export type ChurnRemediation = "compaction_candidate" | "point_in_time_real_field";

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
 * Classify a churn row's remediation path. A row is `point_in_time_real_field`
 * iff its (connector, stream) is in the real-field known-list; everything else
 * is a `compaction_candidate` (it either has a registered policy or is a
 * not-yet-classified high-churn stream the operator should investigate, and in
 * both cases the read-only dry-run is the correct, safe first step).
 */
export function classifyChurnRow(row: RefRecordVersionStatsRow): ChurnRemediation {
  const connector = normalizeConnectorId(row.connector_id);
  const isRealField = POINT_IN_TIME_REAL_FIELD_STREAMS.some(
    (entry) => entry.connector === connector && entry.stream === row.stream
  );
  return isRealField ? "point_in_time_real_field" : "compaction_candidate";
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

/**
 * Concise headline summarizing the non-normal churn rows. This stays the
 * collapsed summary of the disclosure so the highest-signal information is
 * visible without expanding.
 *
 * Returns null when there are no rows to summarize (caller renders nothing).
 */
export function summarizeVersionChurn(rows: readonly RefRecordVersionStatsRow[]): {
  /** "Version churn needs review: 5 high-risk, 3 watch streams." */
  headline: string;
  /** "Highest signal: ynab / budgets retains 273.75 versions per current record." */
  highestSignal: string;
} | null {
  const strongest = rows[0];
  if (!strongest) {
    return null;
  }
  const high = rows.filter((row) => row.risk_level === "high").length;
  const watch = rows.filter((row) => row.risk_level === "watch").length;
  const counts = [high > 0 ? `${high} high-risk` : null, watch > 0 ? `${watch} watch` : null]
    .filter(Boolean)
    .join(", ");
  const streamWord = rows.length === 1 ? "stream" : "streams";
  return {
    headline: `Version churn needs review: ${counts} ${streamWord}.`,
    highestSignal: `Highest signal: ${churnRowLabel(strongest)} retains ${strongest.versions_per_record.toLocaleString()} versions per current record.`,
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
