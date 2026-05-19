import { COLLECTOR_PROTOCOL_HEADER, COLLECTOR_PROTOCOL_VERSION } from "./collector-protocol.js";
export const LOCAL_DEVICE_ENDPOINTS = {
    exchangeEnrollment: "/_ref/device-exporters/enroll",
    heartbeat: (deviceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
    ingestBatch: (deviceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
    sourceInstanceState: (deviceId, sourceInstanceId) => `/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/state`,
};
export class LocalDeviceHttpError extends Error {
    body;
    status;
    constructor(status, body) {
        super(`local device request failed: ${status}`);
        this.name = "LocalDeviceHttpError";
        this.status = status;
        this.body = body;
    }
}
export class LocalDeviceClient {
    #baseUrl;
    #deviceId;
    #deviceToken;
    #fetch;
    constructor(options) {
        this.#baseUrl = new URL(options.baseUrl);
        this.#deviceId = options.deviceId;
        this.#deviceToken = options.deviceToken;
        this.#fetch = options.fetchImpl ?? fetch;
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
}
