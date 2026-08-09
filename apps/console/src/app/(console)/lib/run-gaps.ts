// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RefCollectionReportEntry, RefCoverageAxis, SpineEvent } from "./ref-client.ts";

export interface KnownGap {
  diagnostics?: Record<string, unknown> | null;
  kind: string;
  message?: string;
  reason: string;
  recovery_hint?: {
    action?: string;
    retryable?: boolean;
    [key: string]: unknown;
  };
  scope?: Record<string, unknown>;
  severity?: "actionable" | "informational" | "recoverable" | "transient";
  stream?: string | null;
}

export interface KnownGapSummary {
  by_reason?: Record<string, number>;
  count?: number;
  truncated?: boolean;
}

export interface GapClassification {
  coverageGaps: KnownGap[];
  informationalGaps: KnownGap[];
  protocolViolationGaps: KnownGap[];
  summary: KnownGapSummary | null;
}

export function classifyKnownGaps(gaps: readonly KnownGap[]): GapClassification {
  const informationalGaps: KnownGap[] = [];
  const protocolViolationGaps: KnownGap[] = [];
  const coverageGaps: KnownGap[] = [];
  for (const gap of gaps) {
    if (isProtocolViolationGap(gap)) {
      protocolViolationGaps.push(gap);
    } else if (isInformationalGap(gap)) {
      informationalGaps.push(gap);
    } else {
      coverageGaps.push(gap);
    }
  }
  return {
    coverageGaps,
    informationalGaps,
    protocolViolationGaps,
    summary: gaps.length > 0 ? summarizeKnownGaps(gaps) : null,
  };
}

export function connectorHasPartialCoverageHint({
  lastRunKnownGaps,
  totalRecords,
}: {
  lastRunKnownGaps: readonly KnownGap[] | null | undefined;
  totalRecords: number;
}): boolean {
  if (totalRecords <= 0 || !lastRunKnownGaps?.length) {
    return false;
  }
  return classifyKnownGaps(lastRunKnownGaps).coverageGaps.length > 0;
}

const PARTIAL_COVERAGE_CONDITIONS: ReadonlySet<RefCoverageAxis> = new Set<RefCoverageAxis>([
  "partial",
  "gaps",
  "retryable_gap",
]);

/**
 * Read the server-projected per-stream coverage verdict instead of
 * reconstructing partial coverage from raw run gaps.
 */
export function connectorHasPartialCoverageFromReport(
  report: readonly RefCollectionReportEntry[] | null | undefined
): boolean {
  if (!report?.length) {
    return false;
  }
  return report.some((entry) => PARTIAL_COVERAGE_CONDITIONS.has(entry?.coverage_condition));
}

/**
 * Prefer the current Collection Report. Fall back to the legacy raw-gap
 * heuristic only when the reference predates `collection_report`.
 */
export function resolvePartialCoverageCue({
  collectionReport,
  lastRunKnownGaps,
  totalRecords,
}: {
  collectionReport: readonly RefCollectionReportEntry[] | null | undefined;
  lastRunKnownGaps: readonly KnownGap[] | null | undefined;
  totalRecords: number;
}): boolean {
  if (collectionReport !== null && collectionReport !== undefined) {
    return connectorHasPartialCoverageFromReport(collectionReport);
  }
  return connectorHasPartialCoverageHint({ lastRunKnownGaps, totalRecords });
}

/**
 * Normalize a `known_gaps` / `known_gaps_summary` pair. Shared by the
 * page-scanned extractor below (fed a terminal event's `data` payload) and
 * by the window-independent run-status projection (`RunStatusEnvelope`,
 * which carries the same two fields off the runtime's `LIMIT 1`
 * terminal-event query instead of the paginated timeline).
 */
export function extractKnownGapsFromEventData(
  data: { known_gaps?: unknown; known_gaps_summary?: unknown } | null | undefined
): {
  gaps: KnownGap[];
  summary: KnownGapSummary | null;
} {
  return {
    gaps: normalizeKnownGaps(data?.known_gaps),
    summary: normalizeKnownGapSummary(data?.known_gaps_summary),
  };
}

export function extractTerminalKnownGaps(events: readonly SpineEvent[]): {
  gaps: KnownGap[];
  summary: KnownGapSummary | null;
  terminalEvent: SpineEvent | null;
} {
  // Run-terminal event types — kept aligned with lib/spine.ts
  // RUN_TERMINAL_EVENT_TYPES. See docs/run-reconciliation-design-brief.md §3.7.
  const RUN_TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled", "run.abandoned"]);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && RUN_TERMINAL_EVENT_TYPES.has(event.event_type))) {
      continue;
    }
    return {
      ...extractKnownGapsFromEventData(event.data),
      terminalEvent: event,
    };
  }
  return {
    gaps: [],
    summary: null,
    terminalEvent: null,
  };
}

/**
 * A `run.stream_skipped` event is emitted once per SKIP_RESULT the connector
 * sent, and a connector may send one per RECORD it dropped. So the event count
 * is a count of skipped ITEMS, never of streams — the streams it touched are
 * the distinct `stream_id`s across those events. Reporting the event count as
 * a stream count told the owner "304 streams were skipped" for 304 records
 * dropped inside a single stream.
 */
export interface SkippedStreamSummary {
  /** Total `run.stream_skipped` events — a count of skipped items, not streams. */
  count: number;
  /** Skip reasons the connector DID record, with an item count each. */
  reasons: { count: number; diagnostics: SkipDiagnosticsDigest | null; reason: string }[];
  /** Distinct `stream_id`s the skips touched. Empty when no skip named a stream. */
  streams: string[];
  /** How many skip events carried no `reason` at all. Only these are unexplained. */
  unexplainedCount: number;
}

/**
 * The parts of a skip's connector-authored diagnostics that are worth putting
 * on the page: which field failed and what was wrong with it. The runtime has
 * already bounded and redacted this payload (see connector-gap-bounding.ts);
 * this only picks a display projection out of it.
 */
export interface SkipDiagnosticsDigest {
  /** The validator's message for that path. */
  message: string;
  /** First failing field path, e.g. `attachments.0.url`. */
  path: string;
}

/**
 * Summarize the run's `run.stream_skipped` events by the reason the connector
 * recorded, so the page can say WHY things were skipped instead of counting
 * them and declaring no reason was given. The reason is on the event payload
 * (`data.reason`) — the previous copy read the recovery hint instead and
 * concluded the connector had recorded nothing.
 */
export function summarizeSkippedStreams(events: readonly SpineEvent[]): SkippedStreamSummary {
  const skips = events.filter((event) => event.event_type === "run.stream_skipped");
  const streams = new Set<string>();
  const byReason = new Map<string, { count: number; diagnostics: SkipDiagnosticsDigest | null }>();
  let unexplainedCount = 0;
  for (const skip of skips) {
    const stream = nonEmptyString(skip.stream_id) ?? nonEmptyString(skip.data?.stream);
    if (stream) {
      streams.add(stream);
    }
    const reason = nonEmptyString(skip.data?.reason);
    if (!reason) {
      unexplainedCount += 1;
      continue;
    }
    const existing = byReason.get(reason);
    if (existing) {
      existing.count += 1;
      // Keep the first digest seen: every skip sharing a reason carries the
      // same shape of evidence, and one worked example is what the owner needs.
      existing.diagnostics = existing.diagnostics ?? digestSkipDiagnostics(skip.data?.diagnostics);
      continue;
    }
    byReason.set(reason, { count: 1, diagnostics: digestSkipDiagnostics(skip.data?.diagnostics) });
  }
  return {
    count: skips.length,
    reasons: [...byReason.entries()]
      .map(([reason, entry]) => ({ count: entry.count, diagnostics: entry.diagnostics, reason }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    streams: [...streams].sort(),
    unexplainedCount,
  };
}

/**
 * Pull the first `{ path, message }` out of a skip's `diagnostics.issues`.
 * Shape-check skips carry the failing field there; other skip reasons carry
 * other shapes, so a miss is normal and yields null rather than guessing.
 */
function digestSkipDiagnostics(raw: unknown): SkipDiagnosticsDigest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { issues } = raw as { issues?: unknown };
  if (!Array.isArray(issues)) {
    return null;
  }
  for (const issue of issues) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
      continue;
    }
    const { message, path } = issue as { message?: unknown; path?: unknown };
    const normalizedPath = nonEmptyString(path);
    const normalizedMessage = nonEmptyString(message);
    if (normalizedPath && normalizedMessage) {
      return { message: normalizedMessage, path: normalizedPath };
    }
  }
  return null;
}

export function formatGapReason(reason: string): string {
  return reason.replace(/_/g, " ");
}

export function formatRecoveryHint(gap: KnownGap): string {
  const action = gap.recovery_hint?.action;
  if (!action) {
    return "unknown";
  }
  const retryable =
    typeof gap.recovery_hint?.retryable === "boolean"
      ? ` · ${gap.recovery_hint.retryable ? "retryable" : "not retryable"}`
      : "";
  return `${formatGapReason(action)}${retryable}`;
}

export function normalizeKnownGaps(raw: unknown): KnownGap[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap(normalizeKnownGapEntry);
}

function isProtocolViolationGap(gap: KnownGap): boolean {
  return gap.kind === "run_failed" && gap.reason === "connector_protocol_violation";
}

function isInformationalGap(gap: KnownGap): boolean {
  return gap.severity === "informational";
}

function normalizeKnownGapSummary(raw: unknown): KnownGapSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const count = typeof record.count === "number" && Number.isFinite(record.count) ? record.count : undefined;
  const truncated = typeof record.truncated === "boolean" ? record.truncated : undefined;
  const byReason =
    record.by_reason && typeof record.by_reason === "object" && !Array.isArray(record.by_reason)
      ? Object.fromEntries(
          Object.entries(record.by_reason as Record<string, unknown>).filter((entry): entry is [string, number] => {
            const [, value] = entry;
            return typeof value === "number" && Number.isFinite(value);
          })
        )
      : undefined;
  if (count === undefined && truncated === undefined && byReason === undefined) {
    return null;
  }
  return {
    ...(count === undefined ? {} : { count }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(byReason === undefined ? {} : { by_reason: byReason }),
  };
}

function normalizeKnownGapEntry(entry: unknown): KnownGap[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const record = entry as Record<string, unknown>;
  return [
    {
      kind: nonEmptyString(record.kind) ?? "unknown",
      reason: nonEmptyString(record.reason) ?? "unknown",
      ...optionalSeverityField(record.severity),
      ...optionalStringField("stream", record.stream),
      ...optionalStringField("message", record.message),
      ...optionalObjectField("recovery_hint", record.recovery_hint),
      ...optionalObjectField("scope", record.scope),
      ...optionalDiagnosticsField(record.diagnostics),
    },
  ];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStringField<Key extends "message" | "stream">(key: Key, value: unknown): Partial<Pick<KnownGap, Key>> {
  const normalized = nonEmptyString(value);
  return normalized ? ({ [key]: normalized } as Partial<Pick<KnownGap, Key>>) : {};
}

function optionalSeverityField(value: unknown): Partial<Pick<KnownGap, "severity">> {
  if (value === "actionable" || value === "informational" || value === "recoverable" || value === "transient") {
    return { severity: value };
  }
  return {};
}

function optionalObjectField<Key extends "recovery_hint" | "scope">(
  key: Key,
  value: unknown
): Partial<Pick<KnownGap, Key>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { [key]: value } as Partial<Pick<KnownGap, Key>>;
}

function optionalDiagnosticsField(value: unknown): Partial<Pick<KnownGap, "diagnostics">> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { diagnostics: value as Record<string, unknown> };
}

function summarizeKnownGaps(gaps: readonly KnownGap[]): KnownGapSummary {
  const byReason: Record<string, number> = {};
  for (const gap of gaps) {
    byReason[gap.reason] = (byReason[gap.reason] ?? 0) + 1;
  }
  return {
    by_reason: byReason,
    count: gaps.length,
    truncated: false,
  };
}
