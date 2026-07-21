// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-neutral recovery-decision helpers (OpenSpec
 * `add-connector-neutral-recovery-governor`, tasks 1.1–1.5).
 *
 * This module is **pure**, mirroring `scheduler-source-pressure-cooldown.ts`
 * and `scheduler-backoff.ts`: it takes durable `connector_detail_gaps` row
 * projections + a wall-clock `now` and returns decisions. No I/O, no timers, no
 * store access. The scheduler, controller, and console projection all feed the
 * same row shape.
 *
 * Today the recovery subsystem hand-classifies gaps inline at every seam:
 * `SOURCE_PRESSURE_GAP_REASONS.has(row.reason)` appears in the scheduler
 * pressure probe, the non-pressure recovery probe, the controller manual-retry
 * gate, and the cooldown governor; `next_attempt_after <= now` is applied in the
 * store; terminal classes live in the terminal-gap classifier. That scattering
 * is the ownership gap `design.md` D1/D2 describe. This module is the single
 * connector-neutral place that answers, for one queued gap row:
 *
 *   1. which recovery class it is (design.md D4);
 *   2. whether it is source pressure (arms the cooldown) or not;
 *   3. which provider work domain it belongs to (isolation key, D2);
 *   4. when it next becomes eligible (its `next_attempt_after` floor);
 *   5. the `RecoveryAdmission` decision for it right now (D2).
 *
 * It deliberately does NOT re-implement the cooldown math, back-off, or
 * per-provider profiles — those stay in their existing pure modules. It reads
 * the SAME `SOURCE_PRESSURE_GAP_REASONS` set as the cooldown governor so the
 * two can never disagree about what "source pressure" means.
 */

import { SOURCE_PRESSURE_GAP_REASONS } from "./scheduler-source-pressure-cooldown.ts";

// ─── Recovery classes (design.md D4) ─────────────────────────────────────────
//
// Normalized scheduling classes. Connector-local labels (Amazon's
// `navigation_retry_exhausted`, `deferred_budget`, …) are mapped to a
// canonical DETAIL_GAP `reason` BEFORE they land in the row, so this classifier
// only ever sees the neutral vocabulary. The class here is what drives
// scheduling and owner projection; it must never be a raw connector label.

export type RecoveryClass =
  /** Planned stop (per-run/wall-clock/retry-budget cap). Keep queued; NOT source pressure. */
  | "run_cap_deferred"
  /** Recoverable no-progress stop; normal recovery cadence; NOT source pressure by itself. */
  | "retry_exhausted"
  /** Transient item/page failure; keep queued until the no-progress threshold. */
  | "temporary_unavailable"
  /** Provider pressure (rate limit / upstream). Arms cooldown; gates pressure retries. */
  | "provider_pressure"
  /** Owner is the only resolution (session/credential repair). */
  | "owner_required"
  /** Repeated deterministic parser/navigation failure or terminal classifier. */
  | "connector_defect"
  /** Informational non-gap (out of scope / disabled); not owner-drainable retry. */
  | "informational"
  /** Reason absent or unrecognized; treated as generic recoverable work. */
  | "unknown";

/**
 * Canonical DETAIL_GAP reasons that mean provider pressure. This is the SAME
 * set the cooldown governor arms on (`scheduler-source-pressure-cooldown.ts`),
 * re-exported here so callers classify against one source of truth.
 */
export const PROVIDER_PRESSURE_REASONS: ReadonlySet<string> = SOURCE_PRESSURE_GAP_REASONS;

/**
 * Reasons the terminal-gap classifier stamps on a `terminal` row for a failure
 * that requires owner re-authentication (§10-C `auth_failure`). These route to
 * `owner_required`, never a retry.
 */
export const OWNER_REQUIRED_REASONS: ReadonlySet<string> = new Set(["auth_failure"]);

/**
 * Reasons the terminal-gap classifier stamps on a `terminal` row for a
 * deterministically unfillable resource (deleted / gone / permanently
 * forbidden). These route to `connector_defect` (system/connector issue), never
 * an owner retry.
 */
export const CONNECTOR_DEFECT_REASONS: ReadonlySet<string> = new Set([
  "gone",
  "not_found",
  "permanent_forbidden",
  // A per-item poison item quarantined by the runtime (design.md D10;
  // `runtime/recovery-quarantine.ts`). It has crossed its per-item no-progress
  // budget and must never be presented as owner-drainable retry — it is a
  // connector/system issue with captured evidence.
  "quarantined",
]);

/**
 * Informational (non-recoverable, non-defect) reasons. Mirrors
 * `INFORMATIONAL_GAP_REASONS` in `runtime/index.js`; a gap with one of these is
 * an out-of-scope/disabled decision, not drainable retry work.
 */
export const INFORMATIONAL_RECOVERY_REASONS: ReadonlySet<string> = new Set([
  "not_available_in_mode",
  "out_of_scope",
  "user_disabled",
]);

/** Recovery classes that count as durable, drainable non-pressure recovery work. */
export const NON_PRESSURE_RECOVERY_CLASSES: ReadonlySet<RecoveryClass> = new Set<RecoveryClass>([
  "run_cap_deferred",
  "retry_exhausted",
  "temporary_unavailable",
  "unknown",
]);

// ─── Row projection ──────────────────────────────────────────────────────────

/**
 * The minimal projection of a `connector_detail_gaps` row this module needs.
 * Matches the snake_case shape `rowToGap` returns
 * (`server/stores/connector-detail-gap-store.js`), so a durable row can be
 * passed straight through. Only the fields that drive a recovery decision are
 * required; the rest of the row (locators, payloads, secrets) is deliberately
 * absent so this pure decision can never leak them.
 */
export interface RecoveryGapRow {
  readonly attempt_count?: number | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  /** `detail.class` when present — carries the connector's blast-radius label (e.g. `run_cap_deferred`). */
  readonly detail_class?: string | null;
  readonly grant_id?: string | null;
  readonly last_attempt_at?: string | null;
  /**
   * Actual durable row shape from `connector_detail_gaps.last_error_json`.
   * Connectors put neutral recovery classes on `last_error.class`; there is no
   * `detail_class` SQL column today.
   */
  readonly last_error?: { readonly class?: unknown } | null;
  readonly next_attempt_after?: string | null;
  readonly reason?: string | null;
  readonly status?: string | null;
  readonly stream?: string | null;
  /**
   * When this row was last written (`updated_at`). Used only as the freshness
   * fallback when `last_attempt_at` is absent — the same anchor precedence the
   * cooldown governor's `PendingPressureGap.lastPressureAt` uses
   * (`last_attempt_at` then `updated_at`).
   */
  readonly updated_at?: string | null;
}

// ─── Provider work domain (design.md D2) ─────────────────────────────────────

/**
 * The isolation key for provider pacing/cooldown decisions. A cooldown or a
 * pressure classification is scoped to one work domain; unrelated domains must
 * not block each other (spec: "Provider work domains are isolated").
 *
 * The de-facto isolation key the cooldown/scheduler already use is
 * `connector_id` + `connector_instance_id` (per-source). We name that pair
 * explicitly here so callers can compare domains by value rather than
 * re-deriving the key at each seam.
 */
export interface ProviderWorkDomain {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

/**
 * Stable string form of a work domain, for map keys / equality checks. Mirrors
 * the `connector_instance_id || connector_id` scoping the scheduler and
 * controller probes already apply.
 */
export function providerWorkDomainKey(domain: ProviderWorkDomain): string {
  return `${domain.connectorId}::${domain.connectorInstanceId}`;
}

/**
 * Derive the provider work domain from a gap row. `connector_instance_id`
 * falls back to `connector_id` when absent — the same default the scheduler and
 * controller probes use — so single-instance connectors still get a stable
 * domain.
 */
export function providerWorkDomainForGap(row: RecoveryGapRow): ProviderWorkDomain | null {
  const connectorId = nonEmpty(row?.connector_id);
  if (!connectorId) {
    return null;
  }
  const connectorInstanceId = nonEmpty(row?.connector_instance_id) ?? connectorId;
  return { connectorId, connectorInstanceId };
}

export function sameWorkDomain(a: ProviderWorkDomain | null, b: ProviderWorkDomain | null): boolean {
  if (!(a && b)) {
    return false;
  }
  return providerWorkDomainKey(a) === providerWorkDomainKey(b);
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a queued gap row's `reason` (and terminal status) into a normalized
 * `RecoveryClass`. This is the single connector-neutral mapping design.md D4
 * requires: connector-local labels are already normalized to a canonical
 * `reason` upstream, and this maps that reason to a scheduling class.
 *
 * Note the two provider-pressure reasons (`rate_limited`, `upstream_pressure`)
 * collapse to the single `provider_pressure` class — the class the cooldown
 * governor gates on — while `retry_exhausted` / `temporary_unavailable` stay
 * distinct non-pressure classes.
 */
export function classifyRecoveryReason(reason: string | null | undefined): RecoveryClass {
  const normalized = nonEmpty(reason);
  if (!normalized) {
    return "unknown";
  }
  if (PROVIDER_PRESSURE_REASONS.has(normalized)) {
    return "provider_pressure";
  }
  if (OWNER_REQUIRED_REASONS.has(normalized)) {
    return "owner_required";
  }
  if (CONNECTOR_DEFECT_REASONS.has(normalized)) {
    return "connector_defect";
  }
  if (INFORMATIONAL_RECOVERY_REASONS.has(normalized)) {
    return "informational";
  }
  if (normalized === "run_cap_deferred") {
    return "run_cap_deferred";
  }
  if (normalized === "retry_exhausted") {
    return "retry_exhausted";
  }
  if (normalized === "temporary_unavailable") {
    return "temporary_unavailable";
  }
  return "unknown";
}

/**
 * Full classification of one gap row. This is the value the recovery governor
 * carries around: the normalized class, whether it is source pressure, its
 * work domain, its next-eligible floor, and attempt metadata. It exposes no
 * record payload, locator, or secret.
 */
export interface RecoveryGapClassification {
  readonly attemptCount: number;
  /** The connector-supplied neutral class from `detail.class` / `last_error.class`, when present. */
  readonly connectorClass: string | null;
  /** True for classes that are drainable non-pressure recovery work. */
  readonly isNonPressureRecovery: boolean;
  readonly isSourcePressure: boolean;
  /** ISO next-eligible floor, or null when eligible immediately. */
  readonly nextEligibleAt: string | null;
  readonly recoveryClass: RecoveryClass;
  readonly stream: string | null;
  readonly workDomain: ProviderWorkDomain | null;
}

export function classifyRecoveryGap(row: RecoveryGapRow): RecoveryGapClassification {
  const connectorClass = nonEmpty(row?.detail_class) ?? nonEmpty(row?.last_error?.class);
  const reasonClass = classifyRecoveryReason(row?.reason);
  const recoveryClass = connectorRecoveryClass(connectorClass, reasonClass);

  const isSourcePressure = recoveryClass === "provider_pressure";
  return {
    recoveryClass,
    isSourcePressure,
    isNonPressureRecovery: NON_PRESSURE_RECOVERY_CLASSES.has(recoveryClass),
    workDomain: providerWorkDomainForGap(row),
    nextEligibleAt: nonEmpty(row?.next_attempt_after),
    attemptCount: normalizeNonNegativeInteger(row?.attempt_count, 0),
    connectorClass: connectorClass ?? null,
    stream: nonEmpty(row?.stream),
  };
}

function connectorRecoveryClass(connectorClass: string | null, reasonClass: RecoveryClass): RecoveryClass {
  switch (connectorClass) {
    case "run_cap_deferred":
      return reasonClass === "provider_pressure" ? "provider_pressure" : "run_cap_deferred";
    case "owner_repair_required":
    case "owner_required":
      return "owner_required";
    case "provider_pressure":
      return "provider_pressure";
    case "quarantined":
    case "connector_defect":
      return "connector_defect";
    case "transient_no_progress":
      return "temporary_unavailable";
    default:
      return reasonClass;
  }
}

// ─── Admission decision (design.md D2) ───────────────────────────────────────

/**
 * The connector-neutral recovery admission decision, per design.md D2. A
 * denial always carries a machine-readable reason and, when a timing floor is
 * known, the next eligible time — so owner-only diagnostics can answer "why
 * didn't it run" (task 2.6 shape).
 */
/**
 * Machine-readable class carried on a recovery-admission denial. Shared with the
 * controller's manual retry/refresh gate so an owner-started denial classifies
 * with the same vocabulary as an automatic one (tasks 2.3/2.6).
 */
export type RecoveryAdmissionDenialReason = "cooldown" | "budget" | "owner_required" | "system_issue";

export type RecoveryAdmission =
  | { readonly ok: true; readonly mode: "recover"; readonly workDomain: ProviderWorkDomain }
  | {
      readonly ok: false;
      readonly reason: RecoveryAdmissionDenialReason;
      readonly nextEligibleAt?: string;
    };

export interface RecoveryAdmissionOptions {
  /**
   * Whether the work domain is under an active provider-pressure cooldown (the
   * cooldown decision is computed by `scheduler-source-pressure-cooldown.ts`;
   * the caller threads its `isSourcePressureCooldownDeferring` result in). A
   * cooldown gates ONLY provider-pressure work; it never denies non-pressure
   * recovery (spec: source-pressure cooldown SHALL NOT starve non-pressure
   * recovery).
   */
  readonly domainCooldownActive?: boolean;
  /** ISO time the domain cooldown expires, surfaced on a cooldown denial. */
  readonly domainCooldownUntil?: string | null;
  /** Wall-clock epoch ms used to compare against `next_attempt_after`. */
  readonly nowMs?: number;
}

/**
 * Decide whether one queued gap may be attempted right now. Pure: the caller
 * supplies the domain cooldown state (from the existing cooldown governor) and
 * `now`; this composes them with the row's class and per-item `next_attempt_after`
 * floor into a single admission.
 *
 * Rules (design.md D2/D3/D4b, spec source-pressure/starvation requirements):
 *   - `owner_required` → deny `owner_required` (only the owner can resolve it).
 *   - `connector_defect` / `informational` → deny `system_issue` (no owner retry).
 *   - a per-item `next_attempt_after` floor in the future → deny `cooldown`
 *     with that floor (this is the item's own retry timing, independent of the
 *     domain cooldown).
 *   - a provider-pressure row while the domain cooldown is active → deny
 *     `cooldown` (pressure retries wait for the domain to cool).
 *   - a NON-pressure recovery row → admit even while the domain cooldown is
 *     active (the cooldown has no claim over non-pressure work).
 */
export function resolveRecoveryAdmission(
  row: RecoveryGapRow,
  options: RecoveryAdmissionOptions = {}
): RecoveryAdmission {
  const classification = classifyRecoveryGap(row);
  const { workDomain } = classification;
  if (!workDomain) {
    // No identifiable provider work domain — cannot safely attempt.
    return { ok: false, reason: "system_issue" };
  }

  if (classification.recoveryClass === "owner_required") {
    return { ok: false, reason: "owner_required" };
  }
  if (classification.recoveryClass === "connector_defect" || classification.recoveryClass === "informational") {
    return { ok: false, reason: "system_issue" };
  }

  const nowMs = normalizeEpochMs(options.nowMs);

  // Per-item next-attempt floor. This is the row's OWN retry timing (e.g. a
  // Retry-After the connector learned), independent of the domain cooldown. It
  // gates any class, including non-pressure work whose own attempt was recently
  // made.
  const itemFloorMs = parseIso(classification.nextEligibleAt);
  if (itemFloorMs !== null && itemFloorMs > nowMs) {
    return denyCooldown(classification.nextEligibleAt);
  }

  // Domain-level provider-pressure cooldown. It gates ONLY provider-pressure
  // work. Non-pressure recovery is deliberately admitted here — this is the
  // anti-starvation rule (spec §4.3 / the live 51-holds-942 residue): a
  // source-pressure cooldown must never make queued non-pressure recovery
  // ineligible.
  if (classification.isSourcePressure && options.domainCooldownActive === true) {
    return denyCooldown(nonEmpty(options.domainCooldownUntil));
  }

  return { ok: true, mode: "recover", workDomain };
}

/**
 * Build a `cooldown` denial, including `nextEligibleAt` only when a real ISO
 * time is known. `exactOptionalPropertyTypes` forbids an explicit
 * `nextEligibleAt: undefined`, so the property is omitted rather than set to
 * undefined.
 */
function denyCooldown(nextEligibleAt: string | null): RecoveryAdmission {
  return nextEligibleAt ? { ok: false, reason: "cooldown", nextEligibleAt } : { ok: false, reason: "cooldown" };
}

// ─── Backlog partitioning (tasks 1.4/1.5 support) ────────────────────────────

/**
 * Partition a mixed queue of gap rows by provider work domain, then within each
 * domain by pressure vs non-pressure. This is the shape the anti-starvation and
 * domain-isolation invariants read: it makes "does this domain have eligible
 * non-pressure work?" and "are two domains independent?" answerable without
 * re-deriving classification per seam.
 */
export interface WorkDomainBacklog {
  /** Rows that are neither drainable recovery nor pressure (owner_required/defect/informational). */
  readonly blocked: RecoveryGapClassification[];
  readonly domain: ProviderWorkDomain;
  readonly nonPressure: RecoveryGapClassification[];
  readonly pressure: RecoveryGapClassification[];
}

export function partitionRecoveryBacklog(rows: readonly RecoveryGapRow[]): Map<string, WorkDomainBacklog> {
  const byDomain = new Map<string, WorkDomainBacklog>();
  for (const row of rows ?? []) {
    const classification = classifyRecoveryGap(row);
    const { workDomain } = classification;
    if (!workDomain) {
      continue;
    }
    const key = providerWorkDomainKey(workDomain);
    let entry = byDomain.get(key);
    if (!entry) {
      entry = { domain: workDomain, nonPressure: [], pressure: [], blocked: [] };
      byDomain.set(key, entry);
    }
    if (classification.isSourcePressure) {
      entry.pressure.push(classification);
    } else if (classification.isNonPressureRecovery) {
      entry.nonPressure.push(classification);
    } else {
      entry.blocked.push(classification);
    }
  }
  return byDomain;
}

/**
 * True when a work domain has queued non-pressure recovery work that is
 * eligible now (its own `next_attempt_after` floor is absent or past). This is
 * the predicate the scheduler eligibility seam must consult so a domain
 * cooldown never starves non-pressure recovery (spec: "Pressure minority does
 * not hold non-pressure majority").
 */
export function hasEligibleNonPressureRecovery(backlog: WorkDomainBacklog | undefined, nowMs = 0): boolean {
  if (!backlog) {
    return false;
  }
  const now = normalizeEpochMs(nowMs);
  return backlog.nonPressure.some((c) => {
    const floorMs = parseIso(c.nextEligibleAt);
    return floorMs === null || floorMs <= now;
  });
}

// ─── Recovery-first work selection (shared by scheduler + manual runNow) ─────
//
// One connector-neutral policy statement, consumed by BOTH the scheduler
// dispatch governor (`scheduler/dispatch-governor.ts`) and the controller's
// manual `runNow` (`controller.ts`): existing eligible non-pressure recovery
// work takes priority over starting fresh forward-walk work, but ONLY for an
// implicit, unscoped run — one where the caller expressed no work-mode intent
// at all. This is the fix for the live Gmail stall (10,264 pending attachment
// gaps): a due manual/ordinary run claimed a fresh forward-walk page and made
// no bounded-recovery progress for 5+ minutes while the backlog sat
// untouched, because neither seam checked existing recovery work when
// ordinary/forward dispatch was already going to happen.
//
// `force` is deliberately NOT an input here. `force: true` has one
// established, narrow meaning (`RunNowOptions.force` in controller.ts):
// bypass the provider-pressure cooldown gate. It says nothing about work
// mode and must not imply forward-only or disable recovery-first — a forced
// run with no other explicit intent still prefers eligible recovery work,
// exactly like an unforced one.
//
// A caller that requested specific `resources`/scoped streams (e.g. a Slack
// channel backfill) has expressed forward work intent by construction; that
// intent must never be silently reinterpreted as recovery-only.
export interface RecoveryFirstWorkSelectionInputs {
  /** True when eligible non-pressure recovery work exists for this connection right now. */
  readonly nonPressureRecoveryEligible: boolean;
  /** The caller's own explicit `recoveryOnly` choice, when one was made (`undefined` = no explicit choice). */
  readonly requestedRecoveryOnly?: boolean | undefined;
  /** True when the caller requested specific resources/streams (scoped run) — expresses forward work intent. */
  readonly scopedToResources?: boolean | undefined;
}

/**
 * Resolve whether a dispatch/run should be recovery-only.
 *
 *   - An explicit `requestedRecoveryOnly` (any boolean) always wins: a caller
 *     that already decided (e.g. the controller-started recovery continuation
 *     after durable progress, which explicitly requests `recoveryOnly: true`)
 *     is never second-guessed.
 *   - A `scopedToResources` run (explicit stream/resource targeting) is
 *     forward-work intent by construction and is never coerced into
 *     recovery-only.
 *   - Otherwise (an implicit, unscoped run with no explicit choice), eligible
 *     non-pressure recovery work wins the default: `recoveryOnly =
 *     nonPressureRecoveryEligible`. This applies regardless of `force`, which
 *     only bypasses the provider-pressure cooldown gate elsewhere and carries
 *     no work-mode meaning.
 */
export function resolveRecoveryFirstMode(inputs: RecoveryFirstWorkSelectionInputs): boolean {
  if (inputs.requestedRecoveryOnly !== undefined) {
    return inputs.requestedRecoveryOnly;
  }
  if (inputs.scopedToResources) {
    return false;
  }
  return inputs.nonPressureRecoveryEligible;
}

// ─── Fresh-pressure re-arm guard (task 1.5 / design.md D4) ───────────────────
//
// The cooldown governor (`scheduler-source-pressure-cooldown.ts`) arms whenever
// ANY pending pressure gap exists, regardless of WHEN that pressure was
// observed. That is the second half of the live 51-holds-942 ChatGPT residue:
// 51 stale `upstream_pressure` rows — pressure observed weeks ago, never fresh
// since — kept re-arming the domain cooldown on every scheduler tick, holding
// 942 non-pressure recoverable gaps hostage indefinitely (design.md D4).
//
// The classifier half of the invariant already holds: `isSourcePressure` is
// true ONLY for the two canonical pressure reasons, so a non-pressure row can
// never re-arm via a wrong class. The MISSING half is temporal: a pressure row
// whose last observation is older than the cooldown's evidence window is stale
// evidence about the provider *then*, not a live signal, and must not re-arm on
// its own. This pure guard partitions pressure gaps into fresh vs stale against
// a `now` + evidence window so the arming seam can consult "is there any FRESH
// pressure evidence?" instead of "does any pressure row exist?".

/**
 * Default freshness window for pressure evidence. Pressure last observed longer
 * ago than this is treated as stale and cannot, on its own, re-arm the domain
 * cooldown. Set to the cooldown's own absolute ceiling
 * (`DEFAULT_MAX_COOLDOWN_MS`, 6h): once the maximum cooldown a single pressure
 * observation could ever justify has fully elapsed with no new pressure, the
 * old rows are no longer live evidence. Callers MAY override with a
 * provider-specific window.
 */
export const DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The last-observed-pressure timestamp for a gap row, ISO. Prefers
 * `last_attempt_at` (when a recovery attempt actually touched the provider),
 * falling back to `updated_at` (when the connector deferred before a retry
 * lease existed). Mirrors the cooldown governor's `lastPressureAt` precedence
 * so the two agree on what "when was this pressure observed" means.
 */
export function lastPressureAtForGap(row: RecoveryGapRow): string | null {
  return nonEmpty(row?.last_attempt_at) ?? nonEmpty(row?.updated_at);
}

/** One pressure gap split by whether its last observation is fresh vs stale. */
export interface PressureEvidencePartition {
  /** Pressure rows whose last observation is within the evidence window. */
  readonly fresh: RecoveryGapClassification[];
  /** Pressure rows whose last observation is older than the window (or unknown). */
  readonly stale: RecoveryGapClassification[];
}

/**
 * Partition a domain's pending pressure gaps into fresh vs stale evidence
 * relative to `now`. A row is FRESH iff its last-observed-pressure timestamp is
 * within `evidenceWindowMs` of `now`. A row with no usable timestamp is treated
 * as STALE — absent evidence is not fresh evidence, so a row that cannot prove
 * recent pressure never re-arms the cooldown by itself.
 *
 * Only source-pressure-classified rows are considered; non-pressure rows are
 * ignored (they were never cooldown-arming to begin with).
 */
export function partitionPressureEvidence(
  rows: readonly RecoveryGapRow[],
  nowMs: number,
  evidenceWindowMs: number = DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS
): PressureEvidencePartition {
  const now = normalizeEpochMs(nowMs);
  const windowMs = normalizeNonNegativeInteger(evidenceWindowMs, DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS);
  const threshold = now - windowMs;
  const fresh: RecoveryGapClassification[] = [];
  const stale: RecoveryGapClassification[] = [];
  for (const row of rows ?? []) {
    const classification = classifyRecoveryGap(row);
    if (!classification.isSourcePressure) {
      continue;
    }
    const observedMs = parseIso(lastPressureAtForGap(row));
    if (observedMs !== null && observedMs >= threshold) {
      fresh.push(classification);
    } else {
      stale.push(classification);
    }
  }
  return { fresh, stale };
}

/**
 * Return the original pressure rows that still carry fresh evidence. Callers
 * use this before invoking the cooldown math so stale rows cannot affect
 * pending counts, attempt persistence, identity, or next-run timestamps.
 */
export function filterFreshPressureRows<T extends RecoveryGapRow>(
  rows: readonly T[],
  nowMs: number,
  evidenceWindowMs: number = DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS
): T[] {
  const now = normalizeEpochMs(nowMs);
  const windowMs = normalizeNonNegativeInteger(evidenceWindowMs, DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS);
  const threshold = now - windowMs;
  return (rows ?? []).filter((row) => {
    if (!classifyRecoveryGap(row).isSourcePressure) {
      return false;
    }
    const observedMs = parseIso(lastPressureAtForGap(row));
    return observedMs !== null && observedMs >= threshold;
  });
}

/**
 * True iff a domain has at least one FRESH pressure observation. This is the
 * predicate the cooldown-arming seam must consult: a domain re-arms only from
 * fresh pressure evidence (spec "Stale pressure classifications do not re-arm
 * cooldown"). When this is false but stale pressure rows remain, the domain
 * SHALL NOT stay in cooldown on those residual rows alone.
 */
export function hasFreshPressureEvidence(
  rows: readonly RecoveryGapRow[],
  nowMs: number,
  evidenceWindowMs: number = DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS
): boolean {
  return filterFreshPressureRows(rows, nowMs, evidenceWindowMs).length > 0;
}

// ─── Owner-only admission diagnostics (task 2.6) ─────────────────────────────
//
// The runtime already records the connector-neutral admission decision as
// evidence on the `DETAIL_GAPS_START_ADMISSION` / `DETAIL_GAPS_PAGE_RESPONSE`
// progress events (`summarizeDetailGapAdmission` in `runtime/index.js`) and on a
// manual denial's `recoveryAdmissionReason`. Those are per-run, event-stream
// facts. The missing half of task 2.6 is an owner-only READ that answers, at any
// time and without re-deriving classification at another seam, "why did (or did
// not) the most recent recovery attempt run for this connection".
//
// This function is the pure decision behind that read. It re-derives the SAME
// `resolveRecoveryAdmission` decision over a connection's durable pending gap
// rows (the substrate is `connector_detail_gaps`, matching design.md's rollback
// guarantee — no new store), summarizes admitted vs deferred counts and reason
// classes, and computes a single owner-facing `why_not_now` when NOTHING is
// admissible now. It exposes only counts, classes, and timing — never a record
// payload, locator, or secret. It is observe-only: it makes no decision the
// scheduler or manual gate acts on; those seams own enforcement.

/**
 * Owner-only recovery-admission diagnostics for one connection, derived from its
 * durable pending gap rows. `why_not_now` is present only when no row is
 * admissible right now; it names the single most owner-relevant blocker so
 * diagnostics can answer "why didn't the most recent attempt run" directly.
 */
export interface RecoveryAdmissionDiagnostics {
  /** Rows the governor would admit for a recovery attempt right now. */
  readonly admitted: number;
  /** Total candidate pending rows considered (bounded by the caller's read). */
  readonly candidates: number;
  /** Rows the governor would defer right now. */
  readonly deferred: number;
  /** Per-reason-class deferral counts. Present only when `deferred > 0`. */
  readonly deferred_by_reason?: Readonly<Record<RecoveryAdmissionDenialReason, number>>;
  /** Earliest ISO next-eligible time across deferred rows, when any is known. */
  readonly next_eligible_at?: string;
  /**
   * The single owner-facing blocker reason, present ONLY when nothing is
   * admissible now (`admitted === 0 && candidates > 0`). Ordered by owner
   * relevance: an `owner_required` or `system_issue` blocker (the owner or a
   * maintainer must act) outranks a `budget` or a `cooldown` (the system will
   * resume on its own).
   */
  readonly why_not_now?: RecoveryAdmissionDenialReason;
}

/** Owner-relevance order for the top-line `why_not_now`. Lower index wins. */
const WHY_NOT_NOW_PRECEDENCE: readonly RecoveryAdmissionDenialReason[] = [
  "owner_required",
  "system_issue",
  "budget",
  "cooldown",
];

/**
 * Summarize the connector-neutral recovery admission over a connection's durable
 * pending gap rows for owner-only diagnostics (task 2.6). Pure: the caller
 * supplies the rows (a bounded read of `connector_detail_gaps`) and `now`; this
 * re-derives `resolveRecoveryAdmission` per row and rolls the decisions up.
 *
 * When at least one row is admissible, `why_not_now` is omitted — the connection
 * is not blocked, it simply has eligible recovery work. When NOTHING is
 * admissible, `why_not_now` names the single most owner-relevant blocker so the
 * diagnostics read answers "why didn't it run" without the owner reading raw
 * per-row classes.
 */
export function summarizeRecoveryAdmissionDiagnostics(
  rows: readonly RecoveryGapRow[],
  options: RecoveryAdmissionOptions = {}
): RecoveryAdmissionDiagnostics {
  const candidateRows = rows ?? [];
  let admitted = 0;
  const deferredByReason = new Map<RecoveryAdmissionDenialReason, number>();
  let nextEligibleAt: string | null = null;
  for (const row of candidateRows) {
    const admission = resolveRecoveryAdmission(row, options);
    if (admission.ok) {
      admitted += 1;
      continue;
    }
    deferredByReason.set(admission.reason, (deferredByReason.get(admission.reason) ?? 0) + 1);
    if (
      typeof admission.nextEligibleAt === "string" &&
      admission.nextEligibleAt &&
      (nextEligibleAt === null || admission.nextEligibleAt < nextEligibleAt)
    ) {
      nextEligibleAt = admission.nextEligibleAt;
    }
  }
  const deferred = candidateRows.length - admitted;
  const diagnostics: {
    admitted: number;
    candidates: number;
    deferred: number;
    deferred_by_reason?: Record<RecoveryAdmissionDenialReason, number>;
    next_eligible_at?: string;
    why_not_now?: RecoveryAdmissionDenialReason;
  } = {
    candidates: candidateRows.length,
    admitted,
    deferred,
  };
  if (deferred > 0) {
    diagnostics.deferred_by_reason = Object.fromEntries(deferredByReason) as Record<
      RecoveryAdmissionDenialReason,
      number
    >;
  }
  if (nextEligibleAt) {
    diagnostics.next_eligible_at = nextEligibleAt;
  }
  // `why_not_now` only when the connection has candidate work but none is
  // admissible now — otherwise there IS eligible work and nothing to explain.
  if (candidateRows.length > 0 && admitted === 0) {
    diagnostics.why_not_now = pickWhyNotNow(deferredByReason);
  }
  return diagnostics;
}

function pickWhyNotNow(
  deferredByReason: ReadonlyMap<RecoveryAdmissionDenialReason, number>
): RecoveryAdmissionDenialReason {
  for (const reason of WHY_NOT_NOW_PRECEDENCE) {
    if (deferredByReason.has(reason)) {
      return reason;
    }
  }
  // Every deferral reason is covered by the precedence list; this is only
  // reached if the set is empty, which the caller already guards against.
  return "cooldown";
}

// ─── Stall watchdog (task 2.7, observe-only) ─────────────────────────────────
//
// design.md D8 / spec "Stalled eligibility becomes observable": queued recovery
// is a live scheduling state with a liveness obligation. Eligible work that
// receives no attempt beyond the expected cadence window is not "still catching
// up" — it is a detectable stall the runtime must surface as a system condition
// to owner-only diagnostics, never leave as silent queue rot.
//
// This is the RUNTIME/server-side observation, distinct from and complementary
// to the console projection's `deriveRecoveryStep(...) === "stalled"` (task 4.5,
// `apps/console/.../source-recovery-state.ts`), which reads the projected
// backlog. Here we read the durable gap rows directly (their real
// `last_attempt_at` / `updated_at` recency) so diagnostics can report the stall
// with the row-level evidence it has.
//
// CRITICAL (task 2.7): this OBSERVES ONLY. It returns a decision object; it
// never admits work, mutates a row, arms/clears a cooldown, or bypasses any
// gate. A stall is a report, not a force-admit — the whole point is that the
// watchdog surfaces coupling bugs (like the live 51-holds-942 residue) without
// itself becoming a way around the governor.

/**
 * The default cadence window the runtime stall watchdog arms against. Matches
 * the console surface's `RECOVERY_STALL_CADENCE_MS` (6h) so the runtime and UI
 * agree on when eligible-but-unattempted work is a stall rather than normal
 * cadence. Deliberately generous relative to normal recovery cadence.
 */
export const RECOVERY_STALL_CADENCE_MS = 6 * 60 * 60 * 1000;

/**
 * The observe-only stall observation for one connection. `stalled` is true when
 * at least one row is admissible now (eligible) yet the newest attempt across
 * the eligible rows is older than the cadence window — eligible work has stopped
 * receiving attempts. Carries the supporting recency evidence and the count of
 * eligible rows so diagnostics can render the system condition.
 */
export interface RecoveryStallObservation {
  /** Number of rows admissible right now (eligible for a recovery attempt). */
  readonly eligibleCandidates: number;
  /** ISO time of the most recent attempt across eligible rows, or null if none. */
  readonly lastAttemptAt: string | null;
  /** True when eligible work has received no attempt within the cadence window. */
  readonly stalled: boolean;
}

export interface RecoveryStallOptions extends RecoveryAdmissionOptions {
  /** Cadence window in ms. Defaults to {@link RECOVERY_STALL_CADENCE_MS}. */
  readonly cadenceWindowMs?: number;
}

/**
 * Observe whether a connection's eligible recovery work has stalled: eligible
 * now, but no attempt within the cadence window. Pure and side-effect-free.
 *
 * A row counts toward the stall only when {@link resolveRecoveryAdmission} would
 * admit it now — a row waiting on a cooldown or an owner-required blocker is NOT
 * a stall, it is correctly deferred. The stall fires when admissible work is
 * being ignored (nothing is attempting it) beyond the cadence window. When `now`
 * is omitted the observation is time-free and never reports a stall (matching the
 * console derivation's time-free contract).
 */
export function deriveRecoveryStall(
  rows: readonly RecoveryGapRow[],
  options: RecoveryStallOptions = {}
): RecoveryStallObservation {
  const candidateRows = rows ?? [];
  const cadenceWindowMs = normalizeNonNegativeInteger(options.cadenceWindowMs, RECOVERY_STALL_CADENCE_MS);
  let eligibleCandidates = 0;
  let newestAttemptMs: number | null = null;
  let newestAttemptIso: string | null = null;
  for (const row of candidateRows) {
    if (!resolveRecoveryAdmission(row, options).ok) {
      continue;
    }
    eligibleCandidates += 1;
    const attemptIso = lastPressureAtForGap(row); // last_attempt_at then updated_at
    const attemptMs = parseIso(attemptIso);
    if (attemptMs !== null && (newestAttemptMs === null || attemptMs > newestAttemptMs)) {
      newestAttemptMs = attemptMs;
      newestAttemptIso = attemptIso;
    }
  }

  const stalled = computeStalled({
    eligibleCandidates,
    newestAttemptMs,
    cadenceWindowMs,
    nowMs: options.nowMs,
  });
  return { eligibleCandidates, lastAttemptAt: newestAttemptIso, stalled };
}

function computeStalled(input: {
  cadenceWindowMs: number;
  eligibleCandidates: number;
  newestAttemptMs: number | null;
  nowMs: number | undefined;
}): boolean {
  // Time-free (no `now`) never reports a stall; a zero/negative window disables
  // the watchdog; no eligible work cannot be stalled.
  if (input.nowMs === undefined || input.cadenceWindowMs <= 0 || input.eligibleCandidates === 0) {
    return false;
  }
  const nowMs = normalizeEpochMs(input.nowMs);
  // No attempt timestamp at all on eligible work IS a stall: eligible work that
  // has never recorded an attempt is not receiving attempts. A newest attempt
  // older than the cadence window is likewise a stall.
  if (input.newestAttemptMs === null) {
    return true;
  }
  return nowMs - input.newestAttemptMs > input.cadenceWindowMs;
}

// ─── Local helpers (pure) ────────────────────────────────────────────────────

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNonNegativeInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeEpochMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function parseIso(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
