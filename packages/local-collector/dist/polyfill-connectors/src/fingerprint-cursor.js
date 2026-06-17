import { createHash } from "node:crypto";
export function openCarryForwardCursor(prior) {
    const next = new Map(prior);
    const seen = new Set();
    return {
        prior(id) {
            return prior.get(id);
        },
        note(id, value) {
            next.set(id, value);
            seen.add(id);
        },
        pruneStale() {
            for (const id of next.keys()) {
                if (!seen.has(id)) {
                    next.delete(id);
                }
            }
        },
        size() {
            return next.size;
        },
        toState() {
            const out = {};
            for (const [id, value] of next) {
                out[id] = value;
            }
            return out;
        },
    };
}
export function recordFingerprint(record, excludeKeys = []) {
    const exclude = new Set(excludeKeys);
    return createHash("sha1").update(stableStringify(record, exclude)).digest("hex");
}
export function openFingerprintCursor(priorState, options = {}) {
    const staticExcludeKeys = options.excludeFromFingerprint ?? [];
    const resolveExcludeKeys = options.resolveExcludeFromFingerprint;
    const prior = options.priorFingerprints ?? decodePriorFingerprints(priorState);
    const cursor = openCarryForwardCursor(prior);
    return {
        shouldEmit(data) {
            const rawId = data.id;
            if (rawId == null) {
                return true;
            }
            const id = String(rawId);
            if (id.length === 0) {
                return true;
            }
            const record = data;
            const excludeKeys = resolveExcludeKeys ? resolveExcludeKeys(record) : staticExcludeKeys;
            const fingerprint = recordFingerprint(record, excludeKeys);
            cursor.note(id, fingerprint);
            return cursor.prior(id) !== fingerprint;
        },
        priorFingerprint(id) {
            return cursor.prior(id);
        },
        pruneStale() {
            cursor.pruneStale();
        },
        toState() {
            return cursor.toState();
        },
        size() {
            return cursor.size();
        },
    };
}
function decodePriorFingerprints(priorState) {
    const out = new Map();
    if (!priorState || typeof priorState !== "object" || Array.isArray(priorState)) {
        return out;
    }
    const raw = priorState.fingerprints;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return out;
    }
    for (const [id, value] of Object.entries(raw)) {
        if (typeof value === "string" && value.length > 0) {
            out.set(id, value);
        }
    }
    return out;
}
function compareKeys(a, b) {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}
function stableStringify(value, exclude) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringify(v, exclude)).join(",")}]`;
    }
    const entries = Object.entries(value)
        .filter(([k]) => !exclude.has(k))
        .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, exclude)}`).join(",")}}`;
}
