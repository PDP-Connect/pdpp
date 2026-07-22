// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * maxRecoveryAttempts is a ProviderProfile field. A connector MAY declare its own
 * value (ChatGPT does — the only registry override here), but it can NEVER opt OUT
 * of terminalization: `resolveTerminalGapPolicy` falls every unregistered connector
 * back to a conservative `DEFAULT_TERMINAL_GAP_PROFILE` (spec §10-A option (b) —
 * "make the DEFAULT terminal behaviour safe"). This is distinct from the §3 rule-6
 * *safety/ban prior* (`pacingMinIntervalMs`, which stays strictly per-provider with
 * NO default): maxRecoveryAttempts is a terminalization budget (how long before a
 * deleted resource is declared gone), not a rate prior — so a safe shared default
 * is correct, and a SILENT skip (the pre-fix null-gate) is the real §10-A bug.
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

/**
 * §10-A "impossible by construction" default terminal policy.
 *
 * The §10-A silent-lie hole (GAP 2): gap CREATION is universal (`emitDetailGap`
 * is a generic SDK helper; the `DETAIL_GAP` runtime handler is connector-
 * AGNOSTIC) but gap TERMINALIZATION used to be opt-in (gated to a chatgpt-only
 * registry). A connector with no registered profile could therefore emit a
 * 404/410/permanent gap that could NEVER go terminal → it stayed `pending`
 * forever → the "recovered everything still available / 100% done" surface lied.
 *
 * The fix is spec §10-A option (b): the DEFAULT terminal behaviour is SAFE.
 * Every connector — declared or not — terminalizes unfillable gaps under this
 * conservative declared default, so no gap path bypasses §10-A. A connector MAY
 * override the budget by registering an explicit profile below, but it can NEVER
 * opt OUT of terminalization. "A connector cannot emit a gap that never goes
 * terminal" is now true by construction, not by registry membership.
 *
 * This is NOT a cross-provider safety/pressure BORROW: `maxRecoveryAttempts` is
 * a *terminalization* budget (how many times to retry a deleted resource before
 * declaring it gone), not a rate/ban prior. The honest default for an unaudited
 * connector is a conservative budget — never "retry a 404 forever". The value is
 * deliberately a touch more generous than ChatGPT's audited 3 so an unaudited
 * provider gives a transient-looking error one extra confirming retry before
 * declaring it permanent.
 */
export const DEFAULT_TERMINAL_GAP_PROFILE = Object.freeze({
  maxRecoveryAttempts: 5,
});

// Per-connector profile registry. A connector with an EXPLICIT profile here
// overrides the default budget with its own observed non-transient-error
// behaviour. A connector NOT listed here does NOT opt out of terminalization —
// it falls back to DEFAULT_TERMINAL_GAP_PROFILE via `resolveTerminalGapPolicy`
// (spec §10-A option (b)). The registry value is an override, never a gate.
const TERMINAL_GAP_PROFILES = Object.freeze({
  chatgpt: CHATGPT_PROVIDER_PROFILE,
});

/**
 * Resolve the EXPLICIT per-connector terminal-gap profile, or null when the
 * connector has not registered one. NULL here means "no override" — NOT "do not
 * terminalize". Callers MUST NOT branch `if (profile) terminalize()` on this
 * (that is the §10-A silent-skip hole GAP 1/2 closed); use
 * `resolveTerminalGapPolicy` instead, which always returns a real policy.
 * Matches on the canonical connector key prefix so instance-scoped ids
 * (`chatgpt:default`) resolve to the `chatgpt` profile.
 *
 * @param {string} connectorId
 * @returns {{ maxRecoveryAttempts: number } | null}
 */
export function terminalGapProfileForConnector(connectorId) {
  if (typeof connectorId !== 'string' || !connectorId) return null;
  const base = connectorId.split(':')[0].split('@')[0];
  return TERMINAL_GAP_PROFILES[base] ?? null;
}

/**
 * Resolve the terminal-gap policy that the gap-emit/handler path MUST use. This
 * ALWAYS returns a real policy — the explicit per-connector profile when one is
 * registered, otherwise the safe `DEFAULT_TERMINAL_GAP_PROFILE`. There is no
 * null return: a connector can never end up on a path that silently skips
 * terminalization (spec §10-A "impossible by construction"). This is the seam
 * that makes "a connector emits a gap that never goes terminal" impossible.
 *
 * @param {string} connectorId
 * @returns {{ maxRecoveryAttempts: number }}
 */
export function resolveTerminalGapPolicy(connectorId) {
  return terminalGapProfileForConnector(connectorId) ?? DEFAULT_TERMINAL_GAP_PROFILE;
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

// ─── maybeQuarantineGap ────────────────────────────────────────────────────

/**
 * Per-item poison-item quarantine (design.md D9/D10; OpenSpec
 * `add-connector-neutral-recovery-governor` tasks 1.6 / 2.5 / runtime-3.4).
 *
 * This is the transient-looking sibling of `maybeTerminateGap`. Where
 * `maybeTerminateGap` terminalizes a gap that keeps failing against a
 * NON-transient HTTP error (a provably-gone resource), `maybeQuarantineGap`
 * terminalizes an item that keeps failing **deterministically or via repeated
 * interruption** with a transient-*looking* signal — the poison item that would
 * otherwise retry forever and consume the backlog's recovery budget.
 *
 * The escalation signal is purely the item's own `attempt_count`. Every served
 * attempt increments it (via `markGapStatus('in_progress')`) BEFORE the
 * connector acts, and the crash-reclaim path resets `in_progress` → `pending`
 * WITHOUT decrementing, so repeated interruption climbs `attempt_count` exactly
 * like a repeated deterministic failure (design.md D9). Once the item crosses
 * its per-item no-progress budget it is quarantined into `terminal` with a
 * distinct `quarantined` class and captured evidence — visible in accounting,
 * routed to a connector/system issue by the recovery-decision classifier, and
 * never silently dropped (design.md D10).
 *
 * Read-then-decide, one write, no rollback — mirrors `maybeTerminateGap` so a
 * crash mid-call can never strand a still-fillable sibling as quarantined.
 *
 * @param {object} store        — detail gap store (needs getGapById, markGapStatus)
 * @param {string} gapId        — gap identifier
 * @param {object|null} evidence — non-secret failure evidence (class/message/attempt); the store sanitizes it
 * @param {{ maxNoProgressAttempts: number }} policy
 * @returns {Promise<{ quarantined: boolean, gap: object|null }>}
 */
export async function maybeQuarantineGap(store, gapId, evidence, policy) {
  if (!policy || typeof policy.maxNoProgressAttempts !== 'number' || policy.maxNoProgressAttempts <= 0) {
    throw new Error(
      'maybeQuarantineGap requires policy.maxNoProgressAttempts as a positive integer; ' +
      'a poison item must always have a finite no-progress budget (design.md D10)',
    );
  }

  const current = typeof store.getGapById === 'function' ? await store.getGapById(gapId) : null;
  if (!current) {
    // Gap not found (already recovered/terminal, or never existed) — nothing to do.
    return { quarantined: false, gap: null };
  }
  if (current.status === 'terminal' || current.status === 'recovered') {
    // Recovery already concluded; terminal (incl. a prior quarantine) is sticky.
    return { quarantined: false, gap: null };
  }

  const attemptCount = typeof current.attempt_count === 'number' ? current.attempt_count : 0;
  if (attemptCount < policy.maxNoProgressAttempts) {
    // Budget not yet exhausted — leave the item queued for another attempt so a
    // slow-but-progressing sibling is never quarantined prematurely.
    return { quarantined: false, gap: null };
  }

  // Budget exhausted with no recovery: quarantine in one write. The `reason`
  // carries the `quarantined` class the recovery-decision classifier routes to
  // `connector_defect`; the `last_error` carries the (sanitized) evidence trail.
  const quarantineError = {
    class: 'quarantined',
    ...(evidence && typeof evidence === 'object' ? evidence : {}),
    attempt_count: attemptCount,
    threshold: policy.maxNoProgressAttempts,
  };
  const quarantined = await store.markGapStatus(gapId, 'terminal', {
    reason: 'quarantined',
    lastError: quarantineError,
  });
  return { quarantined: Boolean(quarantined), gap: quarantined ?? null };
}
