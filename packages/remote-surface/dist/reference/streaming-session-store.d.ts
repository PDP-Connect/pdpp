export declare const DEFAULT_STREAMING_SESSION_TTL_MS: number;
export declare const DEFAULT_MINT_IDEMPOTENCY_TTL_MS: number;
export declare const MAX_IDEMPOTENCY_KEY_LEN = 256;
export interface StreamingSessionRecord {
    run_id: string;
    interaction_id: string;
    browser_session_id: string;
    token_hash: string;
    issued_at: number;
    expires_at: number;
    attached_at: number | null;
    invalidated: boolean;
    invalidated_reason: string | null;
    viewport: unknown | null;
}
export interface StreamingSessionStoreOptions {
    now?: () => number;
    ttlMs?: number;
    mintIdempotencyTtlMs?: number;
}
export interface MintStreamingSessionRequest {
    run_id?: unknown;
    interaction_id?: unknown;
    browser_session_id?: unknown;
    viewport?: unknown;
    ttlMs?: unknown;
    idempotency_key?: unknown;
}
export interface MintStreamingSessionResult {
    token: string;
    session: StreamingSessionRecord;
    idempotency_replayed: boolean;
}
export interface AttachStreamingSessionRequest {
    token?: unknown;
    run_id?: unknown;
    interaction_id?: unknown;
}
export interface AuthorizeStreamingSessionRequest {
    token?: unknown;
}
export interface InvalidateStreamingSessionRequest {
    run_id?: unknown;
    interaction_id?: unknown;
    reason?: unknown;
}
export interface GetStreamingSessionSummaryRequest {
    run_id: string;
    interaction_id: string;
}
export interface StreamingSessionStore {
    mint(request?: MintStreamingSessionRequest): MintStreamingSessionResult;
    attach(request: AttachStreamingSessionRequest): StreamingSessionRecord;
    authorize(request: AuthorizeStreamingSessionRequest): StreamingSessionRecord;
    invalidate(request?: InvalidateStreamingSessionRequest): StreamingSessionRecord | null;
    getSummary(request: GetStreamingSessionSummaryRequest): StreamingSessionRecord | null;
    size(): number;
}
type StreamingSessionErrorCode = "invalid_token" | "session_invalidated" | "session_expired" | "wrong_run" | "wrong_interaction" | "session_inactive" | "session_not_attached";
export declare class StreamingSessionStoreError extends Error {
    code: StreamingSessionErrorCode;
    constructor(message: string, code: StreamingSessionErrorCode);
}
export declare function hashStreamingSessionToken(token: unknown): string;
export declare function createStreamingSessionStore({ now, ttlMs, mintIdempotencyTtlMs, }?: StreamingSessionStoreOptions): StreamingSessionStore;
export declare const __test__: {
    hashToken: typeof hashStreamingSessionToken;
};
export {};
//# sourceMappingURL=streaming-session-store.d.ts.map