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
  /** Read-only operational command that reports what compaction would remove. */
  dryRunCommand: string;
  /** Total rows in `record_changes` for this (connection, stream). */
  history: ChurnRowCell;
  key: string;
  /** Distinct record keys observed in history; null when ground-truth lacks it. */
  keys: ChurnRowCell;
  label: string;
  /** Most recent history-write timestamp (ISO), or null when unavailable. */
  lastHistoryAt: string | null;
  /** Risk reasons supplied by the route, joined for a tooltip. */
  reasons: string | null;
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
  return rows.map((row) => ({
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    key: `${row.connector_instance_id}:${row.stream}`,
    label: churnRowLabel(row),
    risk: row.risk_level,
    stream: row.stream,
    dryRunCommand: churnDryRunCommand(row),
    versionsPerRecord: {
      label: row.versions_per_record.toLocaleString(undefined, { maximumFractionDigits: 2 }),
    },
    current: countCell(row.current_record_count),
    history: countCell(row.record_history_count),
    keys: countCell(row.record_key_count),
    lastHistoryAt: row.last_history_at,
    reasons: row.risk_reasons.length > 0 ? row.risk_reasons.join("; ") : null,
  }));
}
