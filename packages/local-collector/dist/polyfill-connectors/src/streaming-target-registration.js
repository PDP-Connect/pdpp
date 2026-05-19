const REGISTRATION_PATH = (runId, interactionId) => `/admin/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/streaming-target`;
const ALLOWED_CDP_TARGET_HOSTS = new Set(["127.0.0.1", "localhost", "neko"]);
const defaultLogger = {
    warn(message, data) {
        const suffix = data ? ` ${JSON.stringify(data)}` : "";
        process.stderr.write(`[streaming-registration] ${message}${suffix}\n`);
    },
};
function isAllowedCdpWsUrl(wsUrl) {
    let parsed;
    try {
        parsed = new URL(wsUrl);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return false;
    }
    return ALLOWED_CDP_TARGET_HOSTS.has(parsed.hostname);
}
function isDescriptorObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function addOptionalMetadata(body, { pageUrl, pageTitle, reason }) {
    if (typeof pageUrl === "string" && pageUrl.length > 0) {
        body.page_url = pageUrl;
    }
    if (typeof pageTitle === "string" && pageTitle.length > 0) {
        body.page_title = pageTitle;
    }
    if (typeof reason === "string" && reason.length > 0) {
        body.reason = reason;
    }
}
export function createRegistrationClient(options) {
    if (!options.baseUrl) {
        throw new Error("createRegistrationClient: baseUrl required");
    }
    if (!options.deviceToken) {
        throw new Error("createRegistrationClient: deviceToken required");
    }
    const baseUrl = new URL(options.baseUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const logger = options.logger ?? defaultLogger;
    const authHeader = `Bearer ${options.deviceToken}`;
    if (typeof fetchImpl !== "function") {
        throw new Error("createRegistrationClient: no fetch implementation available");
    }
    return {
        async register(args) {
            const { runId, interactionId } = args;
            if (!runId) {
                logger.warn("register skipped: runId is empty");
                return false;
            }
            if (!interactionId) {
                logger.warn("register skipped: interactionId is empty", { runId });
                return false;
            }
            let method;
            let body;
            if (args.backend === "neko") {
                if (!isDescriptorObject(args.descriptor)) {
                    logger.warn("register skipped: neko descriptor is not an object", { runId, interactionId });
                    return false;
                }
                method = "POST";
                body = { backend: "neko", descriptor: args.descriptor };
            }
            else {
                const { wsUrl } = args;
                if (!isAllowedCdpWsUrl(wsUrl)) {
                    logger.warn("register skipped: wsUrl host is not allowed", { runId, interactionId });
                    return false;
                }
                method = "PUT";
                body = { ws_url: wsUrl };
            }
            addOptionalMetadata(body, args);
            let response;
            try {
                response = await fetchImpl(new URL(REGISTRATION_PATH(runId, interactionId), baseUrl), {
                    method,
                    headers: {
                        accept: "application/json",
                        authorization: authHeader,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify(body),
                });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn("register failed (network error)", { runId, interactionId, error: message });
                return false;
            }
            if (!response.ok) {
                await response.text().catch(() => undefined);
                logger.warn("register failed", { runId, interactionId, status: response.status });
                return false;
            }
            await response.text().catch(() => undefined);
            return true;
        },
        async unregister({ runId, interactionId }) {
            if (!(runId && interactionId)) {
                return false;
            }
            let response;
            try {
                response = await fetchImpl(new URL(REGISTRATION_PATH(runId, interactionId), baseUrl), {
                    method: "DELETE",
                    headers: {
                        accept: "application/json",
                        authorization: authHeader,
                    },
                });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.warn("unregister failed (network error)", { runId, interactionId, error: message });
                return false;
            }
            if (!response.ok) {
                await response.text().catch(() => undefined);
                if (response.status !== 404) {
                    logger.warn("unregister failed", { runId, interactionId, status: response.status });
                }
                return false;
            }
            await response.text().catch(() => undefined);
            return true;
        },
    };
}
export { ALLOWED_CDP_TARGET_HOSTS, REGISTRATION_PATH };
const STREAMING_REGISTRATION_TOKEN_ENV = "PDPP_STREAMING_REGISTRATION_TOKEN";
const LOCAL_DEVICE_TOKEN_ENV = "PDPP_LOCAL_DEVICE_TOKEN";
export function resolveStreamingRegistrationFromEnv(env = process.env) {
    const runId = env.PDPP_RUN_ID?.trim();
    const baseUrl = env.PDPP_REFERENCE_BASE_URL?.trim();
    const registrationToken = env[STREAMING_REGISTRATION_TOKEN_ENV]?.trim();
    const deviceToken = env[LOCAL_DEVICE_TOKEN_ENV]?.trim();
    const bearerToken = registrationToken || deviceToken;
    if (!(runId && baseUrl && bearerToken)) {
        if (runId && !(baseUrl && bearerToken)) {
            process.stderr.write("[streaming-registration] PDPP_RUN_ID set but PDPP_REFERENCE_BASE_URL or " +
                `${STREAMING_REGISTRATION_TOKEN_ENV}/${LOCAL_DEVICE_TOKEN_ENV} missing; ` +
                "streaming-companion target not registered for this run.\n");
        }
        return Promise.resolve(undefined);
    }
    const client = createRegistrationClient({ baseUrl, deviceToken: bearerToken });
    return Promise.resolve({
        runId,
        register: (args) => client.register(args),
        unregister: (args) => client.unregister(args),
    });
}
export { LOCAL_DEVICE_TOKEN_ENV, STREAMING_REGISTRATION_TOKEN_ENV };
