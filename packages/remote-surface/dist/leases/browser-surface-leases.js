export const BROWSER_SURFACE_BACKEND_NEKO = "neko";
export const BROWSER_SURFACE_LEASE_STATUSES = [
    "waiting_for_browser_surface",
    "starting_surface",
    "leased",
    "released",
    "expired",
    "deferred",
    "cancelled",
    "surface_failed",
];
export const BROWSER_SURFACE_WAIT_REASONS = [
    "capacity_full",
    "surface_starting",
    "surface_unhealthy",
    "surface_start_failed",
    "surface_readiness_timeout",
    "incompatible_static_profile",
    "launch_precondition_failed",
    "lease_wait_timeout",
];
export const BROWSER_SURFACE_PRIORITY_CLASSES = ["owner_interactive", "scheduled_refresh"];
export const TERMINAL_BROWSER_SURFACE_LEASE_STATUSES = [
    "released",
    "expired",
    "deferred",
    "cancelled",
    "surface_failed",
];
export const DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_NEKO_IDLE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_NEKO_PRIORITY_CLASS = "scheduled_refresh";
export const DEFAULT_NEKO_PRIORITY_RANKS = {
    owner_interactive: 0,
    scheduled_refresh: 1,
};
const TERMINAL_STATUS_SET = new Set(TERMINAL_BROWSER_SURFACE_LEASE_STATUSES);
export function isTerminalBrowserSurfaceLeaseStatus(status) {
    return TERMINAL_STATUS_SET.has(status);
}
export function projectBrowserSurfaceLease(lease) {
    return {
        pending_run_id: lease.run_id,
        browser_surface_status: lease.status,
        browser_surface_lease_id: lease.lease_id,
        browser_surface_profile_key: lease.profile_key,
        ...(lease.wait_reason ? { browser_surface_wait_reason: lease.wait_reason } : {}),
    };
}
export class BrowserSurfaceLeaseManager {
    #config;
    #now;
    #makeLeaseId;
    #makeSurfaceId;
    #nextFencingToken;
    #releasePromotesNext;
    #leases = new Map();
    #surfaces = new Map();
    constructor(options) {
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
        for (const surface of options.initialSurfaces ?? []) {
            if (this.#isCompatibleInitialSurface(surface)) {
                this.#surfaces.set(surface.surface_id, surface);
            }
        }
        for (const lease of options.initialLeases ?? []) {
            if (lease.surface_id && !this.#surfaces.has(lease.surface_id)) {
                continue;
            }
            this.#leases.set(lease.lease_id, lease);
        }
    }
    get config() {
        return this.#config;
    }
    listLeases() {
        return [...this.#leases.values()];
    }
    listSurfaces() {
        return [...this.#surfaces.values()];
    }
    getLease(leaseId) {
        return this.#leases.get(leaseId);
    }
    getSurface(surfaceId) {
        return this.#surfaces.get(surfaceId);
    }
    isManagedConnector(connectorId) {
        return this.#config.managedConnectors.has(connectorId);
    }
    acquire(request) {
        const duplicate = this.#findNonTerminalRunLease(request.runId) ?? this.#findPendingDuplicate(request);
        if (duplicate) {
            const surface = this.#surfaceForLease(duplicate);
            return { lease: duplicate, duplicateOf: duplicate, ...(surface ? { surface } : {}) };
        }
        const now = this.#isoNow();
        const profileKey = request.profileKey ?? request.connectorId;
        const baseLease = {
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
        };
        const lease = this.#resolveNewLease(baseLease, now);
        this.#leases.set(lease.lease_id, lease);
        const surface = this.#surfaceForLease(lease);
        return { lease, ...(surface ? { surface } : {}) };
    }
    cancel(runId) {
        return this.cancelAndPump(runId).lease;
    }
    cancelAndPump(runId) {
        const lease = this.#findNonTerminalRunLease(runId);
        if (!lease) {
            return { stale: true };
        }
        const cancelled = this.#terminalLease(lease, "cancelled");
        this.#leases.set(cancelled.lease_id, cancelled);
        let surface;
        let promoted;
        if (lease.surface_id) {
            surface = this.#clearSurfaceLease(lease.surface_id, lease.lease_id);
            promoted = this.#pumpQueue(surface?.surface_id);
        }
        return { stale: false, lease: cancelled, ...(surface ? { surface } : {}), ...(promoted ? { promoted } : {}) };
    }
    expireWaitingLeases() {
        const nowMs = this.#now().getTime();
        const expired = [];
        for (const lease of this.#leases.values()) {
            if (lease.status === "waiting_for_browser_surface" && Date.parse(lease.expires_at) <= nowMs) {
                const deferred = this.#terminalLease(lease, "deferred", "lease_wait_timeout");
                this.#leases.set(deferred.lease_id, deferred);
                expired.push(deferred);
            }
        }
        return expired;
    }
    release(request) {
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
    async ensureStartingSurfaceReady(request) {
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
            const unhealthy = { ...surface, health: "unhealthy", last_used_at: this.#isoNow() };
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
            });
            const status = await request.allocator.getSurfaceStatus(surface.surface_id);
            if (!status) {
                const failedSurface = { ...surface, health: "unhealthy", last_used_at: this.#isoNow() };
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
        }
        catch {
            const failedSurface = { ...surface, health: "unhealthy", last_used_at: this.#isoNow() };
            this.#surfaces.set(surface.surface_id, failedSurface);
            const failed = this.#terminalLease(lease, "surface_failed", "surface_start_failed");
            this.#leases.set(failed.lease_id, failed);
            return { lease: failed, surface: failedSurface };
        }
    }
    deferTimedOutLease(leaseId) {
        const lease = this.#leases.get(leaseId);
        if (!lease || isTerminalBrowserSurfaceLeaseStatus(lease.status)) {
            return lease;
        }
        const deferred = this.#terminalLease(lease, "deferred", "lease_wait_timeout");
        this.#leases.set(deferred.lease_id, deferred);
        return deferred;
    }
    deferLeasedRun(request, waitReason = "launch_precondition_failed") {
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
    reconcileAfterRestart(request = {}) {
        const activeRunIds = request.activeRunIds ?? new Set();
        const result = {
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
                }
                else if (reconciled.status === "deferred") {
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
    pumpQueuedLeases() {
        const promoted = [];
        while (true) {
            const lease = this.#pumpQueue();
            if (!lease) {
                break;
            }
            promoted.push(lease);
        }
        return promoted;
    }
    async cleanupIdleSurfaces(allocator) {
        if (this.#config.surfaceMode !== "dynamic") {
            return { stopped: [], promoted: [] };
        }
        const nowMs = this.#now().getTime();
        const expiredIdle = [...this.#surfaces.values()].filter((surface) => surface.backend === "neko" &&
            surface.health === "ready" &&
            !surface.active_lease_id &&
            nowMs - Date.parse(surface.last_used_at) >= this.#config.idleTtlMs);
        const stopped = [];
        for (const surface of expiredIdle) {
            const stopping = { ...surface, health: "stopping", last_used_at: this.#isoNow() };
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
            });
        }
        return { stopped, promoted: this.pumpQueuedLeases() };
    }
    planCapacityPressureReclaim(leaseId) {
        const lease = this.#leases.get(leaseId);
        if (this.#config.surfaceMode !== "dynamic" ||
            !lease ||
            lease.status !== "waiting_for_browser_surface" ||
            lease.wait_reason !== "capacity_full" ||
            this.#findReadyIdleSurface(lease.profile_key) ||
            this.#activeSurfaceCount() < this.#config.surfaceCap) {
            return undefined;
        }
        return [...this.#surfaces.values()]
            .filter((surface) => surface.backend === "neko" &&
            surface.health === "ready" &&
            !surface.active_lease_id &&
            surface.profile_key !== lease.profile_key)
            .sort((a, b) => Date.parse(a.last_used_at) - Date.parse(b.last_used_at))[0];
    }
    completeCapacityPressureReclaim(surfaceId) {
        const surface = this.#surfaces.get(surfaceId);
        if (!surface || surface.health !== "ready" || surface.active_lease_id) {
            return {};
        }
        const stopping = { ...surface, health: "stopping", last_used_at: this.#isoNow() };
        this.#surfaces.set(surfaceId, stopping);
        const promoted = this.#pumpQueue();
        return { stopped: stopping, ...(promoted ? { promoted } : {}) };
    }
    #resolveNewLease(lease, now) {
        if (this.#config.surfaceMode === "static" && this.#config.staticProfileKey && lease.profile_key !== this.#config.staticProfileKey) {
            return { ...lease, status: "deferred", wait_reason: "incompatible_static_profile" };
        }
        const idle = this.#findReadyIdleSurface(lease.profile_key);
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
    #reconcileWaitingLease(lease) {
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
    #pumpQueue(preferredSurfaceId) {
        this.expireWaitingLeasesWithoutPump();
        const waiting = [...this.#leases.values()]
            .filter((lease) => lease.status === "waiting_for_browser_surface")
            .sort((a, b) => this.#comparePriorityFifo(a, b));
        for (const lease of waiting) {
            const surface = preferredSurfaceId ? this.#surfaces.get(preferredSurfaceId) : this.#findReadyIdleSurface(lease.profile_key);
            const compatibleSurface = surface?.health === "ready" && !surface.active_lease_id && surface.profile_key === lease.profile_key ? surface : this.#findReadyIdleSurface(lease.profile_key);
            const promoted = compatibleSurface ? this.#leaseSurface(lease, compatibleSurface, this.#isoNow()) : this.#promoteWaitingLeaseToStarting(lease);
            if (!promoted) {
                continue;
            }
            this.#leases.set(promoted.lease_id, promoted);
            return promoted;
        }
        return undefined;
    }
    expireWaitingLeasesWithoutPump() {
        const nowMs = this.#now().getTime();
        for (const lease of this.#leases.values()) {
            if (lease.status === "waiting_for_browser_surface" && Date.parse(lease.expires_at) <= nowMs) {
                this.#leases.set(lease.lease_id, this.#terminalLease(lease, "deferred", "lease_wait_timeout"));
            }
        }
    }
    #leaseSurface(lease, surface, now) {
        const { wait_reason: _waitReason, ...leaseWithoutWaitReason } = lease;
        const leased = {
            ...leaseWithoutWaitReason,
            status: "leased",
            leased_at: now,
            surface_id: surface.surface_id,
            fencing_token: this.#nextFencingToken(),
        };
        this.#surfaces.set(surface.surface_id, { ...surface, active_lease_id: leased.lease_id, last_used_at: now });
        return leased;
    }
    #promoteWaitingLeaseToStarting(lease) {
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
    #createSurfaceForLease(lease, now) {
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
        };
    }
    #mergeAllocatorSurface(current, allocated) {
        return {
            ...current,
            ...allocated,
            surface_id: current.surface_id,
            backend: "neko",
            profile_key: current.profile_key,
            connector_id: current.connector_id,
            ...(current.account_key ? { account_key: current.account_key } : {}),
            ...(current.active_lease_id ? { active_lease_id: current.active_lease_id } : {}),
        };
    }
    #terminalLease(lease, status, waitReason) {
        const now = this.#isoNow();
        return {
            ...lease,
            status,
            ...(status === "released" || status === "cancelled" ? { released_at: now } : {}),
            ...(waitReason ? { wait_reason: waitReason } : {}),
        };
    }
    #clearSurfaceLease(surfaceId, leaseId) {
        const surface = this.#surfaces.get(surfaceId);
        if (!surface || surface.active_lease_id !== leaseId) {
            return surface;
        }
        const { active_lease_id: _activeLeaseId, ...idleSurface } = surface;
        const next = { ...idleSurface, last_used_at: this.#isoNow() };
        this.#surfaces.set(surfaceId, next);
        return next;
    }
    #findReadyIdleSurface(profileKey) {
        return [...this.#surfaces.values()].find((surface) => surface.backend === "neko" && surface.health === "ready" && !surface.active_lease_id && surface.profile_key === profileKey);
    }
    #isCompatibleInitialSurface(surface) {
        if (surface.backend !== "neko") {
            return false;
        }
        if (this.#config.surfaceMode === "static") {
            return surface.surface_id === "neko-static";
        }
        return surface.surface_id !== "neko-static";
    }
    #activeSurfaceCount() {
        return [...this.#surfaces.values()].filter((surface) => surface.backend === "neko" && surface.health !== "stopping").length;
    }
    #findNonTerminalRunLease(runId) {
        return [...this.#leases.values()].find((lease) => lease.run_id === runId && !isTerminalBrowserSurfaceLeaseStatus(lease.status));
    }
    #findPendingDuplicate(request) {
        const profileKey = request.profileKey ?? request.connectorId;
        return [...this.#leases.values()].find((lease) => !isTerminalBrowserSurfaceLeaseStatus(lease.status) &&
            lease.status !== "leased" &&
            lease.connector_id === request.connectorId &&
            lease.profile_key === profileKey &&
            lease.account_key === request.accountKey);
    }
    #surfaceForLease(lease) {
        return lease.surface_id ? this.#surfaces.get(lease.surface_id) : undefined;
    }
    #comparePriorityFifo(a, b) {
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
    #isoNow() {
        return this.#now().toISOString();
    }
}
function assertValidBrowserSurfaceLeaseConfig(config) {
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
//# sourceMappingURL=browser-surface-leases.js.map