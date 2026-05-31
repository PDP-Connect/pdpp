import type { SpineEvent } from "./ref-client.ts";

export interface KnownGap {
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
      gaps: normalizeKnownGaps(event.data?.known_gaps),
      summary: normalizeKnownGapSummary(event.data?.known_gaps_summary),
      terminalEvent: event,
    };
  }
  return {
    gaps: [],
    summary: null,
    terminalEvent: null,
  };
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

function summarizeKnownGaps(gaps: readonly KnownGap[]): KnownGapSummary {
  const byReason: Record<string, number> = {};
  for (const gap of gaps) {
    byReason[gap.reason] = (byReason[gap.reason] ?? 0) + 1;
  }
  return {
    count: gaps.length,
    truncated: false,
    by_reason: byReason,
  };
}
