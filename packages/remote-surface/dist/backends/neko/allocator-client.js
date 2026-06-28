import { BROWSER_SURFACE_BACKEND_NEKO, } from "../../leases/index.js";
const DEFAULT_ALLOCATOR_TIMEOUT_MS = 5000;
const VALID_HEALTH = new Set(["starting", "ready", "unhealthy", "stopping"]);
export class NekoSurfaceAllocatorError extends Error {
    code;
    status;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "NekoSurfaceAllocatorError";
        this.code = code;
        if (options.status !== undefined) {
            this.status = options.status;
        }
    }
}
export class NekoSurfaceAllocatorClient {
    #baseUrl;
    #fetch;
    #timeoutMs;
    constructor(options) {
        this.#baseUrl = normalizeBaseUrl(options.baseUrl);
        this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_ALLOCATOR_TIMEOUT_MS;
        if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
            throw new Error("n.eko allocator timeoutMs must be a positive integer");
        }
    }
    async ensureSurface(request) {
        const body = {
            surface_id: request.surfaceId,
            connector_id: request.connectorId,
            profile_key: request.profileKey,
        };
        if (request.surfaceSubjectId !== undefined) {
            body.surface_subject_id = request.surfaceSubjectId;
        }
        if (request.accountKey !== undefined) {
            body.account_key = request.accountKey;
        }
        const payload = await this.#requestJson("surfaces", {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
        });
        return parseSurfaceEnvelope(payload, "ensure surface response");
    }
    async getSurfaceStatus(surfaceId) {
        const payload = await this.#requestJson(`surfaces/${encodeURIComponent(surfaceId)}`, { method: "GET" }, { nullOn404: true });
        return payload === null ? null : parseSurfaceEnvelope(payload, "surface status response");
    }
    async stopSurface(request) {
        const payload = await this.#requestJson(`surfaces/${encodeURIComponent(request.surfaceId)}`, {
            method: "DELETE",
            body: JSON.stringify({ reason: request.reason }),
            headers: { "content-type": "application/json" },
        }, { nullOn404: true });
        return payload === null ? null : parseSurfaceEnvelope(payload, "stop surface response");
    }
    async listSurfaces() {
        const payload = await this.#requestJson("surfaces", { method: "GET" });
        return parseSurfaceListEnvelope(payload);
    }
    async #requestJson(path, init, options = {}) {
        const url = new URL(path, this.#baseUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
        try {
            const response = await this.#fetch(url, { ...init, signal: controller.signal });
            if (options.nullOn404 === true && response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw new NekoSurfaceAllocatorError("allocator_http_error", `n.eko allocator ${init.method ?? "GET"} ${url.pathname} failed with HTTP ${response.status}`, { status: response.status });
            }
            try {
                return (await response.json());
            }
            catch (cause) {
                throw new NekoSurfaceAllocatorError("allocator_malformed_response", `n.eko allocator ${init.method ?? "GET"} ${url.pathname} returned invalid JSON`, { cause });
            }
        }
        catch (cause) {
            if (cause instanceof NekoSurfaceAllocatorError) {
                throw cause;
            }
            if (controller.signal.aborted || isAbortError(cause)) {
                throw new NekoSurfaceAllocatorError("allocator_timeout", `n.eko allocator ${init.method ?? "GET"} ${url.pathname} timed out after ${String(this.#timeoutMs)}ms`, { cause });
            }
            throw new NekoSurfaceAllocatorError("allocator_fetch_error", `n.eko allocator ${init.method ?? "GET"} ${url.pathname} request failed`, { cause });
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
export function createNekoSurfaceAllocatorClient(options) {
    return new NekoSurfaceAllocatorClient(options);
}
function normalizeBaseUrl(value) {
    const url = new URL(value);
    if (!url.pathname.endsWith("/")) {
        url.pathname = `${url.pathname}/`;
    }
    return url;
}
function parseSurfaceEnvelope(value, label) {
    if (isRecord(value) && "surface" in value) {
        return parseBrowserSurface(value.surface, label);
    }
    return parseBrowserSurface(value, label);
}
function parseSurfaceListEnvelope(value) {
    if (!isRecord(value)) {
        throw malformed("surface list response must contain a surfaces array");
    }
    if (!Array.isArray(value.surfaces)) {
        throw malformed("surface list response must contain a surfaces array");
    }
    return value.surfaces.map((surface, index) => parseBrowserSurface(surface, `surface list response at index ${String(index)}`));
}
function parseBrowserSurface(value, label) {
    if (!isRecord(value)) {
        throw malformed(`${label} must be an object`);
    }
    const surface = {
        surface_id: requiredString(value, "surface_id", label),
        backend: parseBackend(value.backend, label),
        profile_key: requiredString(value, "profile_key", label),
        connector_id: requiredString(value, "connector_id", label),
        cdp_url: parseUrlString(value.cdp_url, "cdp_url", label),
        stream_base_url: parseUrlString(value.stream_base_url, "stream_base_url", label),
        health: parseHealth(value.health, label),
        created_at: parseIsoString(value.created_at, "created_at", label),
        last_used_at: parseIsoString(value.last_used_at, "last_used_at", label),
    };
    const accountKey = optionalString(value.account_key, "account_key", label);
    if (accountKey !== undefined) {
        surface.account_key = accountKey;
    }
    const surfaceSubjectId = optionalString(value.surface_subject_id, "surface_subject_id", label);
    if (surfaceSubjectId !== undefined) {
        surface.surface_subject_id = surfaceSubjectId;
    }
    const activeLeaseId = optionalString(value.active_lease_id, "active_lease_id", label);
    if (activeLeaseId !== undefined) {
        surface.active_lease_id = activeLeaseId;
    }
    const containerId = optionalString(value.container_id, "container_id", label);
    if (containerId !== undefined) {
        surface.container_id = containerId;
    }
    const allocatorMetadata = parseMetadata(value.allocator_metadata, label);
    if (allocatorMetadata !== undefined) {
        surface.allocator_metadata = allocatorMetadata;
    }
    return surface;
}
function parseBackend(value, label) {
    if (value !== BROWSER_SURFACE_BACKEND_NEKO) {
        throw malformed(`${label} has unsupported backend`);
    }
    return BROWSER_SURFACE_BACKEND_NEKO;
}
function parseHealth(value, label) {
    if (typeof value !== "string" || !VALID_HEALTH.has(value)) {
        throw malformed(`${label} has unsupported health`);
    }
    return value;
}
function requiredString(value, key, label) {
    const parsed = optionalString(value[key], key, label);
    if (parsed === undefined) {
        throw malformed(`${label} is missing ${key}`);
    }
    return parsed;
}
function optionalString(value, key, label) {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "string" || value.length === 0) {
        throw malformed(`${label} has invalid ${key}`);
    }
    return value;
}
function parseUrlString(value, key, label) {
    const parsed = requiredString({ [key]: value }, key, label);
    try {
        new URL(parsed);
    }
    catch (cause) {
        throw malformed(`${label} has invalid ${key}`, cause);
    }
    return parsed;
}
function parseIsoString(value, key, label) {
    const parsed = requiredString({ [key]: value }, key, label);
    if (Number.isNaN(Date.parse(parsed))) {
        throw malformed(`${label} has invalid ${key}`);
    }
    return parsed;
}
function parseMetadata(value, label) {
    if (value === undefined) {
        return;
    }
    if (!isRecord(value)) {
        throw malformed(`${label} has invalid allocator_metadata`);
    }
    const metadata = {};
    for (const [key, metadataValue] of Object.entries(value)) {
        if (typeof metadataValue !== "string") {
            throw malformed(`${label} has invalid allocator_metadata.${key}`);
        }
        metadata[key] = metadataValue;
    }
    return metadata;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAbortError(value) {
    return value instanceof DOMException && value.name === "AbortError";
}
function malformed(message, cause) {
    return new NekoSurfaceAllocatorError("allocator_malformed_response", `malformed n.eko allocator response: ${message}`, cause === undefined ? {} : { cause });
}
//# sourceMappingURL=allocator-client.js.map