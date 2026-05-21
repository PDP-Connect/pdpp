export const BROWSER_SURFACE_BACKEND_NEKO = "neko" as const;

export const BROWSER_SURFACE_LEASE_STATUSES = [
  "waiting_for_browser_surface",
  "starting_surface",
  "leased",
  "released",
  "expired",
  "deferred",
  "cancelled",
  "surface_failed",
] as const;

export const BROWSER_SURFACE_WAIT_REASONS = [
  "capacity_full",
  "surface_starting",
  "surface_unhealthy",
  "surface_start_failed",
  "surface_readiness_timeout",
  "incompatible_static_profile",
  "launch_precondition_failed",
  "lease_wait_timeout",
] as const;

export const BROWSER_SURFACE_PRIORITY_CLASSES = ["owner_interactive", "scheduled_refresh"] as const;

export const TERMINAL_BROWSER_SURFACE_LEASE_STATUSES = [
  "released",
  "expired",
  "deferred",
  "cancelled",
  "surface_failed",
] as const;

export const DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_NEKO_IDLE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NEKO_PRIORITY_CLASS: BrowserSurfacePriorityClass = "scheduled_refresh";
export const DEFAULT_NEKO_PRIORITY_RANKS: Readonly<Record<BrowserSurfacePriorityClass, number>> = {
  owner_interactive: 0,
  scheduled_refresh: 1,
};

const TERMINAL_STATUS_SET = new Set<BrowserSurfaceLeaseStatus>(TERMINAL_BROWSER_SURFACE_LEASE_STATUSES);

export type BrowserSurfaceBackend = typeof BROWSER_SURFACE_BACKEND_NEKO;
export type BrowserSurfaceLeaseStatus = (typeof BROWSER_SURFACE_LEASE_STATUSES)[number];
export type BrowserSurfaceWaitReason = (typeof BROWSER_SURFACE_WAIT_REASONS)[number];
export type BrowserSurfacePriorityClass = (typeof BROWSER_SURFACE_PRIORITY_CLASSES)[number];
export type BrowserSurfaceHealth = "starting" | "ready" | "unhealthy" | "stopping";
export type BrowserSurfaceMode = "static" | "dynamic";

export interface BrowserSurface {
  readonly surface_id: string;
  readonly backend: BrowserSurfaceBackend;
  readonly profile_key: string;
  readonly connector_id: string;
  readonly cdp_url: string;
  readonly stream_base_url: string;
  readonly health: BrowserSurfaceHealth;
  readonly created_at: string;
  readonly last_used_at: string;
  readonly account_key?: string;
  readonly surface_subject_id?: string;
  readonly active_lease_id?: string;
  readonly container_id?: string;
  readonly allocator_metadata?: Readonly<Record<string, string>>;
}

export interface BrowserSurfaceLease {
  readonly lease_id: string;
  readonly connector_id: string;
  readonly profile_key: string;
  readonly run_id: string;
  readonly status: BrowserSurfaceLeaseStatus;
  readonly priority_class: BrowserSurfacePriorityClass;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly fencing_token: number;
  readonly account_key?: string;
  readonly surface_subject_id?: string;
  readonly leased_at?: string;
  readonly released_at?: string;
  readonly surface_id?: string;
  readonly wait_reason?: BrowserSurfaceWaitReason;
}

export interface BrowserSurfaceProjection {
  readonly pending_run_id: string;
  readonly browser_surface_status: BrowserSurfaceLeaseStatus;
  readonly browser_surface_lease_id: string;
  readonly browser_surface_profile_key: string;
  readonly browser_surface_wait_reason?: BrowserSurfaceWaitReason;
}

export interface BrowserSurfaceLeaseConfig {
  readonly managedConnectors: ReadonlySet<string>;
  readonly surfaceCap: number;
  readonly staticProfileKey?: string;
  readonly staticCdpHttpUrl?: string;
  readonly staticStreamBaseUrl?: string;
  readonly leaseWaitTimeoutMs: number;
  readonly idleTtlMs: number;
  readonly defaultPriorityClass: BrowserSurfacePriorityClass;
  readonly priorityRanks: Readonly<Record<BrowserSurfacePriorityClass, number>>;
  readonly surfaceMode: BrowserSurfaceMode;
}

export interface BrowserSurfaceLeaseManagerOptions {
  readonly config: BrowserSurfaceLeaseConfig;
  readonly now?: () => Date;
  readonly makeLeaseId?: () => string;
  readonly makeSurfaceId?: () => string;
  readonly nextFencingToken?: () => number;
  readonly initialSurfaces?: readonly BrowserSurface[];
  readonly initialLeases?: readonly BrowserSurfaceLease[];
  readonly releasePromotesNext?: boolean;
}

export interface AcquireBrowserSurfaceLeaseRequest {
  readonly connectorId: string;
  readonly runId: string;
  readonly profileKey?: string;
  readonly accountKey?: string;
  readonly surfaceSubjectId?: string;
  readonly priorityClass?: BrowserSurfacePriorityClass;
}

export interface AcquireSurfaceLeaseRequest {
  readonly sessionId: string;
  readonly surfaceKind: string;
  readonly profileKey?: string;
  readonly accountKey?: string;
  readonly sessionSubjectId?: string;
  readonly priorityClass?: BrowserSurfacePriorityClass;
}

export interface AcquireBrowserSurfaceSessionLeaseRequest extends Omit<AcquireSurfaceLeaseRequest, "surfaceKind"> {
  readonly surfaceKind?: string;
  /** @deprecated Use surfaceKind for host-neutral integrations. */
  readonly connectorId?: string;
}

export interface SurfaceLeaseManagerConfig {
  readonly managedSurfaceKinds: ReadonlySet<string>;
  readonly surfaceCap: number;
  readonly staticProfileKey?: string;
  readonly staticCdpHttpUrl?: string;
  readonly staticStreamBaseUrl?: string;
  readonly leaseWaitTimeoutMs: number;
  readonly idleTtlMs: number;
  readonly defaultPriorityClass: BrowserSurfacePriorityClass;
  readonly priorityRanks: Readonly<Record<BrowserSurfacePriorityClass, number>>;
  readonly surfaceMode: BrowserSurfaceMode;
}

export interface SurfaceLeaseManagerOptions {
  readonly config: SurfaceLeaseManagerConfig;
  readonly now?: () => Date;
  readonly makeLeaseId?: () => string;
  readonly makeSurfaceId?: () => string;
  readonly nextFencingToken?: () => number;
  readonly initialSurfaces?: readonly BrowserSurface[];
  readonly initialLeases?: readonly BrowserSurfaceLease[];
  readonly releasePromotesNext?: boolean;
}

export interface SurfaceLease {
  readonly leaseId: string;
  readonly surfaceKind: string;
  readonly profileKey: string;
  readonly sessionId: string;
  readonly status: BrowserSurfaceLeaseStatus;
  readonly priorityClass: BrowserSurfacePriorityClass;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly fencingToken: number;
  readonly accountKey?: string;
  readonly sessionSubjectId?: string;
  readonly leasedAt?: string;
  readonly releasedAt?: string;
  readonly surfaceId?: string;
  readonly waitReason?: BrowserSurfaceWaitReason;
}

export interface SurfaceLeaseResult {
  readonly lease: SurfaceLease;
  readonly surface?: BrowserSurface;
  readonly duplicateOf?: SurfaceLease;
}

export interface ReleaseSurfaceLeaseRequest {
  readonly leaseId: string;
  readonly fencingToken: number;
}

export interface ReleaseSurfaceLeaseResult {
  readonly released: boolean;
  readonly stale: boolean;
  readonly lease?: SurfaceLease;
  readonly promoted?: SurfaceLease;
  readonly surface?: BrowserSurface;
}

export interface RenewBrowserSurfaceLeaseRequest {
  readonly leaseId: string;
  readonly fencingToken?: number;
  readonly ttlMs?: number;
}

export interface RenewBrowserSurfaceLeaseResult {
  readonly renewed: boolean;
  readonly stale: boolean;
  readonly lease?: BrowserSurfaceLease;
}

export interface RenewSurfaceLeaseRequest {
  readonly leaseId: string;
  readonly fencingToken?: number;
  readonly ttlMs?: number;
}

export interface RenewSurfaceLeaseResult {
  readonly renewed: boolean;
  readonly stale: boolean;
  readonly lease?: SurfaceLease;
}

export interface TerminalSurfaceLeaseResult {
  readonly stale: boolean;
  readonly lease?: SurfaceLease;
  readonly promoted?: SurfaceLease;
  readonly surface?: BrowserSurface;
}

export interface BrowserSurfaceLeaseResult {
  readonly lease: BrowserSurfaceLease;
  readonly surface?: BrowserSurface;
  readonly duplicateOf?: BrowserSurfaceLease;
}

export interface ReleaseBrowserSurfaceLeaseRequest {
  readonly leaseId: string;
  readonly fencingToken: number;
}

export interface ReleaseBrowserSurfaceLeaseResult {
  readonly released: boolean;
  readonly stale: boolean;
  readonly lease?: BrowserSurfaceLease;
  readonly promoted?: BrowserSurfaceLease;
  readonly surface?: BrowserSurface;
}

export interface TerminalBrowserSurfaceLeaseResult {
  readonly stale: boolean;
  readonly lease?: BrowserSurfaceLease;
  readonly promoted?: BrowserSurfaceLease;
  readonly surface?: BrowserSurface;
}

export interface ReconcileBrowserSurfaceLeasesAfterRestartRequest {
  readonly activeRunIds?: ReadonlySet<string>;
  readonly promoteQueued?: boolean;
}

export interface ReconcileSurfaceLeasesAfterRestartRequest {
  readonly activeSessionIds?: ReadonlySet<string>;
  readonly promoteQueued?: boolean;
}

export interface ReconcileBrowserSurfaceLeasesAfterRestartResult {
  readonly released: BrowserSurfaceLease[];
  readonly expired: BrowserSurfaceLease[];
  readonly deferred: BrowserSurfaceLease[];
  readonly surfaceFailed: BrowserSurfaceLease[];
  readonly queued: BrowserSurfaceLease[];
  readonly activeLeased: BrowserSurfaceLease[];
  readonly promoted: BrowserSurfaceLease[];
}

export interface ReconcileSurfaceLeasesAfterRestartResult {
  readonly released: SurfaceLease[];
  readonly expired: SurfaceLease[];
  readonly deferred: SurfaceLease[];
  readonly surfaceFailed: SurfaceLease[];
  readonly queued: SurfaceLease[];
  readonly activeLeased: SurfaceLease[];
  readonly promoted: SurfaceLease[];
}

export interface CleanupIdleBrowserSurfacesResult {
  readonly stopped: BrowserSurface[];
  readonly promoted: BrowserSurfaceLease[];
}

export interface CompleteBrowserSurfaceCapacityReclaimResult {
  readonly stopped?: BrowserSurface;
  readonly promoted?: BrowserSurfaceLease;
}

export interface EnsureBrowserSurfaceRequest {
  readonly surfaceId: string;
  readonly connectorId: string;
  readonly profileKey: string;
  readonly accountKey?: string;
  readonly surfaceSubjectId?: string;
}

export interface StopBrowserSurfaceRequest {
  readonly surfaceId: string;
  readonly reason: "capacity_pressure" | "idle_ttl" | "operator" | "reconcile" | "surface_failed";
}

export interface BrowserSurfaceAllocator {
  ensureSurface(request: EnsureBrowserSurfaceRequest): Promise<BrowserSurface>;
  getSurfaceStatus(surfaceId: string): Promise<BrowserSurface | null>;
  stopSurface(request: StopBrowserSurfaceRequest): Promise<BrowserSurface | null>;
  listSurfaces(): Promise<BrowserSurface[]>;
}

export interface EnsureStartingBrowserSurfaceRequest {
  readonly leaseId: string;
  readonly allocator: BrowserSurfaceAllocator;
  readonly readinessTimeoutMs?: number;
}

export function isTerminalBrowserSurfaceLeaseStatus(status: BrowserSurfaceLeaseStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

export function projectBrowserSurfaceLease(lease: BrowserSurfaceLease): BrowserSurfaceProjection {
  return {
    pending_run_id: lease.run_id,
    browser_surface_status: lease.status,
    browser_surface_lease_id: lease.lease_id,
    browser_surface_profile_key: lease.profile_key,
    ...(lease.wait_reason ? { browser_surface_wait_reason: lease.wait_reason } : {}),
  };
}

export interface SurfaceLeaseProjection {
  readonly surface_session_id: string;
  readonly surface_lease_status: BrowserSurfaceLeaseStatus;
  readonly surface_lease_id: string;
  readonly surface_profile_key: string;
  readonly surface_wait_reason?: BrowserSurfaceWaitReason;
}

export function projectSurfaceLease(lease: BrowserSurfaceLease): SurfaceLeaseProjection {
  return {
    surface_session_id: lease.run_id,
    surface_lease_status: lease.status,
    surface_lease_id: lease.lease_id,
    surface_profile_key: lease.profile_key,
    ...(lease.wait_reason ? { surface_wait_reason: lease.wait_reason } : {}),
  };
}

export function toSurfaceLease(lease: BrowserSurfaceLease): SurfaceLease {
  return {
    leaseId: lease.lease_id,
    surfaceKind: lease.connector_id,
    profileKey: lease.profile_key,
    sessionId: lease.run_id,
    status: lease.status,
    priorityClass: lease.priority_class,
    requestedAt: lease.requested_at,
    expiresAt: lease.expires_at,
    fencingToken: lease.fencing_token,
    ...(lease.account_key ? { accountKey: lease.account_key } : {}),
    ...(lease.surface_subject_id ? { sessionSubjectId: lease.surface_subject_id } : {}),
    ...(lease.leased_at ? { leasedAt: lease.leased_at } : {}),
    ...(lease.released_at ? { releasedAt: lease.released_at } : {}),
    ...(lease.surface_id ? { surfaceId: lease.surface_id } : {}),
    ...(lease.wait_reason ? { waitReason: lease.wait_reason } : {}),
  };
}

function toSurfaceLeaseResult(result: BrowserSurfaceLeaseResult): SurfaceLeaseResult {
  return {
    lease: toSurfaceLease(result.lease),
    ...(result.surface ? { surface: result.surface } : {}),
    ...(result.duplicateOf ? { duplicateOf: toSurfaceLease(result.duplicateOf) } : {}),
  };
}

function toReleaseSurfaceLeaseResult(result: ReleaseBrowserSurfaceLeaseResult): ReleaseSurfaceLeaseResult {
  return {
    released: result.released,
    stale: result.stale,
    ...(result.lease ? { lease: toSurfaceLease(result.lease) } : {}),
    ...(result.promoted ? { promoted: toSurfaceLease(result.promoted) } : {}),
    ...(result.surface ? { surface: result.surface } : {}),
  };
}

function toRenewSurfaceLeaseResult(result: RenewBrowserSurfaceLeaseResult): RenewSurfaceLeaseResult {
  return {
    renewed: result.renewed,
    stale: result.stale,
    ...(result.lease ? { lease: toSurfaceLease(result.lease) } : {}),
  };
}

function toTerminalSurfaceLeaseResult(result: TerminalBrowserSurfaceLeaseResult): TerminalSurfaceLeaseResult {
  return {
    stale: result.stale,
    ...(result.lease ? { lease: toSurfaceLease(result.lease) } : {}),
    ...(result.promoted ? { promoted: toSurfaceLease(result.promoted) } : {}),
    ...(result.surface ? { surface: result.surface } : {}),
  };
}

function toReconcileSurfaceLeasesAfterRestartResult(
  result: ReconcileBrowserSurfaceLeasesAfterRestartResult,
): ReconcileSurfaceLeasesAfterRestartResult {
  return {
    released: result.released.map(toSurfaceLease),
    expired: result.expired.map(toSurfaceLease),
    deferred: result.deferred.map(toSurfaceLease),
    surfaceFailed: result.surfaceFailed.map(toSurfaceLease),
    queued: result.queued.map(toSurfaceLease),
    activeLeased: result.activeLeased.map(toSurfaceLease),
    promoted: result.promoted.map(toSurfaceLease),
  };
}

function toBrowserSurfaceLeaseConfig(config: SurfaceLeaseManagerConfig): BrowserSurfaceLeaseConfig {
  return {
    managedConnectors: config.managedSurfaceKinds,
    surfaceCap: config.surfaceCap,
    ...(config.staticProfileKey ? { staticProfileKey: config.staticProfileKey } : {}),
    ...(config.staticCdpHttpUrl ? { staticCdpHttpUrl: config.staticCdpHttpUrl } : {}),
    ...(config.staticStreamBaseUrl ? { staticStreamBaseUrl: config.staticStreamBaseUrl } : {}),
    leaseWaitTimeoutMs: config.leaseWaitTimeoutMs,
    idleTtlMs: config.idleTtlMs,
    defaultPriorityClass: config.defaultPriorityClass,
    priorityRanks: config.priorityRanks,
    surfaceMode: config.surfaceMode,
  };
}

export class SurfaceLeaseManager {
  readonly #manager: BrowserSurfaceLeaseManager;

  constructor(options: SurfaceLeaseManagerOptions) {
    this.#manager = new BrowserSurfaceLeaseManager({
      config: toBrowserSurfaceLeaseConfig(options.config),
      ...(options.now ? { now: options.now } : {}),
      ...(options.makeLeaseId ? { makeLeaseId: options.makeLeaseId } : {}),
      ...(options.makeSurfaceId ? { makeSurfaceId: options.makeSurfaceId } : {}),
      ...(options.nextFencingToken ? { nextFencingToken: options.nextFencingToken } : {}),
      ...(options.initialSurfaces ? { initialSurfaces: options.initialSurfaces } : {}),
      ...(options.initialLeases ? { initialLeases: options.initialLeases } : {}),
      ...(typeof options.releasePromotesNext === "boolean" ? { releasePromotesNext: options.releasePromotesNext } : {}),
    });
  }

  listLeases(): SurfaceLease[] {
    return this.#manager.listLeases().map(toSurfaceLease);
  }

  listSurfaces(): BrowserSurface[] {
    return this.#manager.listSurfaces();
  }

  getLease(leaseId: string): SurfaceLease | undefined {
    const lease = this.#manager.getLease(leaseId);
    return lease ? toSurfaceLease(lease) : undefined;
  }

  getSurface(surfaceId: string): BrowserSurface | undefined {
    return this.#manager.getSurface(surfaceId);
  }

  isManagedSurfaceKind(surfaceKind: string): boolean {
    return this.#manager.isManagedConnector(surfaceKind);
  }

  acquire(request: AcquireSurfaceLeaseRequest): SurfaceLeaseResult {
    if (!request.surfaceKind) {
      throw new Error("SurfaceLeaseManager.acquire requires surfaceKind");
    }
    return toSurfaceLeaseResult(
      this.#manager.acquire({
        connectorId: request.surfaceKind,
        runId: request.sessionId,
        ...(request.profileKey ? { profileKey: request.profileKey } : {}),
        ...(request.accountKey ? { accountKey: request.accountKey } : {}),
        ...(request.sessionSubjectId ? { surfaceSubjectId: request.sessionSubjectId } : {}),
        ...(request.priorityClass ? { priorityClass: request.priorityClass } : {}),
      }),
    );
  }

  release(request: ReleaseSurfaceLeaseRequest): ReleaseSurfaceLeaseResult {
    return toReleaseSurfaceLeaseResult(this.#manager.release(request));
  }

  renewLease(request: RenewSurfaceLeaseRequest): RenewSurfaceLeaseResult {
    return toRenewSurfaceLeaseResult(this.#manager.renew(request));
  }

  cancelSession(sessionId: string): SurfaceLease | undefined {
    const lease = this.#manager.cancelSurfaceSession(sessionId);
    return lease ? toSurfaceLease(lease) : undefined;
  }

  cancelSessionAndPump(sessionId: string): TerminalSurfaceLeaseResult {
    return toTerminalSurfaceLeaseResult(this.#manager.cancelSurfaceSessionAndPump(sessionId));
  }

  reconcileAfterRestart(request: ReconcileSurfaceLeasesAfterRestartRequest = {}): ReconcileSurfaceLeasesAfterRestartResult {
    return toReconcileSurfaceLeasesAfterRestartResult(this.#manager.reconcileSurfaceSessionsAfterRestart(request));
  }
}

export function createSurfaceLeaseManager(options: SurfaceLeaseManagerOptions): SurfaceLeaseManager {
  return new SurfaceLeaseManager(options);
}

export class BrowserSurfaceLeaseManager {
  readonly #config: BrowserSurfaceLeaseConfig;
  readonly #now: () => Date;
  readonly #makeLeaseId: () => string;
  readonly #makeSurfaceId: () => string;
  readonly #nextFencingToken: () => number;
  readonly #releasePromotesNext: boolean;
  readonly #leases = new Map<string, BrowserSurfaceLease>();
  readonly #surfaces = new Map<string, BrowserSurface>();

  constructor(options: BrowserSurfaceLeaseManagerOptions) {
    this.#config = options.config;
    assertValidBrowserSurfaceLeaseConfig(this.#config);
    this.#now = options.now ?? (() => new Date());
    this.#makeLeaseId = options.makeLeaseId ?? (() => `bsl_${crypto.randomUUID()}`);
    this.#makeSurfaceId = options.makeSurfaceId ?? (() => `bs_${crypto.randomUUID()}`);
    this.#releasePromotesNext = options.releasePromotesNext ?? true;
    let token = 0;
    this.#nextFencingToken = options.nextFencingToken ?? (() => {
      token += 1;
      return token;
    });
    const filteredSurfaceIds = new Set<string>();
    for (const surface of options.initialSurfaces ?? []) {
      if (this.#isCompatibleInitialSurface(surface)) {
        this.#surfaces.set(surface.surface_id, surface);
      } else {
        filteredSurfaceIds.add(surface.surface_id);
      }
    }
    for (const lease of options.initialLeases ?? []) {
      if (lease.surface_id && filteredSurfaceIds.has(lease.surface_id)) {
        continue;
      }
      this.#leases.set(lease.lease_id, lease);
    }
  }

  get config(): BrowserSurfaceLeaseConfig {
    return this.#config;
  }

  listLeases(): BrowserSurfaceLease[] {
    return [...this.#leases.values()];
  }

  listSurfaces(): BrowserSurface[] {
    return [...this.#surfaces.values()];
  }

  getLease(leaseId: string): BrowserSurfaceLease | undefined {
    return this.#leases.get(leaseId);
  }

  getSurface(surfaceId: string): BrowserSurface | undefined {
    return this.#surfaces.get(surfaceId);
  }

  isManagedConnector(connectorId: string): boolean {
    return this.#config.managedConnectors.has(connectorId);
  }

  acquire(request: AcquireBrowserSurfaceLeaseRequest): BrowserSurfaceLeaseResult {
    const duplicate = this.#findNonTerminalRunLease(request.runId, request.surfaceSubjectId, true) ?? this.#findPendingDuplicate(request);
    if (duplicate) {
      const surface = this.#surfaceForLease(duplicate);
      return { lease: duplicate, duplicateOf: duplicate, ...(surface ? { surface } : {}) };
    }

    const now = this.#isoNow();
    const profileKey = this.#profileKeyForRequest(request);
    const baseLease: BrowserSurfaceLease = {
      lease_id: this.#makeLeaseId(),
      connector_id: request.connectorId,
      profile_key: profileKey,
      run_id: request.runId,
      status: "waiting_for_browser_surface",
      priority_class: request.priorityClass ?? this.#config.defaultPriorityClass,
      requested_at: now,
      expires_at: new Date(Date.parse(now) + this.#config.leaseWaitTimeoutMs).toISOString(),
      fencing_token: this.#nextFencingToken(),
      ...(request.accountKey ? { account_key: request.accountKey } : {}),
      ...(request.surfaceSubjectId ? { surface_subject_id: request.surfaceSubjectId } : {}),
    };

    const lease = this.#resolveNewLease(baseLease, now);
    this.#leases.set(lease.lease_id, lease);
    const surface = this.#surfaceForLease(lease);
    return { lease, ...(surface ? { surface } : {}) };
  }

  acquireSurfaceLease(request: AcquireBrowserSurfaceSessionLeaseRequest): BrowserSurfaceLeaseResult {
    const connectorId = request.surfaceKind ?? request.connectorId;
    if (!connectorId) {
      throw new Error("acquireSurfaceLease requires surfaceKind or connectorId");
    }
    return this.acquire({
      connectorId,
      runId: request.sessionId,
      ...(request.profileKey ? { profileKey: request.profileKey } : {}),
      ...(request.accountKey ? { accountKey: request.accountKey } : {}),
      ...(request.sessionSubjectId ? { surfaceSubjectId: request.sessionSubjectId } : {}),
      ...(request.priorityClass ? { priorityClass: request.priorityClass } : {}),
    });
  }

  cancel(runId: string): BrowserSurfaceLease | undefined {
    return this.cancelAndPump(runId).lease;
  }

  cancelAndPump(runId: string): TerminalBrowserSurfaceLeaseResult {
    const lease = this.#findNonTerminalRunLease(runId);
    if (!lease) {
      return { stale: true };
    }
    const cancelled = this.#terminalLease(lease, "cancelled");
    this.#leases.set(cancelled.lease_id, cancelled);
    let surface: BrowserSurface | undefined;
    let promoted: BrowserSurfaceLease | undefined;
    if (lease.surface_id) {
      surface = this.#clearSurfaceLease(lease.surface_id, lease.lease_id);
      promoted = this.#pumpQueue(surface?.surface_id);
    }
    return { stale: false, lease: cancelled, ...(surface ? { surface } : {}), ...(promoted ? { promoted } : {}) };
  }

  cancelSurfaceSession(sessionId: string): BrowserSurfaceLease | undefined {
    return this.cancelSurfaceSessionAndPump(sessionId).lease;
  }

  cancelSurfaceSessionAndPump(sessionId: string): TerminalBrowserSurfaceLeaseResult {
    return this.cancelAndPump(sessionId);
  }

  expireWaitingLeases(): BrowserSurfaceLease[] {
    const nowMs = this.#now().getTime();
    const expired: BrowserSurfaceLease[] = [];
    for (const lease of this.#leases.values()) {
      if (lease.status === "waiting_for_browser_surface" && Date.parse(lease.expires_at) <= nowMs) {
        const deferred = this.#terminalLease(lease, "deferred", "lease_wait_timeout");
        this.#leases.set(deferred.lease_id, deferred);
        expired.push(deferred);
      }
    }
    return expired;
  }

  release(request: ReleaseBrowserSurfaceLeaseRequest): ReleaseBrowserSurfaceLeaseResult {
    const lease = this.#leases.get(request.leaseId);
    if (!lease || lease.fencing_token !== request.fencingToken || lease.status !== "leased" || !lease.surface_id) {
      return { released: false, stale: true, ...(lease ? { lease } : {}) };
    }

    const released = this.#terminalLease(lease, "released");
    this.#leases.set(released.lease_id, released);
    const surface = this.#clearSurfaceLease(lease.surface_id, lease.lease_id);
    const promoted = this.#releasePromotesNext ? this.#pumpQueue(surface?.surface_id) : undefined;
    return { released: true, stale: false, lease: released, ...(surface ? { surface } : {}), ...(promoted ? { promoted } : {}) };
  }

  renew(request: RenewBrowserSurfaceLeaseRequest): RenewBrowserSurfaceLeaseResult {
    const lease = this.#leases.get(request.leaseId);
    if (
      !lease ||
      isTerminalBrowserSurfaceLeaseStatus(lease.status) ||
      (typeof request.fencingToken === "number" && lease.fencing_token !== request.fencingToken)
    ) {
      return { renewed: false, stale: true, ...(lease ? { lease } : {}) };
    }

    const ttl = Number.isFinite(request.ttlMs) && Number(request.ttlMs) > 0 ? Number(request.ttlMs) : this.#config.leaseWaitTimeoutMs;
    const renewed = {
      ...lease,
      expires_at: new Date(this.#now().getTime() + ttl).toISOString(),
    };
    this.#leases.set(renewed.lease_id, renewed);
    return { renewed: true, stale: false, lease: renewed };
  }

  async ensureStartingSurfaceReady(request: EnsureStartingBrowserSurfaceRequest): Promise<BrowserSurfaceLeaseResult> {
    const lease = this.#leases.get(request.leaseId);
    if (!lease || lease.status !== "starting_surface" || !lease.surface_id) {
      const surface = lease ? this.#surfaceForLease(lease) : undefined;
      if (!lease) {
        throw new Error(`browser surface lease not found: ${request.leaseId}`);
      }
      return { lease, ...(surface ? { surface } : {}) };
    }

    const surface = this.#surfaces.get(lease.surface_id);
    if (!surface) {
      const failed = this.#terminalLease(lease, "surface_failed", "surface_unhealthy");
      this.#leases.set(failed.lease_id, failed);
      return { lease: failed };
    }

    const readinessTimeoutMs = request.readinessTimeoutMs ?? this.#config.leaseWaitTimeoutMs;
    if (this.#now().getTime() - Date.parse(lease.requested_at) >= readinessTimeoutMs) {
      const unhealthy = { ...surface, health: "unhealthy" as const, last_used_at: this.#isoNow() };
      this.#surfaces.set(surface.surface_id, unhealthy);
      const failed = this.#terminalLease(lease, "surface_failed", "surface_readiness_timeout");
      this.#leases.set(failed.lease_id, failed);
      return { lease: failed, surface: unhealthy };
    }

    try {
      await request.allocator.ensureSurface({
        surfaceId: surface.surface_id,
        connectorId: lease.connector_id,
        profileKey: lease.profile_key,
        ...(lease.account_key ? { accountKey: lease.account_key } : {}),
        ...(lease.surface_subject_id ? { surfaceSubjectId: lease.surface_subject_id } : {}),
      });
      const status = await request.allocator.getSurfaceStatus(surface.surface_id);
      if (!status) {
        const failedSurface = { ...surface, health: "unhealthy" as const, last_used_at: this.#isoNow() };
        this.#surfaces.set(surface.surface_id, failedSurface);
        const failed = this.#terminalLease(lease, "surface_failed", "surface_unhealthy");
        this.#leases.set(failed.lease_id, failed);
        return { lease: failed, surface: failedSurface };
      }

      const syncedSurface = this.#mergeAllocatorSurface(surface, status);
      this.#surfaces.set(syncedSurface.surface_id, syncedSurface);
      if (syncedSurface.health === "ready") {
        const leased = this.#leaseSurface(lease, syncedSurface, this.#isoNow());
        this.#leases.set(leased.lease_id, leased);
        const leasedSurface = this.#surfaces.get(syncedSurface.surface_id);
        return { lease: leased, ...(leasedSurface ? { surface: leasedSurface } : {}) };
      }
      if (syncedSurface.health === "unhealthy") {
        const failed = this.#terminalLease(lease, "surface_failed", "surface_unhealthy");
        this.#leases.set(failed.lease_id, failed);
        return { lease: failed, surface: syncedSurface };
      }
      return { lease, surface: syncedSurface };
    } catch {
      const failedSurface = { ...surface, health: "unhealthy" as const, last_used_at: this.#isoNow() };
      this.#surfaces.set(surface.surface_id, failedSurface);
      const failed = this.#terminalLease(lease, "surface_failed", "surface_start_failed");
      this.#leases.set(failed.lease_id, failed);
      return { lease: failed, surface: failedSurface };
    }
  }

  deferTimedOutLease(leaseId: string): BrowserSurfaceLease | undefined {
    const lease = this.#leases.get(leaseId);
    if (!lease || isTerminalBrowserSurfaceLeaseStatus(lease.status)) {
      return lease;
    }
    const deferred = this.#terminalLease(lease, "deferred", "lease_wait_timeout");
    this.#leases.set(deferred.lease_id, deferred);
    return deferred;
  }

  deferLeasedRun(
    request: ReleaseBrowserSurfaceLeaseRequest,
    waitReason: BrowserSurfaceWaitReason = "launch_precondition_failed",
  ): TerminalBrowserSurfaceLeaseResult {
    const lease = this.#leases.get(request.leaseId);
    if (!lease || lease.fencing_token !== request.fencingToken || lease.status !== "leased" || !lease.surface_id) {
      return { stale: true, ...(lease ? { lease } : {}) };
    }

    const deferred = this.#terminalLease(lease, "deferred", waitReason);
    this.#leases.set(deferred.lease_id, deferred);
    const surface = this.#clearSurfaceLease(lease.surface_id, lease.lease_id);
    const promoted = this.#releasePromotesNext ? this.#pumpQueue(surface?.surface_id) : undefined;
    return { stale: false, lease: deferred, ...(surface ? { surface } : {}), ...(promoted ? { promoted } : {}) };
  }

  reconcileAfterRestart(
    request: ReconcileBrowserSurfaceLeasesAfterRestartRequest = {},
  ): ReconcileBrowserSurfaceLeasesAfterRestartResult {
    const activeRunIds = request.activeRunIds ?? new Set<string>();
    const result: ReconcileBrowserSurfaceLeasesAfterRestartResult = {
      released: [],
      expired: [],
      deferred: [],
      surfaceFailed: [],
      queued: [],
      activeLeased: [],
      promoted: [],
    };

    for (const lease of [...this.#leases.values()]) {
      if (isTerminalBrowserSurfaceLeaseStatus(lease.status)) {
        continue;
      }

      if (lease.status === "waiting_for_browser_surface") {
        const reconciled = this.#reconcileWaitingLease(lease);
        if (reconciled.status === "waiting_for_browser_surface") {
          result.queued.push(reconciled);
        } else if (reconciled.status === "deferred") {
          result.deferred.push(reconciled);
        }
        continue;
      }

      if (lease.status === "starting_surface") {
        const surface = lease.surface_id ? this.#surfaces.get(lease.surface_id) : undefined;
        if (!surface || surface.health === "unhealthy") {
          const failed = this.#terminalLease(lease, "surface_failed", "surface_unhealthy");
          this.#leases.set(failed.lease_id, failed);
          result.surfaceFailed.push(failed);
          continue;
        }
        result.queued.push(lease);
        continue;
      }

      if (lease.status !== "leased") {
        continue;
      }

      const surface = lease.surface_id ? this.#surfaces.get(lease.surface_id) : undefined;
      if (!surface) {
        const expired = this.#terminalLease(lease, "expired");
        this.#leases.set(expired.lease_id, expired);
        result.expired.push(expired);
        continue;
      }

      if (surface.health === "unhealthy") {
        const failed = this.#terminalLease(lease, "surface_failed", "surface_unhealthy");
        this.#leases.set(failed.lease_id, failed);
        this.#clearSurfaceLease(surface.surface_id, lease.lease_id);
        result.surfaceFailed.push(failed);
        continue;
      }

      if (activeRunIds.has(lease.run_id)) {
        result.activeLeased.push(lease);
        continue;
      }

      const released = this.#terminalLease(lease, "released");
      this.#leases.set(released.lease_id, released);
      this.#clearSurfaceLease(surface.surface_id, lease.lease_id);
      result.released.push(released);
    }

    if (request.promoteQueued !== false) {
      result.promoted.push(...this.pumpQueuedLeases());
    }

    return result;
  }

  reconcileSurfaceSessionsAfterRestart(
    request: ReconcileSurfaceLeasesAfterRestartRequest = {},
  ): ReconcileBrowserSurfaceLeasesAfterRestartResult {
    return this.reconcileAfterRestart({
      ...(request.activeSessionIds ? { activeRunIds: request.activeSessionIds } : {}),
      ...(typeof request.promoteQueued === "boolean" ? { promoteQueued: request.promoteQueued } : {}),
    });
  }

  pumpQueuedLeases(): BrowserSurfaceLease[] {
    const promoted: BrowserSurfaceLease[] = [];
    while (true) {
      const lease = this.#pumpQueue();
      if (!lease) {
        break;
      }
      promoted.push(lease);
    }
    return promoted;
  }

  async cleanupIdleSurfaces(allocator: BrowserSurfaceAllocator): Promise<CleanupIdleBrowserSurfacesResult> {
    if (this.#config.surfaceMode !== "dynamic") {
      return { stopped: [], promoted: [] };
    }

    const nowMs = this.#now().getTime();
    const expiredIdle = [...this.#surfaces.values()].filter(
      (surface) =>
        surface.backend === "neko" &&
        surface.health === "ready" &&
        !surface.active_lease_id &&
        nowMs - Date.parse(surface.last_used_at) >= this.#config.idleTtlMs,
    );

    const stopped: BrowserSurface[] = [];
    for (const surface of expiredIdle) {
      const stopping = { ...surface, health: "stopping" as const, last_used_at: this.#isoNow() };
      const stoppedSurface = await allocator.stopSurface({ surfaceId: surface.surface_id, reason: "idle_ttl" });
      this.#surfaces.delete(surface.surface_id);
      const { active_lease_id: _activeLeaseId, ...stoppedWithoutActiveLease } = stoppedSurface ?? stopping;
      stopped.push({
        ...stoppedWithoutActiveLease,
        surface_id: surface.surface_id,
        backend: "neko",
        profile_key: surface.profile_key,
        connector_id: surface.connector_id,
        health: "stopping",
        last_used_at: stopping.last_used_at,
        ...(surface.account_key ? { account_key: surface.account_key } : {}),
        ...(surface.surface_subject_id ? { surface_subject_id: surface.surface_subject_id } : {}),
      });
    }

    return { stopped, promoted: this.pumpQueuedLeases() };
  }

  planCapacityPressureReclaim(leaseId: string): BrowserSurface | undefined {
    const lease = this.#leases.get(leaseId);
    if (
      this.#config.surfaceMode !== "dynamic" ||
      !lease ||
      lease.status !== "waiting_for_browser_surface" ||
      lease.wait_reason !== "capacity_full" ||
      this.#findReadyIdleSurface(lease.profile_key, lease.surface_subject_id) ||
      this.#activeSurfaceCount() < this.#config.surfaceCap
    ) {
      return undefined;
    }
    return [...this.#surfaces.values()]
      .filter(
        (surface) =>
          surface.backend === "neko" &&
          surface.health === "ready" &&
          !surface.active_lease_id &&
          !this.#isSurfaceCompatibleWithLease(surface, lease),
      )
      .sort((a, b) => Date.parse(a.last_used_at) - Date.parse(b.last_used_at))[0];
  }

  completeCapacityPressureReclaim(surfaceId: string): CompleteBrowserSurfaceCapacityReclaimResult {
    const surface = this.#surfaces.get(surfaceId);
    if (!surface || surface.health !== "ready" || surface.active_lease_id) {
      return {};
    }
    const stopping = { ...surface, health: "stopping" as const, last_used_at: this.#isoNow() };
    this.#surfaces.set(surfaceId, stopping);
    const promoted = this.#pumpQueue();
    return { stopped: stopping, ...(promoted ? { promoted } : {}) };
  }

  #resolveNewLease(lease: BrowserSurfaceLease, now: string): BrowserSurfaceLease {
    if (this.#config.surfaceMode === "static" && this.#config.staticProfileKey && lease.profile_key !== this.#config.staticProfileKey) {
      return { ...lease, status: "deferred", wait_reason: "incompatible_static_profile" };
    }

    const idle = this.#findReadyIdleSurface(lease.profile_key, lease.surface_subject_id);
    if (idle) {
      return this.#leaseSurface(lease, idle, now);
    }

    if (this.#activeSurfaceCount() >= this.#config.surfaceCap) {
      return { ...lease, wait_reason: "capacity_full" };
    }

    const surface = this.#createSurfaceForLease(lease, now);
    this.#surfaces.set(surface.surface_id, surface);
    if (this.#config.surfaceMode === "dynamic") {
      return {
        ...lease,
        status: "starting_surface",
        wait_reason: "surface_starting",
        surface_id: surface.surface_id,
        fencing_token: this.#nextFencingToken(),
      };
    }
    return this.#leaseSurface(lease, surface, now);
  }

  #reconcileWaitingLease(lease: BrowserSurfaceLease): BrowserSurfaceLease {
    if (this.#config.surfaceMode === "static" && this.#config.staticProfileKey && lease.profile_key !== this.#config.staticProfileKey) {
      const deferred = this.#terminalLease(lease, "deferred", "incompatible_static_profile");
      this.#leases.set(deferred.lease_id, deferred);
      return deferred;
    }
    if (Date.parse(lease.expires_at) <= this.#now().getTime()) {
      const deferred = this.#terminalLease(lease, "deferred", "lease_wait_timeout");
      this.#leases.set(deferred.lease_id, deferred);
      return deferred;
    }
    return lease;
  }

  #pumpQueue(preferredSurfaceId?: string): BrowserSurfaceLease | undefined {
    this.expireWaitingLeasesWithoutPump();
    const waiting = [...this.#leases.values()]
      .filter((lease) => lease.status === "waiting_for_browser_surface")
      .sort((a, b) => this.#comparePriorityFifo(a, b));

    for (const lease of waiting) {
      const surface = preferredSurfaceId ? this.#surfaces.get(preferredSurfaceId) : this.#findReadyIdleSurface(lease.profile_key, lease.surface_subject_id);
      const compatibleSurface =
        surface?.health === "ready" && !surface.active_lease_id && this.#isSurfaceCompatibleWithLease(surface, lease)
          ? surface
          : this.#findReadyIdleSurface(lease.profile_key, lease.surface_subject_id);
      const promoted = compatibleSurface ? this.#leaseSurface(lease, compatibleSurface, this.#isoNow()) : this.#promoteWaitingLeaseToStarting(lease);
      if (!promoted) {
        continue;
      }
      this.#leases.set(promoted.lease_id, promoted);
      return promoted;
    }
    return undefined;
  }

  private expireWaitingLeasesWithoutPump(): void {
    const nowMs = this.#now().getTime();
    for (const lease of this.#leases.values()) {
      if (lease.status === "waiting_for_browser_surface" && Date.parse(lease.expires_at) <= nowMs) {
        this.#leases.set(lease.lease_id, this.#terminalLease(lease, "deferred", "lease_wait_timeout"));
      }
    }
  }

  #leaseSurface(lease: BrowserSurfaceLease, surface: BrowserSurface, now: string): BrowserSurfaceLease {
    const { wait_reason: _waitReason, ...leaseWithoutWaitReason } = lease;
    const leased: BrowserSurfaceLease = {
      ...leaseWithoutWaitReason,
      status: "leased",
      leased_at: now,
      surface_id: surface.surface_id,
      fencing_token: this.#nextFencingToken(),
    };
    this.#surfaces.set(surface.surface_id, { ...surface, active_lease_id: leased.lease_id, last_used_at: now });
    return leased;
  }

  #promoteWaitingLeaseToStarting(lease: BrowserSurfaceLease): BrowserSurfaceLease | undefined {
    if (this.#config.surfaceMode !== "dynamic" || this.#activeSurfaceCount() >= this.#config.surfaceCap) {
      return undefined;
    }
    const now = this.#isoNow();
    const surface = this.#createSurfaceForLease(lease, now);
    this.#surfaces.set(surface.surface_id, surface);
    return {
      ...lease,
      status: "starting_surface",
      wait_reason: "surface_starting",
      surface_id: surface.surface_id,
      fencing_token: this.#nextFencingToken(),
    };
  }

  #createSurfaceForLease(lease: BrowserSurfaceLease, now: string): BrowserSurface {
    return {
      surface_id: this.#config.surfaceMode === "static" ? "neko-static" : this.#makeSurfaceId(),
      backend: "neko",
      profile_key: lease.profile_key,
      connector_id: lease.connector_id,
      cdp_url: this.#config.staticCdpHttpUrl ?? "",
      stream_base_url: this.#config.staticStreamBaseUrl ?? "",
      health: this.#config.surfaceMode === "dynamic" ? "starting" : "ready",
      created_at: now,
      last_used_at: now,
      ...(lease.account_key ? { account_key: lease.account_key } : {}),
      ...(lease.surface_subject_id ? { surface_subject_id: lease.surface_subject_id } : {}),
    };
  }

  #mergeAllocatorSurface(current: BrowserSurface, allocated: BrowserSurface): BrowserSurface {
    return {
      ...current,
      ...allocated,
      surface_id: current.surface_id,
      backend: "neko",
      profile_key: current.profile_key,
      connector_id: current.connector_id,
      ...(current.account_key ? { account_key: current.account_key } : {}),
      ...(current.surface_subject_id ? { surface_subject_id: current.surface_subject_id } : {}),
      ...(current.active_lease_id ? { active_lease_id: current.active_lease_id } : {}),
    };
  }

  #terminalLease(
    lease: BrowserSurfaceLease,
    status: Extract<BrowserSurfaceLeaseStatus, "released" | "expired" | "deferred" | "cancelled" | "surface_failed">,
    waitReason?: BrowserSurfaceWaitReason,
  ): BrowserSurfaceLease {
    const now = this.#isoNow();
    return {
      ...lease,
      status,
      ...(status === "released" || status === "cancelled" ? { released_at: now } : {}),
      ...(waitReason ? { wait_reason: waitReason } : {}),
    };
  }

  #clearSurfaceLease(surfaceId: string, leaseId: string): BrowserSurface | undefined {
    const surface = this.#surfaces.get(surfaceId);
    if (!surface || surface.active_lease_id !== leaseId) {
      return surface;
    }
    const { active_lease_id: _activeLeaseId, ...idleSurface } = surface;
    const next = { ...idleSurface, last_used_at: this.#isoNow() };
    this.#surfaces.set(surfaceId, next);
    return next;
  }

  #findReadyIdleSurface(profileKey: string, surfaceSubjectId?: string): BrowserSurface | undefined {
    return [...this.#surfaces.values()].find(
      (surface) =>
        surface.backend === "neko" &&
        surface.health === "ready" &&
        !surface.active_lease_id &&
        surface.profile_key === profileKey &&
        surface.surface_subject_id === surfaceSubjectId,
    );
  }

  #isSurfaceCompatibleWithLease(surface: BrowserSurface, lease: BrowserSurfaceLease): boolean {
    return surface.profile_key === lease.profile_key && surface.surface_subject_id === lease.surface_subject_id;
  }

  #isCompatibleInitialSurface(surface: BrowserSurface): boolean {
    if (surface.backend !== "neko") {
      return false;
    }
    if (this.#config.surfaceMode === "static") {
      return surface.surface_id === "neko-static";
    }
    return surface.surface_id !== "neko-static";
  }

  #activeSurfaceCount(): number {
    return [...this.#surfaces.values()].filter((surface) => surface.backend === "neko" && surface.health !== "stopping").length;
  }

  #findNonTerminalRunLease(runId: string, surfaceSubjectId?: string, requireSubjectMatch = false): BrowserSurfaceLease | undefined {
    return [...this.#leases.values()].find(
      (lease) =>
        lease.run_id === runId &&
        (!requireSubjectMatch || lease.surface_subject_id === surfaceSubjectId) &&
        !isTerminalBrowserSurfaceLeaseStatus(lease.status),
    );
  }

  #findPendingDuplicate(request: AcquireBrowserSurfaceLeaseRequest): BrowserSurfaceLease | undefined {
    const profileKey = this.#profileKeyForRequest(request);
    return [...this.#leases.values()].find(
      (lease) =>
        !isTerminalBrowserSurfaceLeaseStatus(lease.status) &&
        lease.status !== "leased" &&
        lease.connector_id === request.connectorId &&
        lease.profile_key === profileKey &&
        lease.account_key === request.accountKey &&
        lease.surface_subject_id === request.surfaceSubjectId,
    );
  }

  #profileKeyForRequest(request: AcquireBrowserSurfaceLeaseRequest): string {
    return request.profileKey ?? (request.surfaceSubjectId ? `${request.connectorId}:${request.surfaceSubjectId}` : request.connectorId);
  }

  #surfaceForLease(lease: BrowserSurfaceLease): BrowserSurface | undefined {
    return lease.surface_id ? this.#surfaces.get(lease.surface_id) : undefined;
  }

  #comparePriorityFifo(a: BrowserSurfaceLease, b: BrowserSurfaceLease): number {
    const priority = this.#config.priorityRanks[a.priority_class] - this.#config.priorityRanks[b.priority_class];
    if (priority !== 0) {
      return priority;
    }
    const requested = Date.parse(a.requested_at) - Date.parse(b.requested_at);
    if (requested !== 0) {
      return requested;
    }
    return a.lease_id.localeCompare(b.lease_id);
  }

  #isoNow(): string {
    return this.#now().toISOString();
  }
}

function assertValidBrowserSurfaceLeaseConfig(config: BrowserSurfaceLeaseConfig): void {
  if (config.surfaceMode === "static") {
    if (config.surfaceCap !== 1) {
      throw new Error("static n.eko surface mode supports exactly one configured surface");
    }
    if (!config.staticProfileKey) {
      throw new Error("static n.eko surface mode requires staticProfileKey");
    }
    if (!config.staticCdpHttpUrl) {
      throw new Error("static n.eko surface mode requires staticCdpHttpUrl");
    }
    if (!config.staticStreamBaseUrl) {
      throw new Error("static n.eko surface mode requires staticStreamBaseUrl");
    }
  }
}
