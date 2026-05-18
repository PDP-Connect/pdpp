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
function optionalString(value) {
    if (value === undefined) {
        return;
    }
    if (value === null) {
        return null;
    }
    return typeof value === "string" ? value : undefined;
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
function parseOptionalFrameMetadata(value) {
    if (!isObject(value)) {
        return value === null ? null : undefined;
    }
    return {
        device_height: optionalNumber(value.device_height),
        device_width: optionalNumber(value.device_width),
    };
}
export function parseFrameMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const dataBase64 = requiredString(parsed.value, "data_base64");
    if (!dataBase64.ok) {
        return dataBase64;
    }
    return ok({
        data_base64: dataBase64.value,
        metadata: parseOptionalFrameMetadata(parsed.value.metadata),
        session_id: optionalNumber(parsed.value.session_id),
    });
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
export function parseBackendReadyMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const backend = requiredString(parsed.value, "backend");
    if (!backend.ok) {
        return backend;
    }
    return ok({
        backend: backend.value,
        browser_owner_mode: optionalString(parsed.value.browser_owner_mode),
        client_config_path: optionalString(parsed.value.client_config_path),
        iframe_path: optionalString(parsed.value.iframe_path),
        stealth_mode: optionalString(parsed.value.stealth_mode),
    });
}
export function parseUrlChangedMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const url = requiredString(parsed.value, "url");
    if (!url.ok) {
        return url;
    }
    return ok({
        title: optionalString(parsed.value.title) ?? undefined,
        url: url.value,
    });
}
export function parsePopupOpenedMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const targetId = requiredString(parsed.value, "targetId");
    if (!targetId.ok) {
        return targetId;
    }
    return ok({
        targetId: targetId.value,
        url: typeof parsed.value.url === "string" ? parsed.value.url : undefined,
    });
}
export function parsePopupClosedMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const targetId = requiredString(parsed.value, "targetId");
    return targetId.ok ? ok({ targetId: targetId.value }) : targetId;
}
export function parseClipboardMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    const text = optionalString(parsed.value.text);
    return typeof text === "string" ? ok({ text }) : err("text_missing");
}
export function parseKeyboardFocusMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    if (typeof parsed.value.focused !== "boolean") {
        return err("focused_missing");
    }
    let element;
    if (isObject(parsed.value.element)) {
        element = {
            inputType: optionalString(parsed.value.element.inputType) ?? undefined,
            tagName: optionalString(parsed.value.element.tagName) ?? undefined,
        };
    }
    else if (parsed.value.element === null) {
        element = null;
    }
    return ok({ element, focused: parsed.value.focused });
}
export function parseStreamErrorMessage(data) {
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
        return parsed;
    }
    return ok({
        code: optionalString(parsed.value.code) ?? undefined,
        message: optionalString(parsed.value.message) ?? undefined,
    });
}
//# sourceMappingURL=stream-viewer.js.map