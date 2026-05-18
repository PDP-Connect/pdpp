import { createDiagnosticsBuffer } from "../diagnostics/index.js";
export const TEST_REMOTE_SURFACE_CAPABILITIES = {
    eventChannel: "sse",
    input: ["pointer", "keyboard", "text", "paste"],
    clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
    viewport: ["report", "resize"],
    diagnostics: ["events", "redacted_buffer"],
    ownerBrowser: true,
    serverSideAutomationEndpoint: false,
};
export class FakeRemoteSurfaceSessionBroker {
    sessions = new Map();
    tokens = new Map();
    targets = new Map();
    diagnostics = createDiagnosticsBuffer({ capacity: 100 });
    nextId = 1;
    async createSession(request) {
        const sessionId = `session_${this.nextId}`;
        const tokenId = `token_id_${this.nextId}`;
        const token = `token_secret_${this.nextId}`;
        this.nextId += 1;
        const issuedAt = Date.now();
        const session = {
            sessionId,
            capabilities: request.capabilities,
            issuedAt,
            expiresAt: issuedAt + (request.ttlMs ?? 300_000),
            ...(request.target ? { targetId: request.target.targetId, backend: request.target.backend } : {}),
            ...(request.hostMetadata ? { hostMetadata: request.hostMetadata } : {}),
        };
        const tokenDescriptor = {
            tokenId,
            sessionId,
            issuedAt,
            expiresAt: session.expiresAt,
            scopes: ["attach", "events", "input", "viewport", "clipboard", "diagnostics"],
        };
        this.sessions.set(sessionId, session);
        this.tokens.set(token, sessionId);
        this.tokens.set(tokenId, sessionId);
        if (request.target)
            this.targets.set(sessionId, request.target);
        return { token, tokenDescriptor, session };
    }
    async registerTarget(ref, target) {
        const session = this.requireSession(ref);
        const next = { ...session, targetId: target.targetId, backend: target.backend };
        this.sessions.set(session.sessionId, next);
        this.targets.set(session.sessionId, target);
        return next;
    }
    async attachSession(handle) {
        const session = this.requireHandle(handle);
        const next = typeof session.attachedAt === "number" ? session : { ...session, attachedAt: Date.now() };
        this.sessions.set(session.sessionId, next);
        const target = this.targets.get(session.sessionId);
        return target ? { session: next, target } : { session: next };
    }
    async authorizeSession(handle, _scope) {
        const session = this.requireHandle(handle);
        if (typeof session.attachedAt !== "number") {
            throw new Error("Remote surface session is not attached");
        }
        return session;
    }
    async revokeSession(ref, reason = "invalidated") {
        const session = this.sessions.get(ref.sessionId);
        if (!session)
            return null;
        const next = { ...session, revokedAt: Date.now(), revocationReason: reason };
        this.sessions.set(ref.sessionId, next);
        return next;
    }
    async openEventChannel(ref, sink) {
        const session = this.requireSession(ref);
        await sink({ type: "lifecycle", sessionId: session.sessionId, state: "attached", timestamp: Date.now() });
        return { close: () => undefined };
    }
    async dispatchInput(ref, payload) {
        this.requireSession(ref);
        this.diagnostics.push({ type: "input", timestamp: Date.now(), payload: toJsonObject(payload) });
    }
    async reportViewport(ref, payload) {
        this.requireSession(ref);
        this.diagnostics.push({ type: "viewport", timestamp: Date.now(), payload: toJsonObject(payload) });
    }
    async dispatchClipboard(ref, payload) {
        this.requireSession(ref);
        this.diagnostics.push({ type: "clipboard", timestamp: Date.now(), payload: toJsonObject(payload) });
    }
    async readDiagnostics(_session, cursor) {
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
    emit(ref, event) {
        this.requireSession(ref);
        return event;
    }
    requireHandle(handle) {
        if ("sessionId" in handle)
            return this.requireSession(handle);
        const sessionId = this.tokens.get("token" in handle ? handle.token : handle.tokenId);
        if (!sessionId)
            throw new Error("Remote surface token not found");
        return this.requireSession({ sessionId });
    }
    requireSession(ref) {
        const session = this.sessions.get(ref.sessionId);
        if (!session)
            throw new Error("Remote surface session not found");
        if (session.revokedAt)
            throw new Error("Remote surface session revoked");
        if (session.expiresAt <= Date.now())
            throw new Error("Remote surface session expired");
        return session;
    }
}
function toJsonObject(value) {
    return value;
}
export { FIXTURE_REMOTE_SURFACE_CAPABILITIES, REMOTE_SURFACE_CLIPBOARD_FIXTURES, REMOTE_SURFACE_DIAGNOSTICS_FIXTURE, REMOTE_SURFACE_EVENT_FIXTURES, REMOTE_SURFACE_INPUT_FIXTURES, REMOTE_SURFACE_TARGET_FIXTURES, REMOTE_SURFACE_VIEWPORT_FIXTURES, } from "./protocol-fixtures.js";
export { REFERENCE_WIRE_ALL_FIXTURES, REFERENCE_WIRE_BROWSER_SESSION_ID, REFERENCE_WIRE_BROWSER_VISIBLE_FIXTURES, REFERENCE_WIRE_BROWSER_VISIBLE_TARGET_DESCRIPTORS, REFERENCE_WIRE_DIAGNOSTICS_RECORD_FIXTURES, REFERENCE_WIRE_INPUT_ACK_FIXTURE, REFERENCE_WIRE_INPUT_PAYLOAD_FIXTURES, REFERENCE_WIRE_INPUT_TELEMETRY_FIXTURE, REFERENCE_WIRE_INTERACTION_ID, REFERENCE_WIRE_MINT_REQUEST_FIXTURE, REFERENCE_WIRE_MINT_RESPONSE_FIXTURE, REFERENCE_WIRE_NEKO_CLIENT_CONFIG_FIXTURE, REFERENCE_WIRE_NEKO_STATUS_FIXTURES, REFERENCE_WIRE_RUN_ID, REFERENCE_WIRE_SSE_EVENT_FIXTURES, REFERENCE_WIRE_TARGET_DELETE_RESPONSE_FIXTURE, REFERENCE_WIRE_TARGET_REGISTRATION_RESPONSE_FIXTURE, REFERENCE_WIRE_TOKEN, REFERENCE_WIRE_VIEWPORT_ACK_FIXTURE, REFERENCE_WIRE_VIEWPORT_PAYLOAD_FIXTURE, } from "./reference-wire-fixtures.js";
//# sourceMappingURL=index.js.map