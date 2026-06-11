/**
 * Terminal gap classifier — §10-A of the SLVP whole-system spec.
 *
 * A gap that exhausts a bounded recovery-attempt budget (maxRecoveryAttempts)
 * against a NON-TRANSIENT error (404/410/permanent-403, or N identical 5xx)
 * transitions pending→terminal.  Terminal gaps are:
 *   - excluded from the fillable-pending set that drives convergence + cooldown
 *   - counted separately via countGapsByStatusForConnector(connectorId, { status:'terminal' })
 *   - never silently dropped
 *
 * Non-transient error taxonomy (per spec §10-A):
 *   • 404  — deleted resource (not_found)
 *   • 410  — gone
 *   • 403 with errorClass 'http_403_permanent' — permanently forbidden
 *   • All other 4xx/5xx — transient (may resolve on retry)
 *
 * 429 is explicitly transient: it is source-pressure and must NEVER terminalize
 * a gap (it arms the source-pressure cooldown instead, §4).
 *
 * maxRecoveryAttempts is a ProviderProfile field — NO cross-provider default
 * (spec §3 rule 6: every provider-specific quantity must be declared per-provider).
 * ChatGPT's value is the only concrete value exported here.
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-A
 */

// ─── Non-transient error classification ────────────────────────────────────

/**
 * Classify an error info object as transient or non-transient.
 *
 * @param {object|null} errorInfo  — { status?: number, errorClass?: string }
 * @returns {{ nonTransient: boolean, reason: string|null }}
 */
export function classifyRecoveryError(errorInfo) {
  if (!errorInfo || typeof errorInfo !== 'object') {
    return { nonTransient: false, reason: null };
  }

  const { status, errorClass } = errorInfo;
  const httpStatus = typeof status === 'number' ? status : null;

  if (httpStatus === 404) return { nonTransient: true, reason: 'not_found' };
  if (httpStatus === 410) return { nonTransient: true, reason: 'gone' };

  // §10-C: 401 is a DISTINCT non-transient auth class (spec §10-C). It is
  // NOT source-pressure (must never arm the cooldown), NOT a deleted resource,
  // and NOT retryable as a plain gap — it requires owner re-authentication.
  // A token that returns 401 on every call will never recover on its own.
  if (httpStatus === 401) return { nonTransient: true, reason: 'auth_failure' };

  // 403 is only non-transient when the connector explicitly marks it permanent.
  // A bare 403 may resolve after a credential refresh and must remain transient.
  if (httpStatus === 403 && errorClass === 'http_403_permanent') {
    return { nonTransient: true, reason: 'permanent_forbidden' };
  }

  // All other statuses (429, 5xx, bare 403, null) are transient.
  // 429 in particular MUST remain transient — it is source-pressure, handled
  // by the cooldown governor (§4), never a terminal signal.
  return { nonTransient: false, reason: null };
}

/**
 * Convenience wrapper: returns true iff the error is non-transient.
 *
 * @param {object|null} errorInfo
 * @returns {boolean}
 */
export function isNonTransientError(errorInfo) {
  return classifyRecoveryError(errorInfo).nonTransient;
}

/**
 * §10-C: Returns true iff the error is a non-transient authentication failure
 * (401). This is a DISTINCT class from other non-transient errors (404/410/
 * permanent-403): an auth failure requires owner re-authentication and must
 * route to `needs_attention` with a reconnect CTA — never a gap, never a
 * cooldown.
 *
 * @param {object|null} errorInfo
 * @returns {boolean}
 */
export function isAuthFailure(errorInfo) {
  return classifyRecoveryError(errorInfo).reason === 'auth_failure';
}

// ─── Provider profiles ─────────────────────────────────────────────────────
//
// Each provider declares its own profile.  There is NO cross-provider default
// for maxRecoveryAttempts — a missing or inherited value is a build-time error,
// not a silent borrow of ChatGPT's number (spec §3 rule 6).

/**
 * ChatGPT provider profile for the terminal-gap classifier.
 *
 * maxRecoveryAttempts: after this many in_progress attempts against a
 * non-transient error, the gap transitions to terminal.  Derived from the
 * ChatGPT retry budget (CHATGPT_RATE_LIMIT_MAX_ATTEMPTS = 12 for transient
 * pressure, §2.3); for non-transient errors a much smaller budget is correct
 * because retrying a deleted resource is pure waste.  3 attempts gives one
 * observed failure + two confirming retries before declaring permanent.
 */
export const CHATGPT_PROVIDER_PROFILE = Object.freeze({
  maxRecoveryAttempts: 3,
});

// Per-connector profile registry. NO cross-provider default (spec §3 rule 6):
// a connector with no declared profile returns null, and the recovery path
// simply does NOT terminalize its gaps — it never silently borrows ChatGPT's
// budget. To enable §10-A terminal classification for a new provider, add its
// profile here from that provider's own observed non-transient-error behaviour.
const TERMINAL_GAP_PROFILES = Object.freeze({
  chatgpt: CHATGPT_PROVIDER_PROFILE,
});

/**
 * Resolve the terminal-gap profile for a connector id, or null when none is
 * declared (terminalization is skipped — fillable gaps stay pending, never
 * stranded). Matches on the canonical connector key prefix so instance-scoped
 * ids (`chatgpt:default`) resolve to the `chatgpt` profile.
 *
 * @param {string} connectorId
 * @returns {{ maxRecoveryAttempts: number } | null}
 */
export function terminalGapProfileForConnector(connectorId) {
  if (typeof connectorId !== 'string' || !connectorId) return null;
  const base = connectorId.split(':')[0].split('@')[0];
  return TERMINAL_GAP_PROFILES[base] ?? null;
}

// ─── maybeTerminateGap ─────────────────────────────────────────────────────

/**
 * Examine a gap and transition it to 'terminal' iff BOTH hold:
 *   1. the error is non-transient (classifyRecoveryError), AND
 *   2. the gap's attempt_count has reached providerProfile.maxRecoveryAttempts.
 *
 * Read-then-decide: the current row is read via `store.getGapById` so the
 * decision is made BEFORE any write. Only when the gap should terminate do we
 * issue a single `markGapStatus('terminal')` write. There is no provisional
 * write and no rollback — so a concurrent reader never observes a transiently-
 * terminal gap, and a crash mid-call cannot strand a still-fillable gap as
 * terminal (which would be the silent data-loss §10-A exists to prevent).
 *
 * The caller is responsible for calling `markGapStatus('in_progress')` before
 * each recovery attempt so attempt_count reflects real attempts.
 *
 * @param {object} store              — connector detail gap store (needs getGapById, markGapStatus)
 * @param {string} gapId              — gap identifier
 * @param {object|null} errorInfo     — { status, errorClass, ... }
 * @param {{ maxRecoveryAttempts: number }} providerProfile
 * @returns {Promise<{ terminated: boolean, gap: object|null }>}
 */
export async function maybeTerminateGap(store, gapId, errorInfo, providerProfile) {
  if (!providerProfile || typeof providerProfile.maxRecoveryAttempts !== 'number') {
    throw new Error(
      'maybeTerminateGap requires providerProfile.maxRecoveryAttempts; ' +
      'declare a per-provider profile — no cross-provider default (spec §3 rule 6)',
    );
  }

  const { nonTransient } = classifyRecoveryError(errorInfo);
  if (!nonTransient) {
    return { terminated: false, gap: null };
  }

  const current = typeof store.getGapById === 'function' ? await store.getGapById(gapId) : null;
  if (!current) {
    // Gap not found (already recovered/terminal, or never existed) — nothing to do.
    return { terminated: false, gap: null };
  }

  const attemptCount = typeof current.attempt_count === 'number' ? current.attempt_count : 0;
  if (attemptCount < providerProfile.maxRecoveryAttempts) {
    // Budget not yet exhausted — leave the gap pending for another attempt.
    return { terminated: false, gap: null };
  }

  // Budget exhausted against a non-transient error: terminalize in one write.
  const terminated = await store.markGapStatus(gapId, 'terminal', { lastError: errorInfo });
  return { terminated: Boolean(terminated), gap: terminated ?? null };
}
