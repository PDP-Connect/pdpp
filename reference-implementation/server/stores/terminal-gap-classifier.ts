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
 * value via its manifest's `capabilities.refresh_policy.max_recovery_attempts`
 * (ChatGPT does — see packages/polyfill-connectors/manifests/chatgpt.json), but
 * it can NEVER opt OUT of terminalization: `resolveTerminalGapPolicy` falls
 * every connector with no declared value (or an unresolvable manifest) back to
 * a conservative `DEFAULT_TERMINAL_GAP_PROFILE` (spec §10-A option (b) —
 * "make the DEFAULT terminal behaviour safe"). This is distinct from the §3 rule-6
 *safety/ban prior* (`pacingMinIntervalMs`, which stays strictly per-provider with
 * NO default): maxRecoveryAttempts is a terminalization budget (how long before a
 * deleted resource is declared gone), not a rate prior — so a safe shared default
 * is correct, and a SILENT skip (the pre-fix null-gate) is the real §10-A bug.
 *
 * maxRecoveryAttempts ONLY gates how many pending recovery attempts occur
 * before a gap that `classifyRecoveryError` has ALREADY classified
 * non-transient flips to terminal — it never touches the transient/
 * non-transient classification itself (`classifyRecoveryError` takes no
 * profile input at all). A connector-declared value can therefore only make
 * terminalization slower, never disable it or redefine what "permanently
 * gone" means. Two independent gates bound the declared value against a
 * malicious/buggy self-attestation: manifest validation rejects an
 * out-of-range declaration outright, and `RI_MAX_RECOVERY_ATTEMPTS_CEILING`
 * below clamps whatever the manifest says at the read site regardless.
 *
 * `terminalGapProfileForConnector` (and therefore `resolveTerminalGapPolicy`)
 * does real I/O — a DB-backed manifest lookup (`getConnectorManifest`) — to
 * read that self-attested value instead of consulting a hardcoded
 * per-connector registry. Both real call sites (`runtime/index.ts`) are
 * already inside `async` functions.
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-A
 */

import { getConnectorManifest } from "../auth.ts";

// ─── Non-transient error classification ────────────────────────────────────

interface ErrorInfo {
  readonly errorClass?: string;
  readonly status?: number;
}

interface ClassifyResult {
  readonly nonTransient: boolean;
  readonly reason: string | null;
}

/**
 * Classify an error info object as transient or non-transient.
 *
 * @param {object|null} errorInfo  — { status?: number, errorClass?: string }
 * @returns {{ nonTransient: boolean, reason: string|null }}
 */
export function classifyRecoveryError(errorInfo: ErrorInfo | null | undefined): ClassifyResult {
  if (!errorInfo || typeof errorInfo !== "object") {
    return { nonTransient: false, reason: null };
  }

  const { status, errorClass } = errorInfo;
  const httpStatus = typeof status === "number" ? status : null;

  if (httpStatus === 404) {
    return { nonTransient: true, reason: "not_found" };
  }
  if (httpStatus === 410) {
    return { nonTransient: true, reason: "gone" };
  }

  // §10-C: 401 is a DISTINCT non-transient auth class (spec §10-C). It is
  // NOT source-pressure (must never arm the cooldown), NOT a deleted resource,
  // and NOT retryable as a plain gap — it requires owner re-authentication.
  // A token that returns 401 on every call will never recover on its own.
  if (httpStatus === 401) {
    return { nonTransient: true, reason: "auth_failure" };
  }

  // 403 is only non-transient when the connector explicitly marks it permanent.
  // A bare 403 may resolve after a credential refresh and must remain transient.
  if (httpStatus === 403 && errorClass === "http_403_permanent") {
    return { nonTransient: true, reason: "permanent_forbidden" };
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
export function isNonTransientError(errorInfo: ErrorInfo | null | undefined): boolean {
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
export function isAuthFailure(errorInfo: ErrorInfo | null | undefined): boolean {
  return classifyRecoveryError(errorInfo).reason === "auth_failure";
}

// ─── Provider profiles ─────────────────────────────────────────────────────
//
// Each provider declares its own profile via its manifest's
// `capabilities.refresh_policy.max_recovery_attempts`. There is NO
// cross-provider default for an explicit declaration — a missing value
// resolves to null (§3 rule 6); ONLY `resolveTerminalGapPolicy` supplies the
// safe shared fallback for that case.

interface ProviderProfile {
  readonly maxRecoveryAttempts: number;
}

/**
 * ChatGPT's declared terminal-gap profile, read from its manifest's
 * `capabilities.refresh_policy.max_recovery_attempts` (currently 3) via
 * `terminalGapProfileForConnector("chatgpt")`. Kept here only as a
 * documented reference of the live number — NOT the source of truth; the
 * manifest is. See packages/polyfill-connectors/manifests/chatgpt.json.
 *
 * maxRecoveryAttempts: after this many in_progress attempts against a
 * non-transient error, the gap transitions to terminal.  Derived from the
 * ChatGPT retry budget (CHATGPT_RATE_LIMIT_MAX_ATTEMPTS = 12 for transient
 * pressure, §2.3); for non-transient errors a much smaller budget is correct
 * because retrying a deleted resource is pure waste.  3 attempts gives one
 * observed failure + two confirming retries before declaring permanent.
 */
export const CHATGPT_PROVIDER_PROFILE: Readonly<ProviderProfile> = Object.freeze({
  maxRecoveryAttempts: 3,
});

/**
 * §10-A "impossible by construction" default terminal policy.
 *
 * The §10-A silent-lie hole (GAP 2): gap CREATION is universal (`emitDetailGap`
 * is a generic SDK helper; the `DETAIL_GAP` runtime handler is connector-
 * AGNOSTIC) but gap TERMINALIZATION used to be opt-in (gated to a chatgpt-only
 * registry). A connector with no declared profile could therefore emit a
 * 404/410/permanent gap that could NEVER go terminal → it stayed `pending`
 * forever → the "recovered everything still available / 100% done" surface lied.
 *
 * The fix is spec §10-A option (b): the DEFAULT terminal behaviour is SAFE.
 * Every connector — declared or not — terminalizes unfillable gaps under this
 * conservative declared default, so no gap path bypasses §10-A. A connector MAY
 * override the budget via its manifest, but it can NEVER opt OUT of
 * terminalization. "A connector cannot emit a gap that never goes terminal" is
 * now true by construction, not by registry membership.
 *
 * This is NOT a cross-provider safety/pressure BORROW: `maxRecoveryAttempts` is
 * a *terminalization* budget (how many times to retry a deleted resource before
 * declaring it gone), not a rate/ban prior. The honest default for an unaudited
 * connector is a conservative budget — never "retry a 404 forever". The value is
 * deliberately a touch more generous than ChatGPT's audited 3 so an unaudited
 * provider gives a transient-looking error one extra confirming retry before
 * declaring it permanent.
 */
export const DEFAULT_TERMINAL_GAP_PROFILE: Readonly<ProviderProfile> = Object.freeze({
  maxRecoveryAttempts: 5,
});

/**
 * RI-owned hard ceiling on `maxRecoveryAttempts`, enforced at the read site
 * regardless of what a connector's manifest declares. A connector-declared
 * value is clamped to this ceiling — never trusted unbounded — so a
 * self-attested budget can only ever make terminalization slower, never
 * disable it. It ONLY changes when a gap ALREADY classified non-transient by
 * `classifyRecoveryError` (which takes no profile input) transitions to
 * terminal; it can never redefine what "permanently gone" means. Matches the
 * manifest-validation upper bound
 * (`REFRESH_POLICY_MAX_RECOVERY_ATTEMPTS_RANGE.max` in
 * connector-manifest-validation.ts) as defense in depth.
 */
export const RI_MAX_RECOVERY_ATTEMPTS_CEILING = 20;

/**
 * Clamp a candidate `maxRecoveryAttempts` value to the RI hard ceiling.
 * Returns `null` when the value is not a usable finite positive integer at
 * all — the caller treats that identically to "no declared override".
 */
function clampRecoveryAttempts(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(Math.floor(value), RI_MAX_RECOVERY_ATTEMPTS_CEILING);
}

/**
 * Resolve the EXPLICIT per-connector terminal-gap profile — the connector's
 * manifest-declared `capabilities.refresh_policy.max_recovery_attempts`
 * (clamped to `RI_MAX_RECOVERY_ATTEMPTS_CEILING`) — or null when the
 * connector has no declared value or its manifest cannot be resolved. NULL
 * here means "no override" — NOT "do not terminalize". Callers MUST NOT
 * branch `if (profile) terminalize()` on this (that is the §10-A silent-skip
 * hole GAP 1/2 closed); use `resolveTerminalGapPolicy` instead, which always
 * returns a real policy. Matches on the canonical connector key prefix so
 * instance-scoped ids (`chatgpt:default`) resolve to the `chatgpt` manifest.
 * Does real I/O (a DB-backed manifest lookup) — see the module doc comment.
 *
 * @param {string} connectorId
 * @returns {Promise<{ maxRecoveryAttempts: number } | null>}
 */
export async function terminalGapProfileForConnector(connectorId: string): Promise<ProviderProfile | null> {
  if (typeof connectorId !== "string" || !connectorId) {
    return null;
  }
  const base = connectorId.split(":")[0]?.split("@")[0];
  if (!base) {
    return null;
  }
  const manifest = await getConnectorManifest(base).catch(() => null);
  const declared = clampRecoveryAttempts(
    (manifest as { capabilities?: { refresh_policy?: { max_recovery_attempts?: unknown } } } | null)?.capabilities
      ?.refresh_policy?.max_recovery_attempts
  );
  return declared !== null ? { maxRecoveryAttempts: declared } : null;
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
 * @returns {Promise<{ maxRecoveryAttempts: number }>}
 */
export async function resolveTerminalGapPolicy(connectorId: string): Promise<ProviderProfile> {
  return (await terminalGapProfileForConnector(connectorId)) ?? DEFAULT_TERMINAL_GAP_PROFILE;
}

// ─── maybeTerminateGap ─────────────────────────────────────────────────────

interface Gap {
  readonly attempt_count?: number;
  readonly gap_id: string;
  readonly reason?: string | null;
  readonly status?: string;
  readonly stream?: string;
  readonly [key: string]: unknown;
}

interface DetailGapStore {
  getGapById: (gapId: string) => Promise<Gap | null>;
  markGapStatus: (gapId: string, status: string, options?: Record<string, unknown>) => Promise<Gap | null>;
}

interface MaybeTerminateResult {
  readonly gap: Gap | null;
  readonly terminated: boolean;
}

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
export async function maybeTerminateGap(
  store: DetailGapStore,
  gapId: string,
  errorInfo: ErrorInfo | null | undefined,
  providerProfile: ProviderProfile
): Promise<MaybeTerminateResult> {
  if (!providerProfile || typeof providerProfile.maxRecoveryAttempts !== "number") {
    throw new Error(
      "maybeTerminateGap requires providerProfile.maxRecoveryAttempts; " +
        "declare a per-provider profile — no cross-provider default (spec §3 rule 6)"
    );
  }

  const { nonTransient } = classifyRecoveryError(errorInfo);
  if (!nonTransient) {
    return { gap: null, terminated: false };
  }

  const current = typeof store.getGapById === "function" ? await store.getGapById(gapId) : null;
  if (!current) {
    // Gap not found (already recovered/terminal, or never existed) — nothing to do.
    return { gap: null, terminated: false };
  }

  const attemptCount = typeof current.attempt_count === "number" ? current.attempt_count : 0;
  if (attemptCount < providerProfile.maxRecoveryAttempts) {
    // Budget not yet exhausted — leave the gap pending for another attempt.
    return { gap: null, terminated: false };
  }

  // Budget exhausted against a non-transient error: terminalize in one write.
  const terminated = await store.markGapStatus(gapId, "terminal", { lastError: errorInfo });
  return { gap: terminated ?? null, terminated: Boolean(terminated) };
}

// ─── maybeQuarantineGap ────────────────────────────────────────────────────

interface QuarantinePolicy {
  readonly maxNoProgressAttempts: number;
}

interface Evidence {
  readonly [key: string]: unknown;
}

interface MaybeQuarantineResult {
  readonly gap: Gap | null;
  readonly quarantined: boolean;
}

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
 * The escalation signal is purely the item's own `attempt_count`. A recovery
 * lease is not an attempt: the runtime increments this count only after an
 * explicit connector attempt or outcome. Cleanup CAS-releases an untouched
 * lease without changing prior evidence; an explicitly attempted lease keeps
 * its count across failed/crashed cleanup. Once the item crosses
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
export async function maybeQuarantineGap(
  store: DetailGapStore,
  gapId: string,
  evidence: Evidence | null | undefined,
  policy: QuarantinePolicy
): Promise<MaybeQuarantineResult> {
  if (!policy || typeof policy.maxNoProgressAttempts !== "number" || policy.maxNoProgressAttempts <= 0) {
    throw new Error(
      "maybeQuarantineGap requires policy.maxNoProgressAttempts as a positive integer; " +
        "a poison item must always have a finite no-progress budget (design.md D10)"
    );
  }

  const current = typeof store.getGapById === "function" ? await store.getGapById(gapId) : null;
  if (!current) {
    // Gap not found (already recovered/terminal, or never existed) — nothing to do.
    return { gap: null, quarantined: false };
  }
  if (current.status === "terminal" || current.status === "recovered") {
    // Recovery already concluded; terminal (incl. a prior quarantine) is sticky.
    return { gap: null, quarantined: false };
  }

  const attemptCount = typeof current.attempt_count === "number" ? current.attempt_count : 0;
  if (attemptCount < policy.maxNoProgressAttempts) {
    // Budget not yet exhausted — leave the item queued for another attempt so a
    // slow-but-progressing sibling is never quarantined prematurely.
    return { gap: null, quarantined: false };
  }

  // Budget exhausted with no recovery: quarantine in one write. The `reason`
  // carries the `quarantined` class the recovery-decision classifier routes to
  // `connector_defect`; the `last_error` carries the (sanitized) evidence trail.
  const quarantineError: Record<string, unknown> = {
    class: "quarantined",
    ...(evidence && typeof evidence === "object" ? evidence : {}),
    attempt_count: attemptCount,
    threshold: policy.maxNoProgressAttempts,
  };
  const quarantined = await store.markGapStatus(gapId, "terminal", {
    lastError: quarantineError,
    reason: "quarantined",
  });
  return { gap: quarantined ?? null, quarantined: Boolean(quarantined) };
}
