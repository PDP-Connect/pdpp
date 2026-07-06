import type { ConnectorError, TerminalGrantFailureReason, TerminalReason } from "./scheduler-domain-types.ts";

export type {
  TerminalNonGrantReason,
  TerminalReason,
} from "./scheduler-domain-types.ts";

// ─── Retry classifier ────────────────────────────────────────────────────────

interface RunConnectorError {
  readonly checkpoint_summary?: Record<string, unknown> | null;
  readonly connector_error?: ConnectorError | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly message?: string;
  readonly records_emitted?: number;
  readonly reported_records_emitted?: number | null;
  readonly response_status?: number;
  readonly run_id?: string | null;
  readonly terminal_reason?: TerminalReason | null;
  readonly trace_id?: string | null;
}

function isRetryableHttpStatus(status: unknown): boolean {
  if (!Number.isInteger(status)) {
    return true;
  }
  const code = status as number;
  if (code >= 400 && code < 500 && code !== 429) {
    return false;
  }
  return true;
}

function hasRetryableRunFailureKnownGap(gaps: readonly Record<string, unknown>[] | null | undefined): boolean {
  for (const gap of gaps ?? []) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      continue;
    }
    if (gap.kind !== "run_failed") {
      continue;
    }
    const recoveryHint = gap.recovery_hint;
    if (!recoveryHint || typeof recoveryHint !== "object" || Array.isArray(recoveryHint)) {
      continue;
    }
    if (
      (recoveryHint as { action?: unknown }).action === "retry_by_runtime" &&
      (recoveryHint as { retryable?: unknown }).retryable === true
    ) {
      return true;
    }
  }
  return false;
}

const NON_RETRYABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "authentication_error",
  "connector_protocol_violation",
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
  "permission_error",
  "run_timed_out",
]);

const NON_RETRYABLE_TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set<TerminalReason>([
  "authentication_error",
  "connector_reported_cancelled",
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
  "owner_cancel_forced",
  "owner_cancelled",
  "permission_error",
]);

function shouldRetryRunFailure(err: RunConnectorError | null | undefined): boolean {
  if (!err) {
    return false;
  }
  if (!isRetryableHttpStatus(err.response_status)) {
    return false;
  }
  if (err.failure_reason && NON_RETRYABLE_FAILURE_REASONS.has(err.failure_reason)) {
    return false;
  }
  if (err.terminal_reason && NON_RETRYABLE_TERMINAL_REASONS.has(err.terminal_reason)) {
    return false;
  }
  if (hasRetryableRunFailureKnownGap(err.known_gaps)) {
    return true;
  }
  if (err.connector_error?.retryable === false) {
    return false;
  }
  return true;
}

const TERMINAL_GRANT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
]);

function isTerminalGrantFailure(reason: string | null | undefined): reason is TerminalGrantFailureReason {
  return reason !== null && reason !== undefined && TERMINAL_GRANT_FAILURE_REASONS.has(reason);
}

export type { RunConnectorError };
export {
  hasRetryableRunFailureKnownGap,
  isRetryableHttpStatus,
  isTerminalGrantFailure,
  NON_RETRYABLE_FAILURE_REASONS,
  NON_RETRYABLE_TERMINAL_REASONS,
  shouldRetryRunFailure,
  TERMINAL_GRANT_FAILURE_REASONS,
};
