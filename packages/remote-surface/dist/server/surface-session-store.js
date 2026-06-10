import { createStreamingSessionStore, } from "../reference/streaming-session-store.js";
function toSurfaceSessionRecord(session) {
    return {
        surfaceSessionId: session.run_id,
        actionId: session.interaction_id,
        browserSessionId: session.browser_session_id,
        tokenHash: session.token_hash,
        issuedAt: session.issued_at,
        expiresAt: session.expires_at,
        attachedAt: session.attached_at,
        invalidated: session.invalidated,
        invalidatedReason: session.invalidated_reason,
        viewport: session.viewport,
    };
}
export function createSurfaceSessionStore(options = {}) {
    const store = createStreamingSessionStore(options);
    return {
        mint(request = {}) {
            const result = store.mint({
                run_id: request.surfaceSessionId,
                interaction_id: request.actionId,
                browser_session_id: request.browserSessionId,
                viewport: request.viewport,
                ttlMs: request.ttlMs,
                idempotency_key: request.idempotencyKey,
            });
            return {
                token: result.token,
                session: toSurfaceSessionRecord(result.session),
                idempotencyReplayed: result.idempotency_replayed,
            };
        },
        attach(request) {
            return toSurfaceSessionRecord(store.attach({
                token: request.token,
                run_id: request.surfaceSessionId,
                interaction_id: request.actionId,
            }));
        },
        authorize(request) {
            return toSurfaceSessionRecord(store.authorize(request));
        },
        invalidate(request = {}) {
            const session = store.invalidate({
                run_id: request.surfaceSessionId,
                interaction_id: request.actionId,
                reason: request.reason,
            });
            return session ? toSurfaceSessionRecord(session) : null;
        },
        getSummary(request) {
            const session = store.getSummary({
                run_id: request.surfaceSessionId,
                interaction_id: request.actionId,
            });
            return session ? toSurfaceSessionRecord(session) : null;
        },
        size() {
            return store.size();
        },
    };
}
//# sourceMappingURL=surface-session-store.js.map