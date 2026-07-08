function ok(value) {
    return { ok: true, value };
}
function err(error) {
    return { error, ok: false };
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseJsonObject(data) {
    try {
        const parsed = JSON.parse(data);
        if (!isObject(parsed)) {
            return err("payload_not_object");
        }
        return ok(parsed);
    }
    catch {
        return err("payload_invalid_json");
    }
}
function requiredString(payload, key) {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? ok(value) : err(`${key}_missing`);
}
function optionalNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parseViewport(value) {
    if (value === null || value === undefined) {
        return ok(null);
    }
    if (!isObject(value)) {
        return err("viewport_invalid");
    }
    const width = optionalNumber(value.width);
    const height = optionalNumber(value.height);
    const screenWidth = optionalNumber(value.screenWidth);
    const screenHeight = optionalNumber(value.screenHeight);
    const viewport = {
        width: typeof width === "number" ? Math.floor(width) : 0,
        height: typeof height === "number" ? Math.floor(height) : 0,
        ...(typeof screenWidth === "number" ? { screenWidth: Math.floor(screenWidth) } : {}),
        ...(typeof screenHeight === "number" ? { screenHeight: Math.floor(screenHeight) } : {}),
    };
    if (!(viewport.width > 0 && viewport.height > 0)) {
        return err("viewport_invalid_dimensions");
    }
    return ok(viewport);
}
export function parseAttachedMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const browserSessionId = requiredString(parsed.value, "browser_session_id");
    const interactionId = requiredString(parsed.value, "interaction_id");
    const runId = requiredString(parsed.value, "run_id");
    const viewport = parseViewport(parsed.value.viewport);
    if (!browserSessionId.ok) {
        return browserSessionId;
    }
    if (!interactionId.ok) {
        return interactionId;
    }
    if (!runId.ok) {
        return runId;
    }
    if (!viewport.ok) {
        return viewport;
    }
    return ok({
        browser_session_id: browserSessionId.value,
        interaction_id: interactionId.value,
        run_id: runId.value,
        viewport: viewport.value,
    });
}
//# sourceMappingURL=stream-viewer-protocol.js.map