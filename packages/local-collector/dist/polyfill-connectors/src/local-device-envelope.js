import { createHash } from "node:crypto";
export function canonicalJson(value) {
    return JSON.stringify(toCanonicalValue(value));
}
export function hashCanonicalJson(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function buildLocalDeviceRecordEnvelope(input) {
    const body = {
        connector_id: input.connectorId,
        data: toNormalizedRecordData(input.record.data),
        emitted_at: input.record.emitted_at,
        record_key: String(input.record.key),
        stream: input.record.stream,
    };
    return {
        batch_id: input.batchId,
        batch_seq: input.batchSeq,
        body_hash: hashCanonicalJson(body),
        device_id: input.deviceId,
        source_instance_id: input.sourceInstanceId,
        ...body,
    };
}
function toCanonicalValue(value) {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => toCanonicalValue(item));
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item !== undefined) {
            out[key] = toCanonicalValue(item);
        }
    }
    return out;
}
function toNormalizedRecordData(data) {
    return toCanonicalValue(data);
}
