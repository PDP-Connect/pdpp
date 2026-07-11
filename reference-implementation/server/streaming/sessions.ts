/**
 * PDPP compatibility adapter for the host-neutral remote-surface session store.
 *
 * The reference routes own a snake_case wire contract. Keep that shape at this
 * boundary while delegating the token/session lifecycle to the generic store.
 */
import { createSurfaceSessionStore, type SurfaceSessionRecord } from "@opendatalabs/remote-surface/server";

interface StreamingSessionRecord {
  attached_at: number | null;
  browser_session_id: string;
  expires_at: number;
  interaction_id: string;
  invalidated: boolean;
  invalidated_reason: string | null;
  issued_at: number;
  run_id: string;
  token_hash: string;
  viewport: unknown | null;
}

interface StreamingSessionStoreOptions {
  mintIdempotencyTtlMs?: number;
  now?: () => number;
  ttlMs?: number;
}

interface MintStreamingSessionRequest {
  browser_session_id?: unknown;
  idempotency_key?: unknown;
  interaction_id?: unknown;
  run_id?: unknown;
  ttlMs?: unknown;
  viewport?: unknown;
}

interface AttachStreamingSessionRequest {
  interaction_id?: unknown;
  run_id?: unknown;
  token?: unknown;
}

interface AuthorizeStreamingSessionRequest {
  token?: unknown;
}

interface InvalidateStreamingSessionRequest {
  interaction_id?: unknown;
  reason?: unknown;
  run_id?: unknown;
}

interface GetStreamingSessionSummaryRequest {
  interaction_id: string;
  run_id: string;
}

interface StreamingSessionStore {
  attach(request: AttachStreamingSessionRequest): StreamingSessionRecord;
  authorize(request: AuthorizeStreamingSessionRequest): StreamingSessionRecord;
  getSummary(request: GetStreamingSessionSummaryRequest): StreamingSessionRecord | null;
  invalidate(request?: InvalidateStreamingSessionRequest): StreamingSessionRecord | null;
  mint(request?: MintStreamingSessionRequest): {
    token: string;
    session: StreamingSessionRecord;
    idempotency_replayed: boolean;
  };
  size(): number;
}

function toStreamingSessionRecord(session: SurfaceSessionRecord): StreamingSessionRecord {
  return {
    run_id: session.surfaceSessionId,
    interaction_id: session.actionId,
    browser_session_id: session.browserSessionId,
    token_hash: session.tokenHash,
    issued_at: session.issuedAt,
    expires_at: session.expiresAt,
    attached_at: session.attachedAt,
    invalidated: session.invalidated,
    invalidated_reason: session.invalidatedReason,
    viewport: session.viewport,
  };
}

export function createStreamingSessionStore(options?: StreamingSessionStoreOptions): StreamingSessionStore {
  const store = createSurfaceSessionStore(options);

  return {
    mint(request = {}) {
      const result = store.mint({
        surfaceSessionId: request.run_id,
        actionId: request.interaction_id,
        browserSessionId: request.browser_session_id,
        viewport: request.viewport,
        ttlMs: request.ttlMs,
        idempotencyKey: request.idempotency_key,
      });
      return {
        token: result.token,
        session: toStreamingSessionRecord(result.session),
        idempotency_replayed: result.idempotencyReplayed,
      };
    },
    attach(request) {
      return toStreamingSessionRecord(
        store.attach({
          token: request.token,
          surfaceSessionId: request.run_id,
          actionId: request.interaction_id,
        })
      );
    },
    authorize(request) {
      return toStreamingSessionRecord(store.authorize({ token: request.token }));
    },
    invalidate(request = {}) {
      const session = store.invalidate({
        surfaceSessionId: request.run_id,
        actionId: request.interaction_id,
        reason: request.reason,
      });
      return session ? toStreamingSessionRecord(session) : null;
    },
    getSummary(request) {
      const session = store.getSummary({
        surfaceSessionId: request.run_id,
        actionId: request.interaction_id,
      });
      return session ? toStreamingSessionRecord(session) : null;
    },
    size() {
      return store.size();
    },
  };
}
