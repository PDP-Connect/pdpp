export type RemoteSurfaceId = string;
export type RemoteSurfaceSessionId = RemoteSurfaceId;
export type RemoteSurfaceTargetId = RemoteSurfaceId;
export type RemoteSurfaceTokenId = RemoteSurfaceId;
export type RemoteSurfaceBackendKind = "neko" | "cdp" | "vnc" | "kasm" | "custom";
export type RemoteSurfaceRevocationReason = "expired" | "superseded" | "resolved" | "host_cancelled" | "target_unavailable" | "backend_error" | "invalidated";
export interface RemoteSurfaceCapabilities {
    eventChannel: "sse" | "websocket" | "poll" | "none";
    input: readonly RemoteSurfaceInputMode[];
    clipboard: readonly RemoteSurfaceClipboardMode[];
    viewport: readonly RemoteSurfaceViewportMode[];
    diagnostics: readonly RemoteSurfaceDiagnosticsMode[];
    ownerBrowser: boolean;
    serverSideAutomationEndpoint: boolean;
}
export type RemoteSurfaceInputMode = "pointer" | "keyboard" | "keysym" | "text" | "paste" | "touch" | "scroll";
export type RemoteSurfaceClipboardMode = "local_to_remote" | "remote_to_local" | "manual_fallback";
export type RemoteSurfaceViewportMode = "report" | "resize" | "classify_occlusion";
export type RemoteSurfaceDiagnosticsMode = "events" | "replay" | "redacted_buffer";
export interface RemoteSurfaceTokenDescriptor {
    tokenId: RemoteSurfaceTokenId;
    sessionId: RemoteSurfaceSessionId;
    issuedAt: number;
    expiresAt: number;
    scopes: readonly RemoteSurfaceTokenScope[];
}
export type RemoteSurfaceTokenScope = "attach" | "events" | "input" | "viewport" | "clipboard" | "diagnostics";
export interface RemoteSurfaceSessionDescriptor {
    sessionId: RemoteSurfaceSessionId;
    targetId?: RemoteSurfaceTargetId;
    backend?: RemoteSurfaceBackendKind;
    capabilities: RemoteSurfaceCapabilities;
    issuedAt: number;
    expiresAt: number;
    attachedAt?: number;
    revokedAt?: number;
    revocationReason?: RemoteSurfaceRevocationReason;
    hostMetadata?: Readonly<Record<string, JsonValue>>;
}
export interface RemoteSurfaceTargetDescriptor {
    targetId: RemoteSurfaceTargetId;
    backend: RemoteSurfaceBackendKind;
    label?: string;
    capabilities: RemoteSurfaceCapabilities;
    clientDescriptor?: SafeRemoteSurfaceBackendDescriptor;
    hostMetadata?: Readonly<Record<string, JsonValue>>;
}
export interface SafeRemoteSurfaceBackendDescriptor {
    backend: RemoteSurfaceBackendKind;
    capabilities: RemoteSurfaceCapabilities;
    proxy?: RemoteSurfaceProxyDescriptor;
    session?: RemoteSurfaceClientSessionDescriptor;
}
export interface RemoteSurfaceProxyDescriptor {
    path: string;
    sameOrigin: true;
    allowedMethods?: readonly string[];
}
export interface RemoteSurfaceClientSessionDescriptor {
    path: string;
    sameOrigin: true;
    expiresAt?: number;
}
export type RemoteSurfaceFrameEvent = {
    type: "frame";
    sessionId: RemoteSurfaceSessionId;
    sequence: number;
    contentType: "image/jpeg" | "image/png";
    data: string;
    timestamp: number;
};
export type RemoteSurfaceBackendEvent = {
    type: "backend_event";
    sessionId: RemoteSurfaceSessionId;
    name: string;
    payload?: JsonObject;
    timestamp: number;
};
export type RemoteSurfaceLifecycleEvent = {
    type: "lifecycle";
    sessionId: RemoteSurfaceSessionId;
    state: "created" | "attached" | "ready" | "revoked" | "closed" | "error";
    reason?: string;
    timestamp: number;
};
export type RemoteSurfaceEventPayload = RemoteSurfaceFrameEvent | RemoteSurfaceBackendEvent | RemoteSurfaceLifecycleEvent;
export type RemoteSurfaceInputPayload = RemoteSurfacePointerInput | RemoteSurfaceKeyboardInput | RemoteSurfaceTextInput | RemoteSurfaceClipboardInput;
export interface RemoteSurfacePointerInput {
    type: "pointer";
    action: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "wheel";
    x: number;
    y: number;
    pointerType?: "mouse" | "touch" | "pen";
    pointerId?: number;
    button?: number;
    buttons?: number;
    deltaX?: number;
    deltaY?: number;
    modifiers?: readonly RemoteSurfaceKeyModifier[];
    timestamp?: number;
}
export interface RemoteSurfaceKeyboardInput {
    type: "keyboard";
    action: "keydown" | "keyup" | "keypress";
    key?: string;
    code?: string;
    keysym?: number;
    modifiers?: readonly RemoteSurfaceKeyModifier[];
    timestamp?: number;
}
export interface RemoteSurfaceTextInput {
    type: "text";
    text: string;
    composition?: "start" | "update" | "commit" | "cancel";
    timestamp?: number;
}
export interface RemoteSurfaceClipboardInput {
    type: "clipboard";
    action: "paste";
    text: string;
    timestamp?: number;
}
export type RemoteSurfaceKeyModifier = "Alt" | "Control" | "Meta" | "Shift";
export interface RemoteSurfaceViewportPayload {
    type: "viewport";
    width: number;
    height: number;
    deviceScaleFactor?: number;
    screenWidth?: number;
    screenHeight?: number;
    hasTouch?: boolean;
    mobile?: boolean;
    orientation?: "portrait" | "landscape";
    visualViewport?: RemoteSurfaceVisualViewport;
    keyboardOcclusion?: RemoteSurfaceKeyboardOcclusion;
    timestamp?: number;
}
export interface RemoteSurfaceVisualViewport {
    width: number;
    height: number;
    offsetTop?: number;
    offsetLeft?: number;
    scale?: number;
}
export interface RemoteSurfaceKeyboardOcclusion {
    visible: boolean;
    height: number;
    reason?: "software_keyboard" | "browser_chrome" | "unknown";
}
export type RemoteSurfaceClipboardPayload = {
    type: "clipboard";
    action: "local_to_remote";
    text: string;
    timestamp?: number;
} | {
    type: "clipboard";
    action: "remote_to_local";
    text?: string;
    requestId?: string;
    timestamp?: number;
} | {
    type: "clipboard";
    action: "capabilities";
    canReadLocal: boolean;
    canWriteLocal: boolean;
    canReadRemote: boolean;
    canWriteRemote: boolean;
    timestamp?: number;
};
export interface RemoteSurfaceDiagnosticsPayload {
    type: "diagnostics";
    cursor?: string;
    events: readonly JsonObject[];
}
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = {
    readonly [key: string]: JsonValue;
};
export type ReferenceWireInputPayload = Record<string, unknown>;
export interface ReferenceWireViewportPayload {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    screenWidth?: number;
    screenHeight?: number;
    hasTouch?: boolean;
    mobile?: true;
    userAgent?: string;
}
export interface ReferenceWireInputTelemetryCursor {
    since: number;
}
export interface ReferenceWireInputTelemetryRecord {
    readonly [key: string]: JsonValue | undefined;
    seq?: number;
    serverAtMs?: number;
    source?: string;
    kind?: string;
}
export interface ReferenceWireBackendReadyPayload {
    backend: string;
    browser_owner_mode: string | null;
    client_config_path: string | null;
    iframe_path: string | null;
    stealth_mode: string | null;
}
export interface ReferenceWireAttachedPayload {
    run_id: string;
    interaction_id: string;
    browser_session_id: string;
    viewport: JsonValue;
}
export interface ReferenceWireFramePayload {
    session_id: number;
    data_base64: string;
    metadata: JsonValue;
}
export interface ReferenceWireNamedSseEvent {
    name: string;
    data: unknown;
}
export declare class RemoteSurfaceProtocolError extends Error {
    readonly path: string;
    constructor(message: string, path?: string);
}
export declare function parseRemoteSurfaceEventPayload(value: unknown): RemoteSurfaceEventPayload;
export declare function parseRemoteSurfaceInputPayload(value: unknown): RemoteSurfaceInputPayload;
export declare function parseRemoteSurfaceViewportPayload(value: unknown): RemoteSurfaceViewportPayload;
export declare function parseRemoteSurfaceClipboardPayload(value: unknown): RemoteSurfaceClipboardPayload;
export declare function parseRemoteSurfaceDiagnosticsPayload(value: unknown): RemoteSurfaceDiagnosticsPayload;
export declare function parseReferenceWireInputPayload(value: unknown): ReferenceWireInputPayload;
export declare function normalizeReferenceWireViewportPayload(value: unknown): ReferenceWireViewportPayload | null;
export declare function parseReferenceWireInputTelemetryCursor(value: unknown): ReferenceWireInputTelemetryCursor;
export declare function parseReferenceWireInputTelemetryRecord(value: unknown): ReferenceWireInputTelemetryRecord | null;
export declare function buildReferenceWireAttachedPayload({ runId, interactionId, browserSessionId, viewport, }: {
    runId: string;
    interactionId: string;
    browserSessionId: string;
    viewport: unknown;
}): ReferenceWireAttachedPayload;
export declare function buildReferenceWireFramePayload(frame: {
    sessionId?: unknown;
    data?: unknown;
    metadata?: unknown;
}): ReferenceWireFramePayload;
export declare function buildReferenceWireCompanionEventPayload(event: unknown): ReferenceWireNamedSseEvent | null;
export declare function buildReferenceWireBackendReadyPayload({ backend, token, browserOwnerMode, stealthMode, }: {
    backend: unknown;
    token: string;
    browserOwnerMode?: (() => unknown) | null;
    stealthMode?: (() => unknown) | null;
}): ReferenceWireBackendReadyPayload;
export declare function parseSafeRemoteSurfaceBackendDescriptor(value: unknown): SafeRemoteSurfaceBackendDescriptor;
export declare function parseRemoteSurfaceTargetDescriptor(value: unknown): RemoteSurfaceTargetDescriptor;
export declare function isSafeRemoteSurfaceBackendDescriptor(descriptor: SafeRemoteSurfaceBackendDescriptor): boolean;
export declare function assertNoUnsafeDescriptor(value: unknown): void;
export declare function findUnsafeDescriptorPaths(value: unknown, path?: string): string[];
export * from "./stream-viewer.ts";
//# sourceMappingURL=index.d.ts.map