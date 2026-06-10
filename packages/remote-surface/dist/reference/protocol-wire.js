import { RemoteSurfaceProtocolError } from "../protocol/errors.js";
export function parseReferenceWireInputPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
export function normalizeReferenceWireViewportPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const input = value;
    const width = Number(input.width);
    const height = Number(input.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
    const out = { width: Math.floor(width), height: Math.floor(height) };
    const deviceScaleFactor = Number(input.deviceScaleFactor);
    if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
        out.deviceScaleFactor = deviceScaleFactor;
    }
    const screenWidth = Number(input.screenWidth);
    if (Number.isFinite(screenWidth) && screenWidth > 0) {
        out.screenWidth = Math.max(out.width, Math.floor(screenWidth));
    }
    const screenHeight = Number(input.screenHeight);
    if (Number.isFinite(screenHeight) && screenHeight > 0) {
        out.screenHeight = Math.max(out.height, Math.floor(screenHeight));
    }
    if (typeof input.hasTouch === "boolean")
        out.hasTouch = input.hasTouch;
    if (input.mobile === true)
        out.mobile = true;
    if (typeof input.userAgent === "string" && input.userAgent.length > 0) {
        out.userAgent = input.userAgent.slice(0, 512);
    }
    return out;
}
export function parseReferenceWireInputTelemetryCursor(value) {
    const sinceRaw = typeof value === "string" ? Number(value) : 0;
    return { since: Number.isFinite(sinceRaw) ? sinceRaw : 0 };
}
export function parseReferenceWireInputTelemetryRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = requireJsonObject(value, "$");
    return record;
}
export function buildReferenceWireAttachedPayload({ runId, interactionId, browserSessionId, viewport, }) {
    return {
        run_id: runId,
        interaction_id: interactionId,
        browser_session_id: browserSessionId,
        viewport: toJsonValueOrNull(viewport),
    };
}
export function buildReferenceWireFramePayload(frame) {
    return {
        session_id: typeof frame.sessionId === "number" ? frame.sessionId : Number(frame.sessionId),
        data_base64: typeof frame.data === "string" ? frame.data : "",
        metadata: frame.metadata ? toJsonValueOrNull(frame.metadata) : null,
    };
}
export function buildReferenceWireCompanionEventPayload(event) {
    if (!event || typeof event !== "object" || Array.isArray(event))
        return null;
    const record = event;
    if (typeof record.kind !== "string")
        return null;
    switch (record.kind) {
        case "url_changed": {
            const data = { url: typeof record.url === "string" ? record.url : "" };
            if (typeof record.title === "string")
                data.title = record.title;
            return { name: "url_changed", data };
        }
        case "popup_opened":
            return {
                name: "popup_opened",
                data: {
                    targetId: typeof record.targetId === "string" ? record.targetId : "",
                    url: typeof record.url === "string" ? record.url : "",
                },
            };
        case "popup_closed":
            return {
                name: "popup_closed",
                data: { targetId: typeof record.targetId === "string" ? record.targetId : "" },
            };
        default:
            return { name: record.kind, data: event };
    }
}
export function buildReferenceWireBackendReadyPayload({ backend, token, browserOwnerMode, stealthMode, }) {
    const backendName = typeof backend === "string" ? backend : "cdp";
    const encodedToken = encodeURIComponent(token);
    return {
        backend: backendName,
        browser_owner_mode: backendName === "neko" && typeof browserOwnerMode === "function" ? nullableString(browserOwnerMode()) : null,
        client_config_path: backendName === "neko" ? `/_ref/run-interaction-streams/${encodedToken}/neko/session` : null,
        iframe_path: backendName === "neko" ? `/_ref/run-interaction-streams/${encodedToken}/neko` : null,
        stealth_mode: backendName === "neko" && typeof stealthMode === "function" ? nullableString(stealthMode()) : null,
    };
}
function requireJsonObject(value, path) {
    requireJsonValue(value, path);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new RemoteSurfaceProtocolError("expected JSON object", path);
    }
    return value;
}
function requireJsonValue(value, path) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new RemoteSurfaceProtocolError("expected finite JSON number", path);
        return value;
    }
    if (Array.isArray(value))
        return value.map((entry, index) => requireJsonValue(entry, `${path}[${index}]`));
    if (typeof value === "object") {
        const result = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = requireJsonValue(entry, `${path}.${key}`);
        }
        return result;
    }
    throw new RemoteSurfaceProtocolError("expected JSON value", path);
}
function toJsonValueOrNull(value) {
    if (value === null)
        return null;
    const type = typeof value;
    if (type === "string")
        return value;
    if (type === "boolean")
        return value;
    if (type === "number") {
        const numberValue = value;
        return Number.isFinite(numberValue) ? numberValue : null;
    }
    if (Array.isArray(value))
        return value.map(toJsonValueOrNull);
    if (type !== "object")
        return null;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (child !== undefined)
            out[key] = toJsonValueOrNull(child);
    }
    return out;
}
function nullableString(value) {
    return typeof value === "string" ? value : null;
}
//# sourceMappingURL=protocol-wire.js.map