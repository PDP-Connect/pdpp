export function resourceSet(streamRequest) {
    if (!(streamRequest && Array.isArray(streamRequest.resources) && streamRequest.resources.length)) {
        return null;
    }
    const s = new Set();
    for (const r of streamRequest.resources) {
        s.add(String(r));
    }
    return s;
}
export function passesResourceFilter(resSet, primaryKey) {
    if (!resSet) {
        return true;
    }
    const canonical = Array.isArray(primaryKey) ? JSON.stringify(primaryKey.map(String)) : String(primaryKey);
    return resSet.has(canonical);
}
export function passesTimeRange(isoValue, timeRange) {
    if (!timeRange) {
        return true;
    }
    if (!isoValue) {
        return true;
    }
    if (timeRange.since && isoValue < timeRange.since) {
        return false;
    }
    if (timeRange.until && isoValue >= timeRange.until) {
        return false;
    }
    return true;
}
export function makeEmitGate(emitRecord, streamRequest, { consentTimeField } = {}) {
    const resSet = resourceSet(streamRequest);
    const emitted = new Set();
    const gate = ((stream, data, keyField = "id") => {
        const key = data[keyField];
        if (key == null) {
            return false;
        }
        const canonical = Array.isArray(key) ? JSON.stringify(key.map(String)) : String(key);
        if (resSet && !resSet.has(canonical)) {
            return false;
        }
        if (consentTimeField && streamRequest?.time_range) {
            const v = data[consentTimeField];
            const iso = typeof v === "string" ? v : undefined;
            if (!passesTimeRange(iso, streamRequest.time_range)) {
                return false;
            }
        }
        emitted.add(canonical);
        emitRecord(stream, data);
        return true;
    });
    gate.emittedSet = () => emitted;
    return gate;
}
export function emitTombstones({ emit, stream, priorIds, currentIds, emittedAt }) {
    let count = 0;
    for (const id of priorIds || []) {
        if (!currentIds.has(id)) {
            emit({
                type: "RECORD",
                stream,
                key: id,
                data: { id },
                emitted_at: emittedAt,
                op: "delete",
            });
            count++;
        }
    }
    return count;
}
export async function requireCredentialsOrAsk({ required, connectorName, sendInteraction, }) {
    const { resolveAuth } = await import("./auth.js");
    const ctx = { sendInteraction, connectorName };
    return resolveAuth({ kind: "env", required }, ctx);
}
