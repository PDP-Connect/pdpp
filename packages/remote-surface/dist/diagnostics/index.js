export * from "./visual-quality.js";
const DEFAULT_REDACTED = "[redacted]";
const DEFAULT_SECRET_KEYS = new Set([
    "access_token",
    "accesstoken",
    "auth",
    "authmetadata",
    "allocatorcredential",
    "allocatorcredentials",
    "allocatorpassword",
    "allocatorsecret",
    "allocatortoken",
    "apikey",
    "api_key",
    "authorization",
    "bearer",
    "cdpurl",
    "cdpwsurl",
    "cdpendpoint",
    "cookie",
    "credential",
    "credentials",
    "headers",
    "password",
    "refresh_token",
    "refreshtoken",
    "secret",
    "secretkey",
    "secret_key",
    "session_token",
    "sessiontoken",
    "clipboard",
    "targeturl",
    "text",
    "token",
    "url",
    "websocketdebuggerurl",
]);
export function redactDiagnosticsEvent(event, options = {}) {
    const replacement = options.replacement ?? DEFAULT_REDACTED;
    const redactKeys = new Set([...DEFAULT_SECRET_KEYS, ...(options.redactKeys ?? [])].map((key) => key.toLowerCase()));
    const payload = event.payload ? redactJsonObject(event.payload, redactKeys, replacement) : undefined;
    const replay = event.replay ? redactJsonObject(event.replay, redactKeys, replacement) : undefined;
    return {
        ...event,
        ...(payload ? { payload } : {}),
        ...(replay ? { replay: replay } : {}),
    };
}
export function createDiagnosticsBuffer(options) {
    const capacity = Math.max(0, Math.floor(options.capacity));
    const events = [];
    const listeners = new Set();
    let offset = 0;
    return {
        push(event) {
            const stored = options.redact === false ? event : redactDiagnosticsEvent(event, options.redaction);
            if (capacity === 0) {
                offset += 1;
                notifyDiagnosticsListeners(listeners, stored);
                return stored;
            }
            events.push(stored);
            while (events.length > capacity) {
                events.shift();
                offset += 1;
            }
            notifyDiagnosticsListeners(listeners, stored);
            return stored;
        },
        read(cursor = offset) {
            const start = Math.max(offset, Math.floor(cursor));
            const index = start - offset;
            return {
                cursor: offset + events.length,
                events: events.slice(index),
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return {
                unsubscribe() {
                    listeners.delete(listener);
                },
            };
        },
        clear() {
            offset += events.length;
            events.length = 0;
        },
        size() {
            return events.length;
        },
    };
}
export function buildInputPipelineDiagnosticsEvent({ payload, timestamp = payload.timestamp ?? Date.now(), }) {
    const classification = classifyRemoteSurfaceInput(payload);
    const action = "action" in payload ? payload.action : undefined;
    return {
        type: "input.pipeline",
        timestamp,
        payload: {
            classification,
            inputType: payload.type,
            ...(action ? { action } : {}),
            replayable: true,
        },
        replay: {
            input: payload,
            output: {
                classification,
                inputType: payload.type,
                ...(action ? { action } : {}),
            },
        },
    };
}
export function buildViewportTransitionDiagnosticsEvent({ next, previous, timestamp = next.timestamp ?? Date.now(), transition, }) {
    return {
        type: "viewport.transition",
        timestamp,
        payload: {
            kind: transition.kind,
            keyboardInsetBottom: transition.keyboardInsetBottom,
            reason: transition.reason,
            remoteResize: transition.remoteResize,
            replayable: true,
        },
        replay: {
            input: {
                next: next,
                previous: (previous ?? null),
            },
            output: transition,
        },
    };
}
export function buildClipboardActionDiagnosticsEvent({ payload, textLengthBucket, timestamp = payload.timestamp ?? Date.now(), }) {
    return {
        type: "clipboard.action",
        timestamp,
        payload: {
            action: payload.action,
            ...(textLengthBucket ? { textLengthBucket } : {}),
        },
    };
}
export function buildEventChannelDiagnosticsEvent({ event, state, timestamp = event?.timestamp ?? Date.now(), }) {
    return {
        type: "event.channel",
        timestamp,
        payload: {
            ...(event ? { eventType: event.type } : {}),
            ...(state ? { state } : {}),
        },
    };
}
export function buildAdapterLifecycleDiagnosticsEvent({ adapter, lifecycle, payload, timestamp = Date.now(), }) {
    return {
        type: "adapter.lifecycle",
        timestamp,
        payload: {
            ...(payload ?? {}),
            adapter,
            lifecycle,
        },
    };
}
export function buildBackendReadinessDiagnosticsEvent({ backend, payload, ready, timestamp = Date.now(), }) {
    return {
        type: "backend.readiness",
        timestamp,
        payload: {
            ...(payload ?? {}),
            backend,
            ready,
        },
    };
}
export function buildMediaSettleDiagnosticsEvent({ payload, status, timestamp = Date.now(), }) {
    return {
        type: "media.settle",
        timestamp,
        payload: {
            ...(payload ?? {}),
            status,
        },
    };
}
export function classifyRemoteSurfaceInput(payload) {
    if (payload.type === "pointer" && payload.action === "wheel") {
        return "wheel";
    }
    if (payload.type === "clipboard") {
        return "clipboard-paste";
    }
    return payload.type;
}
function notifyDiagnosticsListeners(listeners, event) {
    for (const listener of listeners) {
        listener(event);
    }
}
function redactJsonValue(value, redactKeys, replacement) {
    if (Array.isArray(value)) {
        return value.map((entry) => redactJsonValue(entry, redactKeys, replacement));
    }
    if (value && typeof value === "object") {
        return redactJsonObject(value, redactKeys, replacement);
    }
    if (typeof value === "string" && looksSensitiveString(value)) {
        return replacement;
    }
    return value;
}
function redactJsonObject(value, redactKeys, replacement) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = redactKeys.has(key.toLowerCase()) ? replacement : redactJsonValue(entry, redactKeys, replacement);
    }
    return out;
}
function looksSensitiveString(value) {
    const lower = value.toLowerCase();
    return (lower.startsWith("bearer ") ||
        lower.startsWith("ws://") ||
        lower.startsWith("wss://") ||
        lower.startsWith("http://") ||
        lower.startsWith("https://") ||
        lower.includes("/devtools/browser/") ||
        lower.includes("/json/version") ||
        lower.includes("access_token=") ||
        lower.includes("authorization=") ||
        lower.includes("bearer%20") ||
        lower.includes("docker.sock"));
}
//# sourceMappingURL=index.js.map