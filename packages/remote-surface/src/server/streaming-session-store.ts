import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_STREAMING_SESSION_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MINT_IDEMPOTENCY_TTL_MS = 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_LEN = 256;

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

interface IdempotencyEntry {
  token: string;
  token_hash: string;
  expires_at: number;
}

type StreamingSessionErrorCode =
  | "invalid_token"
  | "session_invalidated"
  | "session_expired"
  | "wrong_run"
  | "wrong_interaction"
  | "session_inactive"
  | "session_not_attached";

export class StreamingSessionStoreError extends Error {
  code: StreamingSessionErrorCode;

  constructor(message: string, code: StreamingSessionErrorCode) {
    super(message);
    this.name = "StreamingSessionStoreError";
    this.code = code;
  }
}

export function hashStreamingSessionToken(token: unknown): string {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function cloneSession(session: StreamingSessionRecord): StreamingSessionRecord {
  return { ...session };
}

export function createStreamingSessionStore({
  now = () => Date.now(),
  ttlMs = DEFAULT_STREAMING_SESSION_TTL_MS,
  mintIdempotencyTtlMs = DEFAULT_MINT_IDEMPOTENCY_TTL_MS,
}: StreamingSessionStoreOptions = {}): StreamingSessionStore {
  const byHash = new Map<string, StreamingSessionRecord>();
  const byInteraction = new Map<string, string>();
  const idempotencyCache = new Map<string, IdempotencyEntry>();

  function interactionKey(runId: unknown, interactionId: unknown): string {
    return `${String(runId)}\0${String(interactionId)}`;
  }

  function idempotencyCacheKey(runId: string, interactionId: string, idempotencyKey: string): string {
    return `${runId}\0${interactionId}\0${idempotencyKey}`;
  }

  function purgeExpiredIdempotencyEntries(): void {
    const t = now();
    for (const [key, entry] of idempotencyCache) {
      if (entry.expires_at <= t) {
        idempotencyCache.delete(key);
      }
    }
  }

  function purgeExpired(): void {
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

  function mint({
    run_id,
    interaction_id,
    browser_session_id,
    viewport,
    ttlMs: requestedTtl,
    idempotency_key,
  }: MintStreamingSessionRequest = {}): MintStreamingSessionResult {
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

    const idempotencyKey =
      typeof idempotency_key === "string" && idempotency_key.length > 0
        ? idempotency_key.slice(0, MAX_IDEMPOTENCY_KEY_LEN)
        : null;
    if (idempotencyKey) {
      const cacheKey = idempotencyCacheKey(run_id, interaction_id, idempotencyKey);
      const cached = idempotencyCache.get(cacheKey);
      if (cached) {
        const liveHash = byInteraction.get(interactionKey(run_id, interaction_id));
        const liveSession = liveHash ? byHash.get(liveHash) : null;
        if (
          liveSession &&
          liveHash === cached.token_hash &&
          !liveSession.invalidated &&
          liveSession.expires_at > now()
        ) {
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
    const session: StreamingSessionRecord = {
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

  function getSummary({ run_id, interaction_id }: GetStreamingSessionSummaryRequest): StreamingSessionRecord | null {
    purgeExpired();
    const hash = byInteraction.get(interactionKey(run_id, interaction_id));
    if (!hash) {
      return null;
    }
    const session = byHash.get(hash);
    return session ? cloneSession(session) : null;
  }

  function attach({ token, run_id, interaction_id }: AttachStreamingSessionRequest): StreamingSessionRecord {
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
      throw new StreamingSessionStoreError(
        `Streaming session invalidated (${session.invalidated_reason || "unknown"})`,
        "session_invalidated",
      );
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
      throw new StreamingSessionStoreError(
        "Streaming token does not match this interaction",
        "wrong_interaction",
      );
    }
    if (session.attached_at === null) {
      session.attached_at = now();
    }
    return cloneSession(session);
  }

  function authorize({ token }: AuthorizeStreamingSessionRequest): StreamingSessionRecord {
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

  function invalidate({
    run_id,
    interaction_id,
    reason,
  }: InvalidateStreamingSessionRequest = {}): StreamingSessionRecord | null {
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

  function size(): number {
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

export function toSurfaceSessionRecord(session: StreamingSessionRecord): SurfaceSessionRecord {
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

export function createSurfaceSessionStore(options: StreamingSessionStoreOptions = {}): SurfaceSessionStore {
  const store = createStreamingSessionStore(options);

  return {
    mint(request: MintSurfaceSessionRequest = {}): MintSurfaceSessionResult {
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
    attach(request: AttachSurfaceSessionRequest): SurfaceSessionRecord {
      return toSurfaceSessionRecord(
        store.attach({
          token: request.token,
          run_id: request.surfaceSessionId,
          interaction_id: request.actionId,
        }),
      );
    },
    authorize(request: AuthorizeSurfaceSessionRequest): SurfaceSessionRecord {
      return toSurfaceSessionRecord(store.authorize(request));
    },
    invalidate(request: InvalidateSurfaceSessionRequest = {}): SurfaceSessionRecord | null {
      const session = store.invalidate({
        run_id: request.surfaceSessionId,
        interaction_id: request.actionId,
        reason: request.reason,
      });
      return session ? toSurfaceSessionRecord(session) : null;
    },
    getSummary(request: GetSurfaceSessionSummaryRequest): SurfaceSessionRecord | null {
      const session = store.getSummary({
        run_id: request.surfaceSessionId,
        interaction_id: request.actionId,
      });
      return session ? toSurfaceSessionRecord(session) : null;
    },
    size(): number {
      return store.size();
    },
  };
}

export const __test__ = { hashToken: hashStreamingSessionToken };
