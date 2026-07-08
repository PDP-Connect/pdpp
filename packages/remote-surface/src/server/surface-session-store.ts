import {
  createStreamingSessionStore,
  type StreamingSessionRecord,
  type StreamingSessionStoreOptions,
} from "../sessions/token-session-store.ts";

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

function toSurfaceSessionRecord(session: StreamingSessionRecord): SurfaceSessionRecord {
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
