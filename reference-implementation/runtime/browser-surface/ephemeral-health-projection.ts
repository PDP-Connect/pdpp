/**
 * Current runtime capability is deliberately independent from connection
 * health.  In particular, a dynamic allocator may be callable while it has no
 * warm surfaces, and a historical successful run says nothing about either.
 */

export type EphemeralBrowserConnectionKind = "browser-runtime" | "unmanaged-browser" | "non-browser" | "local-device";

export type EphemeralBrowserSurfaceMode = "dynamic-managed" | "static-managed" | "none";

export type AllocatorObservationReason = "expired" | "fetch" | "http" | "malformed" | "not_observed" | "timeout";

export interface AllocatorObservation {
  readonly expires_at?: string;
  readonly observed_at?: string;
  readonly reason?: AllocatorObservationReason;
  readonly status: "available" | "unavailable" | "unknown";
}

export interface ActiveLeaseExecution {
  readonly health: "missing" | "ready" | "starting" | "stopping" | "unhealthy";
  readonly lease_id: string;
  readonly surface_id: string;
}

export interface StaticSurfaceExecution {
  readonly readable: boolean;
  readonly status: "absent" | "ready" | "unhealthy" | "unknown";
}

export interface LastSuccessfulRuntimeReceipt {
  readonly completed_at: string;
  readonly connection_id: string;
  readonly connector_id: string;
  readonly generation: number;
  readonly lease_id: string;
  readonly lifecycle: readonly ["ready", "succeeded", "released"];
  readonly profile_key: string;
  readonly run_id: string;
  readonly surface_id: string;
  readonly surface_subject_id: string;
}

/** The replacement ledger owns the concrete shape; health only carries it. */
export interface CurrentReplacementReceipt {
  readonly connection_id: string;
  readonly phase: "completed" | "started" | "terminal";
  readonly replacement_id: string;
  /**
   * Single-instance connectors are scoped by `connection_id` alone in Luna;
   * multi-instance connectors carry this additional subject discriminator.
   */
  readonly surface_subject_id?: string;
  readonly [field: string]: unknown;
}

export type CredentialContinuity =
  | "continuity_proven"
  | "indeterminate"
  | "not_applicable"
  | "rehydration_false"
  | "replacement_pending";

export interface EphemeralBrowserRuntimeProjection {
  readonly active_lease: ActiveLeaseExecution | null;
  readonly allocator_observation: AllocatorObservation | null;
  readonly connection_kind: EphemeralBrowserConnectionKind;
  readonly credential_continuity: CredentialContinuity;
  readonly current_compatible_idle_surfaces: number;
  readonly current_replacement_receipt: CurrentReplacementReceipt | null;
  readonly demand: "active" | "none";
  /** True only when the runtime axis may contribute healthy evidence. */
  readonly health_eligible: boolean;
  readonly last_successful_runtime_receipt: LastSuccessfulRuntimeReceipt | null;
  readonly surface_mode: EphemeralBrowserSurfaceMode;
}

export interface ProjectEphemeralBrowserSurfaceHealthInput {
  readonly active_lease?: ActiveLeaseExecution | null;
  readonly allocator_observation?: AllocatorObservation | null;
  readonly connection_id: string;
  readonly connection_kind: EphemeralBrowserConnectionKind;
  readonly credential_continuity?: CredentialContinuity;
  readonly current_compatible_idle_surfaces?: number;
  readonly current_replacement_receipt?: CurrentReplacementReceipt | null;
  readonly demand?: "active" | "none";
  readonly last_successful_runtime_receipt?: LastSuccessfulRuntimeReceipt | null;
  /** The caller's read time, used to turn an expired available observation into unknown. */
  readonly now?: string;
  readonly static_surface?: StaticSurfaceExecution | null;
  readonly surface_mode: EphemeralBrowserSurfaceMode;
}

function availableObservationCanExpire(
  observation: AllocatorObservation | null,
  now: string | undefined
): observation is AllocatorObservation & { readonly expires_at: string } {
  return observation?.status === "available" && typeof observation.expires_at === "string" && typeof now === "string";
}

function expirationHasPassed(expiresAt: string, now: string): boolean {
  const expiresAtMillis = Date.parse(expiresAt);
  const nowMillis = Date.parse(now);
  return Number.isFinite(expiresAtMillis) && Number.isFinite(nowMillis) && expiresAtMillis <= nowMillis;
}

function expiredObservation(observation: AllocatorObservation & { readonly expires_at: string }): AllocatorObservation {
  if (!observation.observed_at) {
    return { status: "unknown", reason: "expired", expires_at: observation.expires_at };
  }
  return {
    status: "unknown",
    reason: "expired",
    observed_at: observation.observed_at,
    expires_at: observation.expires_at,
  };
}

function currentObservation(input: ProjectEphemeralBrowserSurfaceHealthInput): AllocatorObservation | null {
  const observation = input.allocator_observation ?? null;
  const now = input.now ?? "";
  if (!availableObservationCanExpire(observation, input.now)) {
    return observation;
  }
  return expirationHasPassed(observation.expires_at, now) ? expiredObservation(observation) : observation;
}

function isCurrentAvailableObservation(observation: AllocatorObservation | null): boolean {
  return observation?.status === "available";
}

function hasHealthyActiveExecution({
  demand,
  activeLease,
}: {
  readonly demand: "active" | "none";
  readonly activeLease: ActiveLeaseExecution | null;
}): boolean {
  if (activeLease && activeLease.health !== "ready") {
    return false;
  }
  return demand !== "active" || activeLease?.health === "ready";
}

function defaultCredentialContinuity(input: ProjectEphemeralBrowserSurfaceHealthInput): CredentialContinuity {
  if (input.connection_kind !== "browser-runtime") {
    return "not_applicable";
  }
  if (input.credential_continuity) {
    return input.credential_continuity;
  }
  // No replacement is no process-boundary assertion. An ordinary scale-to-zero
  // dynamic runtime remains independent of portable-session continuity.
  if (!input.current_replacement_receipt) {
    return "not_applicable";
  }
  // A current completed replacement has not passed a provider-authentication
  // probe. It is uncertainty, not evidence of portable-session continuity.
  return input.current_replacement_receipt.phase === "started" ? "replacement_pending" : "indeterminate";
}

function runtimeHealthEligibility({
  surfaceMode,
  allocatorObservation,
  demand,
  activeLease,
  staticSurface,
}: {
  readonly surfaceMode: EphemeralBrowserSurfaceMode;
  readonly allocatorObservation: AllocatorObservation | null;
  readonly demand: "active" | "none";
  readonly activeLease: ActiveLeaseExecution | null;
  readonly staticSurface: StaticSurfaceExecution | null;
}): boolean {
  switch (surfaceMode) {
    case "none":
      return true;
    case "static-managed":
      return staticHealthEligible(staticSurface);
    case "dynamic-managed":
      return dynamicHealthEligible(allocatorObservation, demand, activeLease);
  }
}

function staticHealthEligible(staticSurface: StaticSurfaceExecution | null): boolean {
  return staticSurface?.readable === true && staticSurface.status === "ready";
}

function dynamicHealthEligible(
  allocatorObservation: AllocatorObservation | null,
  demand: "active" | "none",
  activeLease: ActiveLeaseExecution | null
): boolean {
  return isCurrentAvailableObservation(allocatorObservation) && hasHealthyActiveExecution({ demand, activeLease });
}

interface NormalizedRuntimeEvidence {
  readonly allocatorObservation: AllocatorObservation | null;
  readonly lastSuccessfulRuntimeReceipt: LastSuccessfulRuntimeReceipt | null;
  readonly staticSurface: StaticSurfaceExecution | null;
}

function normalizeRuntimeEvidence(input: ProjectEphemeralBrowserSurfaceHealthInput): NormalizedRuntimeEvidence {
  return {
    allocatorObservation: currentObservation(input),
    lastSuccessfulRuntimeReceipt: input.last_successful_runtime_receipt ?? null,
    staticSurface: input.static_surface ?? null,
  };
}

function normalizeRuntimeExecution(input: ProjectEphemeralBrowserSurfaceHealthInput): {
  readonly activeLease: ActiveLeaseExecution | null;
  readonly demand: "active" | "none";
} {
  return { activeLease: input.active_lease ?? null, demand: input.demand ?? "none" };
}

function buildRuntimeProjection(
  input: ProjectEphemeralBrowserSurfaceHealthInput,
  evidence: NormalizedRuntimeEvidence,
  execution: ReturnType<typeof normalizeRuntimeExecution>
): EphemeralBrowserRuntimeProjection {
  const healthEligible = runtimeHealthEligibility({
    surfaceMode: input.surface_mode,
    allocatorObservation: evidence.allocatorObservation,
    demand: execution.demand,
    activeLease: execution.activeLease,
    staticSurface: evidence.staticSurface,
  });
  return {
    connection_kind: input.connection_kind,
    surface_mode: input.surface_mode,
    allocator_observation: input.surface_mode === "none" ? null : evidence.allocatorObservation,
    demand: execution.demand,
    active_lease: execution.activeLease,
    current_compatible_idle_surfaces: input.current_compatible_idle_surfaces ?? 0,
    credential_continuity: defaultCredentialContinuity(input),
    last_successful_runtime_receipt: evidence.lastSuccessfulRuntimeReceipt,
    current_replacement_receipt: input.current_replacement_receipt ?? null,
    health_eligible: healthEligible,
  };
}

/**
 * Pure, fail-closed classification of the runtime axis. No receipt, profile,
 * or continuity value can turn an unavailable allocator or missing active
 * lease green.
 */
export function projectEphemeralBrowserSurfaceHealth(
  input: ProjectEphemeralBrowserSurfaceHealthInput
): EphemeralBrowserRuntimeProjection {
  return buildRuntimeProjection(input, normalizeRuntimeEvidence(input), normalizeRuntimeExecution(input));
}
