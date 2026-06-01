import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLECTOR_PROTOCOL_VERSION as PROTOCOL_VERSION, COLLECTOR_RUNTIME_CAPABILITIES as POLYFILL_COLLECTOR_RUNTIME_CAPABILITIES, } from "../../polyfill-connectors/src/runner/index.js";
export { buildCollectorStartMessage, COLLECTOR_COVERAGE_STATUSES, COLLECTOR_PROTOCOL_VERSION, CollectorStateReadError, drainCollectorQueue, emitToStdout, enrollCollector, evaluatePlacement, isMainModule, LocalDeviceClient, LocalDeviceHttpError, LocalDeviceOutbox, LocalDeviceQueue, PROVIDER_RUNTIME_CAPABILITIES, RUNTIME_CAPABILITY_MISMATCH_CODE, RuntimeCapabilityMismatchError, assertPlacementOrThrow, buildLocalDeviceRecordEnvelope, buildLocalDeviceOutboxId, canonicalJson, diffRequiredBindings, hashCanonicalJson, parseJsonlLine, resourceSet, runCollectorConnector, stringifyForJsonl, summarizeCollectorCompleteness, transformRecordsToCollectorEnvelopes, } from "../../polyfill-connectors/src/runner/index.js";
export const COLLECTOR_RUNTIME_CAPABILITIES = {
    id: POLYFILL_COLLECTOR_RUNTIME_CAPABILITIES.id,
    bindings: new Set(["network", "filesystem", "local_device"]),
};
function bundledEntry(connectorPath) {
    const built = fileURLToPath(new URL(`../../polyfill-connectors/connectors/${connectorPath}/index.js`, import.meta.url));
    if (existsSync(built)) {
        return built;
    }
    return fileURLToPath(new URL(`../../polyfill-connectors/connectors/${connectorPath}/index.ts`, import.meta.url));
}
function commandForEntry(entry) {
    return extname(entry) === ".ts" ? "tsx" : "node";
}
const POLYFILL_CLAUDE_CODE_ENTRY = bundledEntry("claude_code");
const POLYFILL_CODEX_ENTRY = bundledEntry("codex");
export const BUNDLED_CONNECTORS = Object.freeze({
    claude_code: Object.freeze({
        connector_id: "claude_code",
        command: commandForEntry(POLYFILL_CLAUDE_CODE_ENTRY),
        args: Object.freeze([POLYFILL_CLAUDE_CODE_ENTRY]),
        bindings: Object.freeze({ filesystem: Object.freeze({ required: true }) }),
        streams: Object.freeze([
            "sessions",
            "messages",
            "attachments",
            "memory_notes",
            "skills",
            "slash_commands",
        ]),
    }),
    codex: Object.freeze({
        connector_id: "codex",
        command: commandForEntry(POLYFILL_CODEX_ENTRY),
        args: Object.freeze([POLYFILL_CODEX_ENTRY]),
        bindings: Object.freeze({ filesystem: Object.freeze({ required: true }) }),
        streams: Object.freeze([
            "sessions",
            "messages",
            "function_calls",
            "rules",
            "prompts",
            "skills",
        ]),
    }),
});
export const BUNDLED_CONNECTOR_IDS = Object.freeze(Object.keys(BUNDLED_CONNECTORS));
export function getBundledConnector(connectorId) {
    return BUNDLED_CONNECTORS[connectorId] ?? null;
}
export const BUNDLED_CONNECTOR_VERSIONS = Object.freeze({
    claude_code: PROTOCOL_VERSION,
    codex: PROTOCOL_VERSION,
});
