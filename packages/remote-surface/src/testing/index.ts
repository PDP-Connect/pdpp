import { createDiagnosticsBuffer } from "../diagnostics/index.ts";
import type {
  JsonObject,
  RemoteSurfaceCapabilities,
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceDiagnosticsPayload,
  RemoteSurfaceEventPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceSessionDescriptor,
  RemoteSurfaceTargetDescriptor,
  RemoteSurfaceTokenDescriptor,
  RemoteSurfaceViewportPayload,
} from "../protocol/index.ts";
import type {
  RemoteSurfaceAttachSessionResult,
  RemoteSurfaceAuthorizationScope,
  RemoteSurfaceChannelSubscription,
  RemoteSurfaceCreateSessionRequest,
  RemoteSurfaceCreateSessionResult,
  RemoteSurfaceEventSink,
  RemoteSurfaceSessionBroker,
  RemoteSurfaceSessionHandle,
  RemoteSurfaceSessionRef,
} from "../server/index.ts";

export const TEST_REMOTE_SURFACE_CAPABILITIES: RemoteSurfaceCapabilities = {
  eventChannel: "sse",
  input: ["pointer", "keyboard", "text", "paste"],
  clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
  viewport: ["report", "resize"],
  diagnostics: ["events", "redacted_buffer"],
  ownerBrowser: true,
  serverSideAutomationEndpoint: false,
};

export class FakeRemoteSurfaceSessionBroker implements RemoteSurfaceSessionBroker {
  private readonly sessions = new Map<string, RemoteSurfaceSessionDescriptor>();
  private readonly tokens = new Map<string, string>();
  private readonly targets = new Map<string, RemoteSurfaceTargetDescriptor>();
  private readonly diagnostics = createDiagnosticsBuffer({ capacity: 100 });
  private nextId = 1;

  async createSession(request: RemoteSurfaceCreateSessionRequest): Promise<RemoteSurfaceCreateSessionResult> {
    const sessionId = `session_${this.nextId}`;
    const tokenId = `token_id_${this.nextId}`;
    const token = `token_secret_${this.nextId}`;
    this.nextId += 1;
    const issuedAt = Date.now();
    const session: RemoteSurfaceSessionDescriptor = {
      sessionId,
      capabilities: request.capabilities,
      issuedAt,
      expiresAt: issuedAt + (request.ttlMs ?? 300_000),
      ...(request.target ? { targetId: request.target.targetId, backend: request.target.backend } : {}),
      ...(request.hostMetadata ? { hostMetadata: request.hostMetadata } : {}),
    };
    const tokenDescriptor: RemoteSurfaceTokenDescriptor = {
      tokenId,
      sessionId,
      issuedAt,
      expiresAt: session.expiresAt,
      scopes: ["attach", "events", "input", "viewport", "clipboard", "diagnostics"],
    };
    this.sessions.set(sessionId, session);
    this.tokens.set(token, sessionId);
    this.tokens.set(tokenId, sessionId);
    if (request.target) this.targets.set(sessionId, request.target);
    return { token, tokenDescriptor, session };
  }

  async registerTarget(
    ref: RemoteSurfaceSessionRef,
    target: RemoteSurfaceTargetDescriptor,
  ): Promise<RemoteSurfaceSessionDescriptor> {
    const session = this.requireSession(ref);
    const next = { ...session, targetId: target.targetId, backend: target.backend };
    this.sessions.set(session.sessionId, next);
    this.targets.set(session.sessionId, target);
    return next;
  }

  async attachSession(handle: RemoteSurfaceSessionHandle): Promise<RemoteSurfaceAttachSessionResult> {
    const session = this.requireHandle(handle);
    const next =
      typeof session.attachedAt === "number" ? session : { ...session, attachedAt: Date.now() };
    this.sessions.set(session.sessionId, next);
    const target = this.targets.get(session.sessionId);
    return target ? { session: next, target } : { session: next };
  }

  async authorizeSession(
    handle: RemoteSurfaceSessionHandle,
    _scope: RemoteSurfaceAuthorizationScope,
  ): Promise<RemoteSurfaceSessionDescriptor> {
    const session = this.requireHandle(handle);
    if (typeof session.attachedAt !== "number") {
      throw new Error("Remote surface session is not attached");
    }
    return session;
  }

  async revokeSession(
    ref: RemoteSurfaceSessionRef,
    reason: RemoteSurfaceSessionDescriptor["revocationReason"] = "invalidated",
  ): Promise<RemoteSurfaceSessionDescriptor | null> {
    const session = this.sessions.get(ref.sessionId);
    if (!session) return null;
    const next = { ...session, revokedAt: Date.now(), revocationReason: reason };
    this.sessions.set(ref.sessionId, next);
    return next;
  }

  async openEventChannel(
    ref: RemoteSurfaceSessionRef,
    sink: RemoteSurfaceEventSink,
  ): Promise<RemoteSurfaceChannelSubscription> {
    const session = this.requireSession(ref);
    await sink({ type: "lifecycle", sessionId: session.sessionId, state: "attached", timestamp: Date.now() });
    return { close: () => undefined };
  }

  async dispatchInput(ref: RemoteSurfaceSessionRef, payload: RemoteSurfaceInputPayload): Promise<void> {
    this.requireSession(ref);
    this.diagnostics.push({ type: "input", timestamp: Date.now(), payload: toJsonObject(payload) });
  }

  async reportViewport(ref: RemoteSurfaceSessionRef, payload: RemoteSurfaceViewportPayload): Promise<void> {
    this.requireSession(ref);
    this.diagnostics.push({ type: "viewport", timestamp: Date.now(), payload: toJsonObject(payload) });
  }

  async dispatchClipboard(ref: RemoteSurfaceSessionRef, payload: RemoteSurfaceClipboardPayload): Promise<void> {
    this.requireSession(ref);
    this.diagnostics.push({ type: "clipboard", timestamp: Date.now(), payload: toJsonObject(payload) });
  }

  async readDiagnostics(_session: RemoteSurfaceSessionRef, cursor?: string): Promise<RemoteSurfaceDiagnosticsPayload> {
    const parsedCursor = cursor ? Number.parseInt(cursor, 10) : undefined;
    const result = this.diagnostics.read(parsedCursor);
    return {
      type: "diagnostics",
      cursor: String(result.cursor),
      events: result.events.map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        ...(event.payload ? { payload: event.payload } : {}),
      })),
    };
  }

  emit(ref: RemoteSurfaceSessionRef, event: RemoteSurfaceEventPayload): RemoteSurfaceEventPayload {
    this.requireSession(ref);
    return event;
  }

  private requireHandle(handle: RemoteSurfaceSessionHandle): RemoteSurfaceSessionDescriptor {
    if ("sessionId" in handle) return this.requireSession(handle);
    const sessionId = this.tokens.get("token" in handle ? handle.token : handle.tokenId);
    if (!sessionId) throw new Error("Remote surface token not found");
    return this.requireSession({ sessionId });
  }

  private requireSession(ref: RemoteSurfaceSessionRef): RemoteSurfaceSessionDescriptor {
    const session = this.sessions.get(ref.sessionId);
    if (!session) throw new Error("Remote surface session not found");
    if (session.revokedAt) throw new Error("Remote surface session revoked");
    if (session.expiresAt <= Date.now()) throw new Error("Remote surface session expired");
    return session;
  }
}

function toJsonObject(value: RemoteSurfaceInputPayload | RemoteSurfaceViewportPayload | RemoteSurfaceClipboardPayload): JsonObject {
  return value as unknown as JsonObject;
}

export {
  FIXTURE_REMOTE_SURFACE_CAPABILITIES,
  REMOTE_SURFACE_CLIPBOARD_FIXTURES,
  REMOTE_SURFACE_DIAGNOSTICS_FIXTURE,
  REMOTE_SURFACE_EVENT_FIXTURES,
  REMOTE_SURFACE_INPUT_FIXTURES,
  REMOTE_SURFACE_TARGET_FIXTURES,
  REMOTE_SURFACE_VIEWPORT_FIXTURES,
} from "./protocol-fixtures.ts";
