type JsonObject = {
    readonly [key: string]: JsonValue;
};
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
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
export {};
//# sourceMappingURL=protocol-wire.d.ts.map