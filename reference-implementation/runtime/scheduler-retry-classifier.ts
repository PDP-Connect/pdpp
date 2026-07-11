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

// A run failure that requires owner auth repair (browser session_required, an
// expired/rejected login, a `manual_action_required` gap) is definitive, not
// transient: retrying it within the same scheduled tick re-submits the same
// doomed run and produces the observed three-attempt burst. This detection lives
// on the retry classifier — the single boundary that decides retryability — so
// callers do not each re-implement a retry gate.
const OWNER_AUTH_REPAIR_ACTIONS: ReadonlySet<string> = new Set(["manual_action_required", "refresh_credentials"]);
const OWNER_AUTH_REPAIR_MESSAGE_RE =
  /(?:^|[^a-z0-9])(?:401|403|auth_missing|credentials?_required|credential_rejected|invalid_token|manual_action_required|reauth|session_expired|session_failed|session_required|unauthorized|forbidden)(?:$|[^a-z0-9])/iu;

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// An owner-auth action (from a gap's `recovery_hint.action` or `reason`).
function isOwnerAuthAction(value: string | null): boolean {
  return value !== null && OWNER_AUTH_REPAIR_ACTIONS.has(value);
}

// A free-text field whose content matches the owner-auth message pattern.
function matchesOwnerAuthMessage(value: string | null | undefined): boolean {
  return typeof value === "string" && OWNER_AUTH_REPAIR_MESSAGE_RE.test(value);
}

function hasRetryableRunFailureContext(err: RunConnectorError | null | undefined): err is RunConnectorError {
  return Boolean(err) && !runRequiresOwnerAuthRepair(err);
}

function knownGapRequiresOwnerAuthRepair(gap: Record<string, unknown>): boolean {
  return (
    isOwnerAuthAction(stringField(plainObject(gap.recovery_hint), "action")) ||
    isOwnerAuthAction(stringField(gap, "reason")) ||
    matchesOwnerAuthMessage(stringField(gap, "message"))
  );
}

function runRequiresOwnerAuthRepair(err: RunConnectorError | null | undefined): boolean {
  if (!err) {
    return false;
  }
  const gapHit = (err.known_gaps ?? []).some((gap) => {
    const record = plainObject(gap);
    return record !== null && knownGapRequiresOwnerAuthRepair(record);
  });
  if (gapHit) {
    return true;
  }
  // A connector that explicitly declared this failure retryable (via its
  // `retryablePattern`, e.g. USAA's `source_unavailable`) has already made a
  // connector-neutral, source-specific determination that this is not an
  // auth failure. The session-establishment wrapper's message prefix (e.g.
  // `usaa_session_failed: source_unavailable: ...`) still contains
  // "session_failed" for EVERY session-establishment failure, retryable or
  // not, so the message-text heuristic below cannot distinguish a proven
  // provider outage from a real auth failure by substring alone. Trust the
  // connector's explicit signal over the heuristic when both are present.
  if (err.connector_error?.retryable === true) {
    return false;
  }
  return matchesOwnerAuthMessage(err.connector_error?.message) || matchesOwnerAuthMessage(err.failure_reason);
}

function shouldRetryRunFailure(err: RunConnectorError | null | undefined): boolean {
  if (!hasRetryableRunFailureContext(err)) {
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
  runRequiresOwnerAuthRepair,
  shouldRetryRunFailure,
  TERMINAL_GRANT_FAILURE_REASONS,
};
