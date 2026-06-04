import { COLLECTOR_PROTOCOL_HEADER, COLLECTOR_PROTOCOL_VERSION } from "./collector-protocol.js";
export const LOCAL_DEVICE_ENDPOINTS = {
    exchangeEnrollment: "/_ref/device-exporters/enroll",
    heartbeat: (deviceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
    ingestBatch: (deviceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
    localCollectorGap: (deviceId, sourceInstanceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/local-collector-gaps`,
    localCollectorGapRecovered: (deviceId, sourceInstanceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/local-collector-gaps/recovered`,
    sourceInstanceState: (deviceId, sourceInstanceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/state`,
};
export const DEFAULT_LOCAL_DEVICE_REQUEST_TIMEOUT_MS = 120_000;
export class LocalDeviceHttpError extends Error {
    body;
    envelopeMessage;
    param;
    status;
    code;
    constructor(status, body) {
        const parsed = parseLocalDeviceErrorEnvelope(body);
        const detail = formatLocalDeviceErrorDetail(parsed);
        super(`local device request failed: ${status}${detail}`);
        this.name = "LocalDeviceHttpError";
        this.status = status;
        this.body = body;
        this.code = parsed?.code ?? null;
        this.param = parsed?.param ?? null;
        this.envelopeMessage = parsed?.message ?? null;
    }
}
function parseLocalDeviceErrorEnvelope(body) {
    if (!body) {
        return null;
    }
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error.code === "string") {
            return {
                code: parsed.error.code,
                message: typeof parsed.error.message === "string" ? sanitizeErrorDetail(parsed.error.message) : null,
                param: typeof parsed.error.param === "string" ? sanitizeErrorDetail(parsed.error.param) : null,
            };
        }
    }
    catch {
    }
    return null;
}
function formatLocalDeviceErrorDetail(parsed) {
    if (!parsed) {
        return "";
    }
    const parts = [parsed.code];
    if (parsed.param) {
        parts.push(`param=${parsed.param}`);
    }
    if (parsed.message) {
        parts.push(`message=${parsed.message}`);
    }
    return ` ${parts.join(" ")}`;
}
const ERROR_DETAIL_SECRET_RE = /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;
function sanitizeErrorDetail(value) {
    const compact = value.replace(ERROR_DETAIL_SECRET_RE, "$1=[REDACTED]").replace(/\s+/g, " ").trim();
    return compact.length > 160 ? `${compact.slice(0, 159)}…` : compact;
}
export class LocalDeviceRequestTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`local device request timed out after ${timeoutMs}ms`);
        this.name = "LocalDeviceRequestTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}
export class LocalDeviceClient {
    #baseUrl;
    #deviceId;
    #deviceToken;
    #fetch;
    #requestTimeoutMs;
    constructor(options) {
        this.#baseUrl = new URL(options.baseUrl);
        this.#deviceId = options.deviceId;
        this.#deviceToken = options.deviceToken;
        this.#fetch = options.fetchImpl ?? fetch;
        this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LOCAL_DEVICE_REQUEST_TIMEOUT_MS;
    }
    exchangeEnrollment(request) {
        return this.#request(LOCAL_DEVICE_ENDPOINTS.exchangeEnrollment, {
            authenticate: false,
            body: request,
            method: "POST",
        });
    }
    heartbeat(request) {
        return this.#request(LOCAL_DEVICE_ENDPOINTS.heartbeat(this.#requireDeviceId()), {
            authenticate: true,
            body: request,
            method: "POST",
        });
    }
    ingestBatch(request) {
        return this.#request(LOCAL_DEVICE_ENDPOINTS.ingestBatch(this.#requireDeviceId()), {
            authenticate: true,
            body: request,
            method: "POST",
        });
    }
    getSourceInstanceState(request) {
        const path = LOCAL_DEVICE_ENDPOINTS.sourceInstanceState(this.#requireDeviceId(), request.sourceInstanceId);
        return this.#request(path, { authenticate: true, method: "GET" });
    }
    putSourceInstanceState(request) {
        const path = LOCAL_DEVICE_ENDPOINTS.sourceInstanceState(this.#requireDeviceId(), request.sourceInstanceId);
        return this.#request(path, {
            authenticate: true,
            body: { state: request.state },
            method: "PUT",
        });
    }
    ackLocalCollectorGap(request) {
        const path = LOCAL_DEVICE_ENDPOINTS.localCollectorGap(this.#requireDeviceId(), request.source_instance_id);
        return this.#request(path, {
            authenticate: true,
            body: request,
            method: "POST",
        });
    }
    recoverLocalCollectorGap(request) {
        const path = LOCAL_DEVICE_ENDPOINTS.localCollectorGapRecovered(this.#requireDeviceId(), request.source_instance_id);
        return this.#request(path, {
            authenticate: true,
            body: request,
            method: "POST",
        });
    }
    #requireDeviceId() {
        if (!this.#deviceId) {
            throw new Error("device id required for authenticated local device request");
        }
        return this.#deviceId;
    }
    async #request(path, options) {
        const headers = {
            accept: "application/json",
            [COLLECTOR_PROTOCOL_HEADER]: COLLECTOR_PROTOCOL_VERSION,
        };
        if (options.body !== undefined) {
            headers["content-type"] = "application/json";
        }
        if (options.authenticate) {
            if (!this.#deviceToken) {
                throw new Error("device token required for authenticated local device request");
            }
            headers.authorization = `Bearer ${this.#deviceToken}`;
        }
        const init = { headers, method: options.method };
        if (options.body !== undefined) {
            init.body = JSON.stringify(options.body);
        }
        const controller = this.#requestTimeoutMs > 0 ? new AbortController() : null;
        const timer = controller
            ? setTimeout(() => controller.abort(new LocalDeviceRequestTimeoutError(this.#requestTimeoutMs)), this.#requestTimeoutMs)
            : null;
        if (controller) {
            init.signal = controller.signal;
        }
        try {
            const response = await this.#fetch(new URL(path, this.#baseUrl), init);
            const text = await response.text();
            if (!response.ok) {
                throw new LocalDeviceHttpError(response.status, text);
            }
            if (!text) {
                return { ok: true };
            }
            return JSON.parse(text);
        }
        catch (error) {
            if (controller?.signal.aborted) {
                const reason = controller.signal.reason;
                throw reason instanceof LocalDeviceRequestTimeoutError
                    ? reason
                    : new LocalDeviceRequestTimeoutError(this.#requestTimeoutMs);
            }
            throw error;
        }
        finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
}
