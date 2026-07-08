import { createHash, randomBytes } from "node:crypto";
export const DEFAULT_STREAMING_SESSION_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MINT_IDEMPOTENCY_TTL_MS = 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_LEN = 256;
export class StreamingSessionStoreError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = "StreamingSessionStoreError";
        this.code = code;
    }
}
export function hashStreamingSessionToken(token) {
    return createHash("sha256").update(String(token), "utf8").digest("hex");
}
function newToken() {
    return randomBytes(32).toString("hex");
}
function cloneSession(session) {
    return { ...session };
}
export function createStreamingSessionStore({ now = () => Date.now(), ttlMs = DEFAULT_STREAMING_SESSION_TTL_MS, mintIdempotencyTtlMs = DEFAULT_MINT_IDEMPOTENCY_TTL_MS, } = {}) {
    const byHash = new Map();
    const byInteraction = new Map();
    const idempotencyCache = new Map();
    function interactionKey(runId, interactionId) {
        return `${String(runId)}\0${String(interactionId)}`;
    }
    function idempotencyCacheKey(runId, interactionId, idempotencyKey) {
        return `${runId}\0${interactionId}\0${idempotencyKey}`;
    }
    function purgeExpiredIdempotencyEntries() {
        const t = now();
        for (const [key, entry] of idempotencyCache) {
            if (entry.expires_at <= t) {
                idempotencyCache.delete(key);
            }
        }
    }
    function purgeExpired() {
        const t = now();
        for (const [hash, session] of byHash) {
            if (session.expires_at <= t || session.invalidated) {
                byHash.delete(hash);
                const key = interactionKey(session.run_id, session.interaction_id);
                if (byInteraction.get(key) === hash) {
                    byInteraction.delete(key);
                }
            }
        }
        purgeExpiredIdempotencyEntries();
    }
    function mint({ run_id, interaction_id, browser_session_id, viewport, ttlMs: requestedTtl, idempotency_key, } = {}) {
        if (typeof run_id !== "string" || !run_id) {
            throw new Error("mint requires run_id");
        }
        if (typeof interaction_id !== "string" || !interaction_id) {
            throw new Error("mint requires interaction_id");
        }
        if (typeof browser_session_id !== "string" || !browser_session_id) {
            throw new Error("mint requires browser_session_id");
        }
        purgeExpired();
        const idempotencyKey = typeof idempotency_key === "string" && idempotency_key.length > 0
            ? idempotency_key.slice(0, MAX_IDEMPOTENCY_KEY_LEN)
            : null;
        if (idempotencyKey) {
            const cacheKey = idempotencyCacheKey(run_id, interaction_id, idempotencyKey);
            const cached = idempotencyCache.get(cacheKey);
            if (cached) {
                const liveHash = byInteraction.get(interactionKey(run_id, interaction_id));
                const liveSession = liveHash ? byHash.get(liveHash) : null;
                if (liveSession &&
                    liveHash === cached.token_hash &&
                    !liveSession.invalidated &&
                    liveSession.expires_at > now()) {
                    return {
                        token: cached.token,
                        session: cloneSession(liveSession),
                        idempotency_replayed: true,
                    };
                }
                idempotencyCache.delete(cacheKey);
            }
        }
        const key = interactionKey(run_id, interaction_id);
        const priorHash = byInteraction.get(key);
        if (priorHash) {
            const prior = byHash.get(priorHash);
            if (prior) {
                prior.invalidated = true;
                prior.invalidated_reason = "superseded";
            }
            byHash.delete(priorHash);
            byInteraction.delete(key);
        }
        const token = newToken();
        const tokenHash = hashStreamingSessionToken(token);
        const ttl = Number.isFinite(requestedTtl) && Number(requestedTtl) > 0 ? Number(requestedTtl) : ttlMs;
        const issuedAt = now();
        const session = {
            run_id,
            interaction_id,
            browser_session_id,
            token_hash: tokenHash,
            issued_at: issuedAt,
            expires_at: now() + ttl,
            attached_at: null,
            invalidated: false,
            invalidated_reason: null,
            viewport: viewport || null,
        };
        byHash.set(tokenHash, session);
        byInteraction.set(key, tokenHash);
        if (idempotencyKey) {
            idempotencyCache.set(idempotencyCacheKey(run_id, interaction_id, idempotencyKey), {
                token,
                token_hash: tokenHash,
                expires_at: now() + mintIdempotencyTtlMs,
            });
        }
        return { token, session: cloneSession(session), idempotency_replayed: false };
    }
    function getSummary({ run_id, interaction_id }) {
        purgeExpired();
        const hash = byInteraction.get(interactionKey(run_id, interaction_id));
        if (!hash) {
            return null;
        }
        const session = byHash.get(hash);
        return session ? cloneSession(session) : null;
    }
    function attach({ token, run_id, interaction_id }) {
        purgeExpired();
        if (typeof token !== "string" || !token) {
            throw new StreamingSessionStoreError("Streaming token is required", "invalid_token");
        }
        const hash = hashStreamingSessionToken(token);
        const session = byHash.get(hash);
        if (!session) {
            throw new StreamingSessionStoreError("Streaming session not found", "invalid_token");
        }
        if (session.invalidated) {
            throw new StreamingSessionStoreError(`Streaming session invalidated (${session.invalidated_reason || "unknown"})`, "session_invalidated");
        }
        if (session.expires_at <= now()) {
            session.invalidated = true;
            session.invalidated_reason = "expired";
            throw new StreamingSessionStoreError("Streaming session expired", "session_expired");
        }
        if (typeof run_id === "string" && run_id && run_id !== session.run_id) {
            throw new StreamingSessionStoreError("Streaming token does not match this run", "wrong_run");
        }
        if (typeof interaction_id === "string" && interaction_id && interaction_id !== session.interaction_id) {
            throw new StreamingSessionStoreError("Streaming token does not match this interaction", "wrong_interaction");
        }
        if (session.attached_at === null) {
            session.attached_at = now();
        }
        return cloneSession(session);
    }
    function authorize({ token }) {
        purgeExpired();
        if (typeof token !== "string" || !token) {
            throw new StreamingSessionStoreError("Streaming token is required", "invalid_token");
        }
        const hash = hashStreamingSessionToken(token);
        const session = byHash.get(hash);
        if (!session || session.invalidated || session.expires_at <= now()) {
            throw new StreamingSessionStoreError("Streaming session not active", "session_inactive");
        }
        if (session.attached_at === null) {
            throw new StreamingSessionStoreError("Streaming session not attached yet", "session_not_attached");
        }
        return cloneSession(session);
    }
    function invalidate({ run_id, interaction_id, reason, } = {}) {
        purgeExpired();
        const key = interactionKey(run_id, interaction_id);
        const hash = byInteraction.get(key);
        if (!hash) {
            return null;
        }
        const session = byHash.get(hash);
        if (!session) {
            return null;
        }
        session.invalidated = true;
        session.invalidated_reason = typeof reason === "string" && reason ? reason : "invalidated";
        byHash.delete(hash);
        byInteraction.delete(key);
        return cloneSession(session);
    }
    function size() {
        return byHash.size;
    }
    return {
        mint,
        attach,
        authorize,
        invalidate,
        getSummary,
        size,
    };
}
export const __test__ = { hashToken: hashStreamingSessionToken };
//# sourceMappingURL=token-session-store.js.map