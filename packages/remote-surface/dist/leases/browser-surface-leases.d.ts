export declare const BROWSER_SURFACE_BACKEND_NEKO: "neko";
export declare const BROWSER_SURFACE_LEASE_STATUSES: readonly ["waiting_for_browser_surface", "starting_surface", "leased", "released", "expired", "deferred", "cancelled", "surface_failed"];
export declare const BROWSER_SURFACE_WAIT_REASONS: readonly ["capacity_full", "surface_starting", "surface_unhealthy", "surface_start_failed", "surface_readiness_timeout", "incompatible_static_profile", "launch_precondition_failed", "lease_wait_timeout"];
export declare const BROWSER_SURFACE_PRIORITY_CLASSES: readonly ["owner_interactive", "scheduled_refresh"];
export declare const TERMINAL_BROWSER_SURFACE_LEASE_STATUSES: readonly ["released", "expired", "deferred", "cancelled", "surface_failed"];
export declare const DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS: number;
export declare const DEFAULT_NEKO_IDLE_TTL_MS: number;
export declare const DEFAULT_NEKO_PRIORITY_CLASS: BrowserSurfacePriorityClass;
export declare const DEFAULT_NEKO_PRIORITY_RANKS: Readonly<Record<BrowserSurfacePriorityClass, number>>;
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
    readonly priorityClass?: BrowserSurfacePriorityClass;
}
export interface AcquireSurfaceLeaseRequest {
    readonly connectorId: string;
    readonly sessionId: string;
    readonly profileKey?: string;
    readonly accountKey?: string;
    readonly priorityClass?: BrowserSurfacePriorityClass;
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
export declare function isTerminalBrowserSurfaceLeaseStatus(status: BrowserSurfaceLeaseStatus): boolean;
export declare function projectBrowserSurfaceLease(lease: BrowserSurfaceLease): BrowserSurfaceProjection;
export interface SurfaceLeaseProjection {
    readonly surface_session_id: string;
    readonly surface_lease_status: BrowserSurfaceLeaseStatus;
    readonly surface_lease_id: string;
    readonly surface_profile_key: string;
    readonly surface_wait_reason?: BrowserSurfaceWaitReason;
}
export declare function projectSurfaceLease(lease: BrowserSurfaceLease): SurfaceLeaseProjection;
export declare class BrowserSurfaceLeaseManager {
    #private;
    constructor(options: BrowserSurfaceLeaseManagerOptions);
    get config(): BrowserSurfaceLeaseConfig;
    listLeases(): BrowserSurfaceLease[];
    listSurfaces(): BrowserSurface[];
    getLease(leaseId: string): BrowserSurfaceLease | undefined;
    getSurface(surfaceId: string): BrowserSurface | undefined;
    isManagedConnector(connectorId: string): boolean;
    acquire(request: AcquireBrowserSurfaceLeaseRequest): BrowserSurfaceLeaseResult;
    acquireSurfaceLease(request: AcquireSurfaceLeaseRequest): BrowserSurfaceLeaseResult;
    cancel(runId: string): BrowserSurfaceLease | undefined;
    cancelAndPump(runId: string): TerminalBrowserSurfaceLeaseResult;
    cancelSurfaceSession(sessionId: string): BrowserSurfaceLease | undefined;
    cancelSurfaceSessionAndPump(sessionId: string): TerminalBrowserSurfaceLeaseResult;
    expireWaitingLeases(): BrowserSurfaceLease[];
    release(request: ReleaseBrowserSurfaceLeaseRequest): ReleaseBrowserSurfaceLeaseResult;
    ensureStartingSurfaceReady(request: EnsureStartingBrowserSurfaceRequest): Promise<BrowserSurfaceLeaseResult>;
    deferTimedOutLease(leaseId: string): BrowserSurfaceLease | undefined;
    deferLeasedRun(request: ReleaseBrowserSurfaceLeaseRequest, waitReason?: BrowserSurfaceWaitReason): TerminalBrowserSurfaceLeaseResult;
    reconcileAfterRestart(request?: ReconcileBrowserSurfaceLeasesAfterRestartRequest): ReconcileBrowserSurfaceLeasesAfterRestartResult;
    reconcileSurfaceSessionsAfterRestart(request?: ReconcileSurfaceLeasesAfterRestartRequest): ReconcileBrowserSurfaceLeasesAfterRestartResult;
    pumpQueuedLeases(): BrowserSurfaceLease[];
    cleanupIdleSurfaces(allocator: BrowserSurfaceAllocator): Promise<CleanupIdleBrowserSurfacesResult>;
    planCapacityPressureReclaim(leaseId: string): BrowserSurface | undefined;
    completeCapacityPressureReclaim(surfaceId: string): CompleteBrowserSurfaceCapacityReclaimResult;
    private expireWaitingLeasesWithoutPump;
}
//# sourceMappingURL=browser-surface-leases.d.ts.map