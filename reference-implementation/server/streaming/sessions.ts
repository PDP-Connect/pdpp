// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP compatibility adapter for the host-neutral remote-surface session store.
 *
 * The reference routes own a snake_case wire contract. Keep that shape at this
 * boundary while delegating the token/session lifecycle to the generic store.
 */
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
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
  attach: (request: AttachStreamingSessionRequest) => StreamingSessionRecord;
  authorize: (request: AuthorizeStreamingSessionRequest) => StreamingSessionRecord;
  getSummary: (request: GetStreamingSessionSummaryRequest) => StreamingSessionRecord | null;
  invalidate: (request?: InvalidateStreamingSessionRequest) => StreamingSessionRecord | null;
  mint: (request?: MintStreamingSessionRequest) => {
    token: string;
    session: StreamingSessionRecord;
    idempotency_replayed: boolean;
  };
  size: () => number;
}

function toStreamingSessionRecord(session: SurfaceSessionRecord): StreamingSessionRecord {
  return {
    attached_at: session.attachedAt,
    browser_session_id: session.browserSessionId,
    expires_at: session.expiresAt,
    interaction_id: session.actionId,
    invalidated: session.invalidated,
    invalidated_reason: session.invalidatedReason,
    issued_at: session.issuedAt,
    run_id: session.surfaceSessionId,
    token_hash: session.tokenHash,
    viewport: session.viewport,
  };
}

export function createStreamingSessionStore(options?: StreamingSessionStoreOptions): StreamingSessionStore {
  const store = createSurfaceSessionStore(options);

  return {
    attach(request) {
      return toStreamingSessionRecord(
        store.attach({
          actionId: request.interaction_id,
          surfaceSessionId: request.run_id,
          token: request.token,
        })
      );
    },
    authorize(request) {
      return toStreamingSessionRecord(store.authorize({ token: request.token }));
    },
    getSummary(request) {
      const session = store.getSummary({
        actionId: request.interaction_id,
        surfaceSessionId: request.run_id,
      });
      return session ? toStreamingSessionRecord(session) : null;
    },
    invalidate(request = {}) {
      const session = store.invalidate({
        actionId: request.interaction_id,
        reason: request.reason,
        surfaceSessionId: request.run_id,
      });
      return session ? toStreamingSessionRecord(session) : null;
    },
    mint(request = {}) {
      const result = store.mint({
        actionId: request.interaction_id,
        browserSessionId: request.browser_session_id,
        idempotencyKey: request.idempotency_key,
        surfaceSessionId: request.run_id,
        ttlMs: request.ttlMs,
        viewport: request.viewport,
      });
      return {
        idempotency_replayed: result.idempotencyReplayed,
        session: toStreamingSessionRecord(result.session),
        token: result.token,
      };
    },
    size() {
      return store.size();
    },
  };
}
