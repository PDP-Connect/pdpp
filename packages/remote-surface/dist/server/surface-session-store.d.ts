import { type StreamingSessionStoreOptions } from "../sessions/token-session-store.ts";
export interface SurfaceSessionRecord {
    surfaceSessionId: string;
    actionId: string;
    browserSessionId: string;
    tokenHash: string;
    issuedAt: number;
    expiresAt: number;
    attachedAt: number | null;
    invalidated: boolean;
    invalidatedReason: string | null;
    viewport: unknown | null;
}
export interface MintSurfaceSessionRequest {
    surfaceSessionId?: unknown;
    actionId?: unknown;
    browserSessionId?: unknown;
    viewport?: unknown;
    ttlMs?: unknown;
    idempotencyKey?: unknown;
}
export interface MintSurfaceSessionResult {
    token: string;
    session: SurfaceSessionRecord;
    idempotencyReplayed: boolean;
}
export interface AttachSurfaceSessionRequest {
    token?: unknown;
    surfaceSessionId?: unknown;
    actionId?: unknown;
}
export interface AuthorizeSurfaceSessionRequest {
    token?: unknown;
}
export interface InvalidateSurfaceSessionRequest {
    surfaceSessionId?: unknown;
    actionId?: unknown;
    reason?: unknown;
}
export interface GetSurfaceSessionSummaryRequest {
    surfaceSessionId: string;
    actionId: string;
}
export interface SurfaceSessionStore {
    mint(request?: MintSurfaceSessionRequest): MintSurfaceSessionResult;
    attach(request: AttachSurfaceSessionRequest): SurfaceSessionRecord;
    authorize(request: AuthorizeSurfaceSessionRequest): SurfaceSessionRecord;
    invalidate(request?: InvalidateSurfaceSessionRequest): SurfaceSessionRecord | null;
    getSummary(request: GetSurfaceSessionSummaryRequest): SurfaceSessionRecord | null;
    size(): number;
}
export declare function createSurfaceSessionStore(options?: StreamingSessionStoreOptions): SurfaceSessionStore;
//# sourceMappingURL=surface-session-store.d.ts.map