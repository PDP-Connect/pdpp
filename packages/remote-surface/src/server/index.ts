import type {
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceDiagnosticsPayload,
  RemoteSurfaceEventPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceRevocationReason,
  RemoteSurfaceSessionDescriptor,
  RemoteSurfaceSessionId,
  RemoteSurfaceTargetDescriptor,
  RemoteSurfaceTokenDescriptor,
  RemoteSurfaceTokenId,
  RemoteSurfaceViewportPayload,
} from "../protocol/index.ts";

export {
  __test__,
  createStreamingSessionStore,
  DEFAULT_MINT_IDEMPOTENCY_TTL_MS,
  DEFAULT_STREAMING_SESSION_TTL_MS,
  hashStreamingSessionToken,
  MAX_IDEMPOTENCY_KEY_LEN,
  StreamingSessionStoreError,
} from "./streaming-session-store.ts";
export type {
  AttachStreamingSessionRequest,
  AuthorizeStreamingSessionRequest,
  GetStreamingSessionSummaryRequest,
  InvalidateStreamingSessionRequest,
  MintStreamingSessionRequest,
  MintStreamingSessionResult,
  StreamingSessionRecord,
  StreamingSessionStore,
  StreamingSessionStoreOptions,
} from "./streaming-session-store.ts";

export interface RemoteSurfaceSessionBroker {
  createSession(request: RemoteSurfaceCreateSessionRequest): Promise<RemoteSurfaceCreateSessionResult>;
  registerTarget(
    session: RemoteSurfaceSessionRef,
    target: RemoteSurfaceTargetDescriptor,
  ): Promise<RemoteSurfaceSessionDescriptor>;
  attachSession(handle: RemoteSurfaceSessionHandle): Promise<RemoteSurfaceAttachSessionResult>;
  authorizeSession(
    handle: RemoteSurfaceSessionHandle,
    scope: RemoteSurfaceAuthorizationScope,
  ): Promise<RemoteSurfaceSessionDescriptor>;
  revokeSession(
    session: RemoteSurfaceSessionRef,
    reason: RemoteSurfaceRevocationReason,
  ): Promise<RemoteSurfaceSessionDescriptor | null>;
  openEventChannel(
    session: RemoteSurfaceSessionRef,
    sink: RemoteSurfaceEventSink,
  ): Promise<RemoteSurfaceChannelSubscription>;
  dispatchInput(session: RemoteSurfaceSessionRef, payload: RemoteSurfaceInputPayload): Promise<void>;
  reportViewport(session: RemoteSurfaceSessionRef, payload: RemoteSurfaceViewportPayload): Promise<void>;
  dispatchClipboard(session: RemoteSurfaceSessionRef, payload: RemoteSurfaceClipboardPayload): Promise<void>;
  readDiagnostics(
    session: RemoteSurfaceSessionRef,
    cursor?: string,
  ): Promise<RemoteSurfaceDiagnosticsPayload>;
}

export interface RemoteSurfaceCreateSessionRequest {
  capabilities: RemoteSurfaceSessionDescriptor["capabilities"];
  ttlMs?: number;
  target?: RemoteSurfaceTargetDescriptor;
  hostMetadata?: RemoteSurfaceSessionDescriptor["hostMetadata"];
}

export interface RemoteSurfaceCreateSessionResult {
  token: string;
  tokenDescriptor: RemoteSurfaceTokenDescriptor;
  session: RemoteSurfaceSessionDescriptor;
}

export interface RemoteSurfaceAttachSessionResult {
  session: RemoteSurfaceSessionDescriptor;
  target?: RemoteSurfaceTargetDescriptor;
}

export type RemoteSurfaceAuthorizationScope =
  | "events"
  | "input"
  | "viewport"
  | "clipboard"
  | "diagnostics";

export type RemoteSurfaceSessionHandle =
  | { token: string }
  | { tokenId: RemoteSurfaceTokenId }
  | { sessionId: RemoteSurfaceSessionId };

export type RemoteSurfaceSessionRef = { sessionId: RemoteSurfaceSessionId };

export type RemoteSurfaceEventSink = (event: RemoteSurfaceEventPayload) => void | Promise<void>;

export interface RemoteSurfaceChannelSubscription {
  close(reason?: string): Promise<void> | void;
}
