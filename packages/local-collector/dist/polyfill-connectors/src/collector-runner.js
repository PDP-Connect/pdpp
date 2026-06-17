import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildAgentVersion } from "./collector-build-info.js";
import { LocalDeviceClient, } from "./local-device-client.js";
import { buildLocalDeviceRecordEnvelope, hashCanonicalJson, } from "./local-device-envelope.js";
import { buildLocalDeviceOutboxId, LocalDeviceOutbox, } from "./local-device-outbox.js";
import { assertPlacementOrThrow, COLLECTOR_RUNTIME_CAPABILITIES, } from "./runtime-capabilities.js";
const COLLECTOR_AGENT_VERSION = buildAgentVersion();
export const COLLECTOR_STDERR_MAX_BYTES = 256 * 1024;
const COLLECTOR_GAP_DETAILS_MAX_CHARS = 300;
const KEYED_SECRET_RE = /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;
const OTP_RE = /\b\d{6}\b/g;
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const SCAN_BATCH_LIMIT_DETAIL_RE = /enqueued\s+\d+\s+batches\s+>=\s+(?:run batch limit|(?:maxEnqueuedBatchesPerRun|\[REDACTED\]))\s+(\d+)/;
const CONNECTOR_PROTOCOL_DEBUG_DIR_ENV = "PDPP_DEBUG_CONNECTOR_PROTOCOL_DIR";
export const DEFAULT_COLLECTOR_OUTBOX_POLICY = Object.freeze({
    drainBatchSize: 4,
    leaseMs: 300_000,
    maxAttempts: 5,
    maxDrainDurationMs: 120_000,
    maxDrainIterations: 256,
    maxEnqueuedBatchesPerRun: 10_000,
    maxQueueDepth: 10_000,
    retryBackoffMs: 30_000,
});
export const DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY = Object.freeze({
    enabled: true,
    keepRecentCount: 10_000,
});
export function resolveCollectorAutoPrunePolicy(override, env = process.env) {
    const policy = { ...DEFAULT_COLLECTOR_AUTO_PRUNE_POLICY, ...(override ?? {}) };
    const enabledRaw = env.PDPP_COLLECTOR_AUTO_PRUNE;
    if (typeof enabledRaw === "string" && enabledRaw.trim() !== "") {
        policy.enabled = !DISABLED_ENV_VALUES.has(enabledRaw.trim().toLowerCase());
    }
    const keepCount = parseNonNegativeInt(env.PDPP_COLLECTOR_AUTO_PRUNE_KEEP_COUNT);
    if (keepCount !== null) {
        policy.keepRecentCount = keepCount;
    }
    return policy;
}
const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no"]);
function parseNonNegativeInt(raw) {
    if (typeof raw !== "string" || raw.trim() === "") {
        return null;
    }
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function autoPruneSucceededOutbox(input) {
    if (!input.policy.enabled) {
        return { enabled: false, matched: 0, pruned: 0 };
    }
    const result = input.outbox.pruneSent({
        dryRun: false,
        keepCount: input.policy.keepRecentCount,
        sourceInstanceId: input.sourceInstanceId,
    });
    return { enabled: true, matched: result.matched, pruned: result.pruned };
}
export const DEFAULT_COLLECTOR_AUTO_COMPACT_POLICY = Object.freeze({
    enabled: true,
    minReclaimableBytes: 512 * 1024 * 1024,
});
export function resolveCollectorAutoCompactPolicy(override, env = process.env) {
    const policy = { ...DEFAULT_COLLECTOR_AUTO_COMPACT_POLICY, ...(override ?? {}) };
    const enabledRaw = env.PDPP_COLLECTOR_AUTO_COMPACT;
    if (typeof enabledRaw === "string" && enabledRaw.trim() !== "") {
        policy.enabled = !DISABLED_ENV_VALUES.has(enabledRaw.trim().toLowerCase());
    }
    const minBytes = parseNonNegativeInt(env.PDPP_COLLECTOR_AUTO_COMPACT_MIN_RECLAIM_BYTES);
    if (minBytes !== null) {
        policy.minReclaimableBytes = minBytes;
    }
    return policy;
}
export function autoCompactOutboxIfBloated(input) {
    if (!input.policy.enabled) {
        return { compacted: false, enabled: false, reason: "disabled", reclaimedBytes: 0 };
    }
    const before = input.outbox.pageStats();
    if (before.reclaimableBytes < input.policy.minReclaimableBytes) {
        return { compacted: false, enabled: true, reason: "below_threshold", reclaimedBytes: 0 };
    }
    if (input.outbox.countNonSucceeded() > 0) {
        return { compacted: false, enabled: true, reason: "lane_not_quiet", reclaimedBytes: 0 };
    }
    const result = input.outbox.compact();
    return { compacted: true, enabled: true, reason: "compacted", reclaimedBytes: result.reclaimedBytes };
}
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
export async function enrollCollector(config) {
    const client = new LocalDeviceClient({ baseUrl: config.baseUrl });
    return await client.exchangeEnrollment({
        enrollment_code: config.code,
        ...(config.deviceLabel ? { deviceLabel: config.deviceLabel } : {}),
    });
}
export const COLLECTOR_COVERAGE_STATUSES = [
    "collected",
    "inventory_only",
    "excluded",
    "deferred",
    "missing",
    "unsupported",
    "unaccounted",
];
export class CollectorStateReadError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = "CollectorStateReadError";
    }
}
export async function runCollectorConnector(config) {
    throwIfAborted(config.abortSignal);
    const satisfiedBindings = assertPlacementOrThrow(config.connector, COLLECTOR_RUNTIME_CAPABILITIES);
    const policy = { ...DEFAULT_COLLECTOR_OUTBOX_POLICY, ...(config.outboxPolicy ?? {}) };
    const autoPrunePolicy = resolveCollectorAutoPrunePolicy(config.autoPrune);
    const autoCompactPolicy = resolveCollectorAutoCompactPolicy(config.autoCompact);
    const holderId = config.collectorHolderId ?? randomUUID();
    const outboxPath = config.outboxPath ?? config.queuePath;
    const outbox = new LocalDeviceOutbox({ path: outboxPath });
    const client = new LocalDeviceClient({
        baseUrl: config.baseUrl,
        deviceId: config.deviceId,
        deviceToken: config.deviceToken,
    });
    let startingHeartbeatSent = false;
    try {
        const recoveredLeases = outbox.recoverExpiredLeases({ sourceInstanceId: config.sourceInstanceId });
        const preScanDrain = await drainCollectorOutbox({
            ...(config.abortSignal ? { abortSignal: config.abortSignal } : {}),
            client,
            connectorId: config.connector.connector_id,
            holderId,
            outbox,
            policy,
            sourceInstanceId: config.sourceInstanceId,
        });
        const postDrainSummary = outbox.summary({ sourceInstanceId: config.sourceInstanceId });
        const skipResult = await maybeSkipScanForBacklog({
            autoPrunePolicy,
            client,
            config,
            outbox,
            policy,
            postDrainSummary,
            preScanDrain,
            recoveredLeases,
            satisfiedBindings,
        });
        if (skipResult) {
            return skipResult;
        }
        const priorState = await readPriorStateOrBlock({
            client,
            config,
            recordsPending: pendingOutboxWorkCount(postDrainSummary),
        });
        await client.heartbeat({
            agent_version: COLLECTOR_AGENT_VERSION,
            connector_id: config.connector.connector_id,
            outbox: buildHeartbeatOutboxDiagnostics(postDrainSummary, {
                backlogOpen: countOpenBacklogGaps(outbox, config.sourceInstanceId),
            }),
            records_pending: pendingOutboxWorkCount(postDrainSummary),
            source_instance_id: config.sourceInstanceId,
            status: "starting",
        });
        startingHeartbeatSent = true;
        const streamResult = await streamConnectorIntoOutbox({
            ...(config.abortSignal ? { abortSignal: config.abortSignal } : {}),
            batchSize: config.batchSize ?? 100,
            config,
            outbox,
            policy,
            priorState,
        });
        const done = streamResult.done;
        const bufferedState = streamResult.bufferedState;
        const enqueueResult = {
            enqueuedBatches: streamResult.enqueuedBatches,
            recordsQueued: streamResult.recordsQueued,
        };
        const recordDrain = await drainCollectorOutbox({
            ...(config.abortSignal ? { abortSignal: config.abortSignal } : {}),
            client,
            connectorId: config.connector.connector_id,
            holderId,
            outbox,
            policy,
            sourceInstanceId: config.sourceInstanceId,
        });
        const afterRecordsSummary = outbox.summary({ sourceInstanceId: config.sourceInstanceId });
        const checkpointResult = await maybeCommitCheckpoint({
            afterRecordsSummary,
            bufferedState,
            client,
            config,
            holderId,
            outbox,
            policy,
        });
        await recoverResolvedLocalCollectorGaps({
            client,
            config,
            deferRecoveredGapCleanup: streamResult.scanBudgetExceeded,
            outbox,
        });
        const prunedSent = autoPruneSucceededOutbox({
            outbox,
            policy: autoPrunePolicy,
            sourceInstanceId: config.sourceInstanceId,
        });
        autoCompactOutboxIfBloated({ outbox, policy: autoCompactPolicy });
        const finalSummary = outbox.summary({ sourceInstanceId: config.sourceInstanceId });
        const recordsPending = pendingOutboxWorkCount(finalSummary);
        if (!checkpointResult.statePutFailed) {
            const finalDeadLetterError = buildHeartbeatDeadLetterError(outbox, config.sourceInstanceId);
            await client.heartbeat({
                agent_version: COLLECTOR_AGENT_VERSION,
                connector_id: config.connector.connector_id,
                ...(finalDeadLetterError ? { last_error: finalDeadLetterError } : {}),
                outbox: buildHeartbeatOutboxDiagnostics(finalSummary, {
                    backlogOpen: countOpenBacklogGaps(outbox, config.sourceInstanceId),
                }),
                records_pending: recordsPending,
                source_instance_id: config.sourceInstanceId,
                status: streamResult.scanBudgetExceeded ? "retrying" : heartbeatStatusForSummary(finalSummary, policy),
            });
        }
        return {
            completeness: summarizeCollectorCompleteness(streamResult.coverageByStore),
            done,
            enqueuedBatches: enqueueResult.enqueuedBatches,
            flushedState: checkpointResult.flushedState,
            outboxSummary: finalSummary,
            priorState,
            prunedSent,
            recordsQueued: enqueueResult.recordsQueued,
            recoveredLeases,
            satisfiedBindings,
            sentBatches: (preScanDrain.sentByKind.record_batch ?? 0) + (recordDrain.sentByKind.record_batch ?? 0),
            skippedScanForBacklog: false,
            scanBudgetExceeded: streamResult.scanBudgetExceeded,
            statePutFailed: checkpointResult.statePutFailed,
            streamingBufferHighWaterMark: streamResult.bufferHighWaterMark,
        };
    }
    catch (error) {
        if (startingHeartbeatSent) {
            await emitCorrectiveHeartbeatFromOutbox({ client, config, outbox, policy });
        }
        throw error;
    }
    finally {
        outbox.close();
    }
}
async function emitCorrectiveHeartbeatFromOutbox(input) {
    const summary = input.outbox.summary({ sourceInstanceId: input.config.sourceInstanceId });
    const deadLetterError = buildHeartbeatDeadLetterError(input.outbox, input.config.sourceInstanceId);
    await safeHeartbeat(input.client, {
        connector_id: input.config.connector.connector_id,
        ...(deadLetterError ? { last_error: deadLetterError } : {}),
        outbox: buildHeartbeatOutboxDiagnostics(summary, {
            backlogOpen: countOpenBacklogGaps(input.outbox, input.config.sourceInstanceId),
        }),
        records_pending: pendingOutboxWorkCount(summary),
        source_instance_id: input.config.sourceInstanceId,
        status: heartbeatStatusForSummary(summary, input.policy),
    });
}
async function maybeSkipScanForBacklog(input) {
    if (!hasScanBlockingOutboxWork(input.outbox, input.config.sourceInstanceId, input.policy)) {
        return null;
    }
    const recordsPending = pendingOutboxWorkCount(input.postDrainSummary);
    if (recordsPending >= input.policy.maxQueueDepth) {
        ensureCollectorGapRow({
            clock: () => new Date(),
            connectorId: input.config.connector.connector_id,
            details: `pending ${recordsPending} >= maxQueueDepth ${input.policy.maxQueueDepth}`,
            outbox: input.outbox,
            reason: "policy_budget",
            retryable: true,
            ...(input.config.runId ? { runId: input.config.runId } : {}),
            sourceInstanceId: input.config.sourceInstanceId,
        });
    }
    const prunedSent = autoPruneSucceededOutbox({
        outbox: input.outbox,
        policy: input.autoPrunePolicy,
        sourceInstanceId: input.config.sourceInstanceId,
    });
    const summaryAfterGap = input.outbox.summary({ sourceInstanceId: input.config.sourceInstanceId });
    const recordsPendingAfterGap = pendingOutboxWorkCount(summaryAfterGap);
    await safeHeartbeat(input.client, {
        connector_id: input.config.connector.connector_id,
        outbox: buildHeartbeatOutboxDiagnostics(summaryAfterGap, {
            backlogOpen: countOpenBacklogGaps(input.outbox, input.config.sourceInstanceId),
        }),
        records_pending: recordsPendingAfterGap,
        source_instance_id: input.config.sourceInstanceId,
        status: heartbeatStatusForSummary(summaryAfterGap, input.policy),
    });
    return {
        completeness: null,
        done: null,
        enqueuedBatches: 0,
        flushedState: null,
        outboxSummary: summaryAfterGap,
        priorState: Object.freeze({}),
        prunedSent,
        recordsQueued: 0,
        recoveredLeases: input.recoveredLeases,
        satisfiedBindings: input.satisfiedBindings,
        sentBatches: input.preScanDrain.sentByKind.record_batch ?? 0,
        skippedScanForBacklog: true,
        scanBudgetExceeded: false,
        statePutFailed: false,
        streamingBufferHighWaterMark: 0,
    };
}
async function readPriorStateOrBlock(input) {
    try {
        throwIfAborted(input.config.abortSignal);
        const projection = await input.client.getSourceInstanceState({ sourceInstanceId: input.config.sourceInstanceId });
        return projection.state && typeof projection.state === "object"
            ? Object.freeze({ ...projection.state })
            : Object.freeze({});
    }
    catch (error) {
        await safeHeartbeat(input.client, {
            connector_id: input.config.connector.connector_id,
            last_error: { kind: "state_read_failed" },
            records_pending: input.recordsPending,
            source_instance_id: input.config.sourceInstanceId,
            status: "blocked",
        });
        throw new CollectorStateReadError(`failed to read prior state for ${input.config.sourceInstanceId}: ${error instanceof Error ? error.message : String(error)}`, error);
    }
}
const COVERAGE_DIAGNOSTICS_STREAM = "coverage_diagnostics";
function coverageEntryFromRecord(message) {
    if (message.stream !== COVERAGE_DIAGNOSTICS_STREAM) {
        return null;
    }
    const data = message.data;
    const dataStore = isRecord(data) && typeof data.store === "string" && data.store ? data.store : null;
    const keyStore = typeof message.key === "string" && message.key ? message.key : null;
    const store = dataStore ?? keyStore;
    if (!store) {
        return null;
    }
    const rawStatus = isRecord(data) && typeof data.status === "string" ? data.status : null;
    if (!rawStatus) {
        return null;
    }
    const status = COLLECTOR_COVERAGE_STATUSES.includes(rawStatus)
        ? rawStatus
        : "unaccounted";
    return { status, store };
}
export function summarizeCollectorCompleteness(coverageByStore) {
    if (!coverageByStore || coverageByStore.size === 0) {
        return null;
    }
    const countsByStatus = Object.fromEntries(COLLECTOR_COVERAGE_STATUSES.map((status) => [status, 0]));
    const unaccountedStores = [];
    const byStore = {};
    for (const store of [...coverageByStore.keys()].sort()) {
        const status = coverageByStore.get(store);
        byStore[store] = status;
        countsByStatus[status] += 1;
        if (status === "unaccounted") {
            unaccountedStores.push(store);
        }
    }
    return {
        byStore,
        countsByStatus,
        fullyAccounted: unaccountedStores.length === 0,
        storeCount: coverageByStore.size,
        unaccountedStores,
    };
}
async function streamConnectorIntoOutbox(input) {
    throwIfAborted(input.abortSignal);
    const child = spawnConnector(input.config.connector, {
        baseUrl: input.config.baseUrl,
        deviceToken: input.config.deviceToken,
        ...(input.config.runId ? { runId: input.config.runId } : {}),
    });
    const stderr = new BoundedStderrBuffer(COLLECTOR_STDERR_MAX_BYTES);
    const inScopeStreams = new Set(input.config.connector.streams);
    const bufferedState = {};
    let batchSeq = nextOutboxBatchSeq(input.outbox, input.config.sourceInstanceId);
    let pendingRecords = [];
    let bufferHighWaterMark = 0;
    let recordsQueued = 0;
    let enqueuedBatches = 0;
    let done = null;
    let scanBudgetExceeded = false;
    let coverageByStore = null;
    const flushPendingBatch = () => {
        if (pendingRecords.length === 0) {
            return;
        }
        const chunk = pendingRecords;
        pendingRecords = [];
        const batchId = buildOutboxBatchId({
            batchSeq,
            connectorId: input.config.connector.connector_id,
            records: chunk,
            sourceInstanceId: input.config.sourceInstanceId,
        });
        const envelopes = chunk.map((record) => buildLocalDeviceRecordEnvelope({
            batchId,
            batchSeq,
            connectorId: input.config.connector.connector_id,
            deviceId: input.config.deviceId,
            record,
            sourceInstanceId: input.config.sourceInstanceId,
        }));
        input.outbox.enqueue({
            id: buildLocalDeviceOutboxId({
                kind: "record_batch",
                parts: [input.config.connector.connector_id, batchSeq, batchId],
                sourceInstanceId: input.config.sourceInstanceId,
            }),
            kind: "record_batch",
            payload: {
                batchId,
                batchSeq,
                connectorId: input.config.connector.connector_id,
                deviceId: input.config.deviceId,
                records: envelopes,
                sourceInstanceId: input.config.sourceInstanceId,
            },
            sourceInstanceId: input.config.sourceInstanceId,
        });
        recordsQueued += envelopes.length;
        enqueuedBatches++;
        batchSeq++;
        scanBudgetExceeded = maybeRecordScanBudgetGap({
            enqueuedBatches,
            input,
            scanBudgetExceeded,
        });
    };
    const recordCoverageIfPresent = (message) => {
        const entry = coverageEntryFromRecord(message);
        if (!entry) {
            return;
        }
        coverageByStore ??= new Map();
        coverageByStore.set(entry.store, entry.status);
    };
    const handleMessage = (message) => {
        if (message.type === "RECORD") {
            recordCoverageIfPresent(message);
            pendingRecords.push(message);
            if (pendingRecords.length > bufferHighWaterMark) {
                bufferHighWaterMark = pendingRecords.length;
            }
            if (pendingRecords.length >= input.batchSize) {
                flushPendingBatch();
            }
            return;
        }
        if (message.type === "STATE") {
            if (!inScopeStreams.has(message.stream)) {
                process.stderr.write(`${input.config.connector.connector_id} dropped out-of-scope STATE for stream '${message.stream}'\n`);
                return;
            }
            bufferedState[message.stream] = message.cursor;
            return;
        }
        if (message.type === "DONE") {
            done = message;
        }
    };
    const abortListener = input.abortSignal
        ? () => {
            try {
                child.kill("SIGTERM");
            }
            catch {
            }
            setTimeout(() => {
                try {
                    if (!child.killed) {
                        child.kill("SIGKILL");
                    }
                }
                catch {
                }
            }, 1000).unref?.();
        }
        : null;
    if (input.abortSignal && abortListener) {
        input.abortSignal.addEventListener("abort", abortListener, { once: true });
    }
    const exitPromise = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    const outputPromise = (async () => {
        const lines = createInterface({ input: child.stdout, terminal: false });
        let lineNumber = 0;
        for await (const line of lines) {
            lineNumber++;
            if (!line.trim()) {
                continue;
            }
            handleMessage(parseConnectorProtocolLine(line, lineNumber, input.config.connector.connector_id));
            if (scanBudgetExceeded) {
                try {
                    child.kill("SIGTERM");
                }
                catch {
                }
                break;
            }
        }
    })();
    child.stdin.on("error", () => {
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify(buildCollectorStartMessage(input.config.connector.streams, input.config.connector.streamsToBackfill, input.priorState))}\n`);
    let exitCode;
    try {
        [exitCode] = await Promise.all([exitPromise, outputPromise]);
    }
    catch (error) {
        if (input.abortSignal && abortListener) {
            input.abortSignal.removeEventListener("abort", abortListener);
        }
        flushPendingBatch();
        const details = sanitizeCollectorGapDetails(error instanceof Error ? error.message : String(error));
        recordConnectorChildFailureGap({
            details,
            enqueuedBatches,
            input,
        });
        throw new Error(`${input.config.connector.connector_id} connector failed to start or stream output: ${details || "unknown error"}`);
    }
    if (input.abortSignal && abortListener) {
        input.abortSignal.removeEventListener("abort", abortListener);
    }
    if (input.abortSignal?.aborted) {
        flushPendingBatch();
        throw input.abortSignal.reason instanceof Error
            ? input.abortSignal.reason
            : new DOMException("Aborted", "AbortError");
    }
    throwIfConnectorExitedUncleanly({
        enqueuedBatches,
        exitCode,
        flushPendingBatch,
        input,
        scanBudgetExceeded,
        stderr,
    });
    flushPendingBatch();
    return {
        bufferedState: Object.freeze(scanBudgetExceeded ? {} : { ...bufferedState }),
        bufferHighWaterMark,
        coverageByStore,
        done: scanBudgetExceeded ? null : done,
        enqueuedBatches,
        recordsQueued,
        scanBudgetExceeded,
    };
}
function parseConnectorProtocolLine(line, lineNumber, connectorId) {
    try {
        return JSON.parse(line);
    }
    catch (error) {
        const debugPath = writeConnectorProtocolDebugLine({ connectorId, error, line, lineNumber });
        const suffix = debugPath ? `; raw line saved to ${debugPath}` : "";
        throw new Error(`${error instanceof Error ? error.message : String(error)} at connector protocol line ${lineNumber} (${line.length} chars)${suffix}`);
    }
}
function writeConnectorProtocolDebugLine(input) {
    const dir = process.env[CONNECTOR_PROTOCOL_DEBUG_DIR_ENV]?.trim();
    if (!dir) {
        return null;
    }
    try {
        mkdirSync(dir, { mode: 0o700, recursive: true });
        const path = join(dir, `${input.connectorId}-${Date.now()}-${randomUUID()}.json`);
        writeFileSync(path, `${JSON.stringify({
            connector_id: input.connectorId,
            error: input.error instanceof Error ? input.error.message : String(input.error),
            line: input.line,
            line_length: input.line.length,
            line_number: input.lineNumber,
        }, null, 2)}\n`, { mode: 0o600 });
        return path;
    }
    catch {
        return null;
    }
}
function throwIfConnectorExitedUncleanly(input) {
    if (input.exitCode === 0 || input.scanBudgetExceeded) {
        return;
    }
    input.flushPendingBatch();
    const details = sanitizeCollectorGapDetails(`exit ${input.exitCode}: ${input.stderr.toString().trim()}`);
    recordConnectorChildFailureGap({
        details,
        enqueuedBatches: input.enqueuedBatches,
        input: input.input,
    });
    throw new Error(`${input.input.config.connector.connector_id} connector exited ${input.exitCode}: ${details || "unknown error"}`);
}
function maybeRecordScanBudgetGap(input) {
    if (input.scanBudgetExceeded) {
        return true;
    }
    if (input.enqueuedBatches < input.input.policy.maxEnqueuedBatchesPerRun) {
        return false;
    }
    ensureCollectorGapRow({
        clock: () => new Date(),
        connectorId: input.input.config.connector.connector_id,
        details: `enqueued ${input.enqueuedBatches} batches >= run batch limit ${input.input.policy.maxEnqueuedBatchesPerRun}`,
        outbox: input.input.outbox,
        reason: "policy_budget",
        retryable: true,
        ...(input.input.config.runId ? { runId: input.input.config.runId } : {}),
        sourceInstanceId: input.input.config.sourceInstanceId,
    });
    return true;
}
function recordConnectorChildFailureGap(input) {
    if (input.enqueuedBatches === 0) {
        return;
    }
    ensureCollectorGapRow({
        clock: () => new Date(),
        connectorId: input.input.config.connector.connector_id,
        details: input.details,
        outbox: input.input.outbox,
        reason: "connector_child_failure",
        retryable: true,
        ...(input.input.config.runId ? { runId: input.input.config.runId } : {}),
        sourceInstanceId: input.input.config.sourceInstanceId,
    });
}
async function maybeCommitCheckpoint(input) {
    if (Object.keys(input.bufferedState).length === 0) {
        return { flushedState: null, statePutFailed: false };
    }
    const checkpointId = buildLocalDeviceOutboxId({
        kind: "checkpoint",
        parts: [input.config.connector.connector_id, input.bufferedState],
        sourceInstanceId: input.config.sourceInstanceId,
    });
    input.outbox.enqueue({
        id: checkpointId,
        kind: "checkpoint",
        payload: {
            connectorId: input.config.connector.connector_id,
            sourceInstanceId: input.config.sourceInstanceId,
            state: input.bufferedState,
        },
        sourceInstanceId: input.config.sourceInstanceId,
    });
    const checkpointDrain = await drainCollectorOutbox({
        ...(input.config.abortSignal ? { abortSignal: input.config.abortSignal } : {}),
        client: input.client,
        connectorId: input.config.connector.connector_id,
        holderId: input.holderId,
        outbox: input.outbox,
        policy: input.policy,
        sourceInstanceId: input.config.sourceInstanceId,
    });
    const checkpointAfter = input.outbox.get(checkpointId);
    if (checkpointAfter?.status === "succeeded") {
        return { flushedState: Object.freeze({ ...input.bufferedState }), statePutFailed: false };
    }
    if (checkpointAfter && hasCheckpointPredecessorBlockingWork(input.outbox, checkpointAfter)) {
        return { flushedState: null, statePutFailed: false };
    }
    await safeHeartbeat(input.client, {
        connector_id: input.config.connector.connector_id,
        outbox: buildHeartbeatOutboxDiagnostics(input.afterRecordsSummary, {
            backlogOpen: countOpenBacklogGaps(input.outbox, input.config.sourceInstanceId),
        }),
        records_pending: pendingOutboxWorkCount(input.afterRecordsSummary),
        source_instance_id: input.config.sourceInstanceId,
        status: "retrying",
    });
    process.stderr.write(`${input.config.connector.connector_id} checkpoint not yet committed (drained ${checkpointDrain.sent} this pass; ${checkpointAfter?.last_error ?? "no error"})\n`);
    return { flushedState: null, statePutFailed: true };
}
async function recoverResolvedLocalCollectorGaps(input) {
    if (input.deferRecoveredGapCleanup) {
        return;
    }
    if (hasCheckpointBlockingOutboxWork(input.outbox, input.config.sourceInstanceId)) {
        return;
    }
    const succeededGaps = input.outbox.listByKind({
        kind: "gap",
        sourceInstanceId: input.config.sourceInstanceId,
        statuses: ["succeeded"],
    });
    for (const item of succeededGaps) {
        let payload;
        try {
            payload = assertGapPayload(item.payload, item.id);
        }
        catch (error) {
            process.stderr.write(`${input.config.connector.connector_id} skipped malformed succeeded gap recovery ${item.id}: ${error instanceof Error ? error.message : String(error)}\n`);
            continue;
        }
        try {
            await input.client.recoverLocalCollectorGap({
                connector_id: payload.connectorId,
                reason: payload.reason,
                source_instance_id: payload.sourceInstanceId,
                ...(input.config.runId ? { recovered_run_id: input.config.runId } : {}),
                ...(payload.stream ? { stream: payload.stream } : {}),
                ...(payload.streamBoundary ? { stream_boundary: payload.streamBoundary } : {}),
            });
            input.outbox.deleteSucceeded(item.id);
        }
        catch (error) {
            process.stderr.write(`${input.config.connector.connector_id} local gap recovery deferred for ${item.id}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
}
async function safeHeartbeat(client, request) {
    try {
        await client.heartbeat({ agent_version: COLLECTOR_AGENT_VERSION, ...request });
    }
    catch {
    }
}
export function buildCollectorStartMessage(streams, streamsToBackfill = [], priorState) {
    const start = {
        scope: { streams: streams.map((name) => ({ name })) },
        type: "START",
    };
    if (streamsToBackfill.length > 0) {
        start.streamsToBackfill = [...streamsToBackfill];
    }
    if (priorState && Object.keys(priorState).length > 0) {
        start.state = { ...priorState };
    }
    return start;
}
export function transformRecordsToCollectorEnvelopes(input) {
    return input.messages
        .filter((msg) => msg.type === "RECORD")
        .map((record) => buildLocalDeviceRecordEnvelope({
        batchId: input.batchId,
        batchSeq: input.batchSeq,
        connectorId: input.connectorId,
        deviceId: input.deviceId,
        record,
        sourceInstanceId: input.sourceInstanceId,
    }));
}
function ensureCollectorGapRow(input) {
    const firstSeenAt = input.clock().toISOString();
    const idParts = [
        input.connectorId,
        input.sourceInstanceId,
        input.reason,
        input.stream ?? null,
        input.streamBoundary ?? null,
    ];
    const id = buildLocalDeviceOutboxId({
        kind: "gap",
        parts: idParts,
        sourceInstanceId: input.sourceInstanceId,
    });
    const existing = input.outbox.get(id);
    if (existing) {
        return existing;
    }
    const payload = {
        connectorId: input.connectorId,
        firstSeenAt,
        nextAttemptBackoffMs: DEFAULT_GAP_RETRY_BACKOFF_MS,
        reason: input.reason,
        retryable: input.retryable,
        sourceInstanceId: input.sourceInstanceId,
    };
    if (input.stream) {
        payload.stream = input.stream;
    }
    if (input.streamBoundary) {
        payload.streamBoundary = input.streamBoundary;
    }
    if (input.runId) {
        payload.firstSeenRunId = input.runId;
    }
    const details = input.details ? sanitizeCollectorGapDetails(input.details) : null;
    if (details) {
        payload.details = details;
    }
    return input.outbox.enqueue({
        id,
        kind: "gap",
        payload,
        sourceInstanceId: input.sourceInstanceId,
    });
}
function sanitizeCollectorGapDetails(value) {
    let next = String(value)
        .replace(KEYED_SECRET_RE, (_match, marker) => `${marker}=[REDACTED]`)
        .replace(OTP_RE, "[REDACTED_OTP]")
        .replace(LONG_OPAQUE_RE, "[REDACTED]")
        .replace(/\s+/g, " ")
        .trim();
    if (next.length > COLLECTOR_GAP_DETAILS_MAX_CHARS) {
        next = `${next.slice(0, COLLECTOR_GAP_DETAILS_MAX_CHARS - 1)}…`;
    }
    return next;
}
export async function drainCollectorOutbox(input) {
    const sentByKind = {};
    const result = {
        deadLettered: 0,
        durationBudgetExceeded: false,
        failed: 0,
        iterations: 0,
        sent: 0,
        sentByKind,
    };
    const startedAt = Date.now();
    for (let i = 0; i < input.policy.maxDrainIterations; i++) {
        throwIfAborted(input.abortSignal);
        if (Date.now() - startedAt >= input.policy.maxDrainDurationMs) {
            result.durationBudgetExceeded = true;
            return result;
        }
        const claimed = claimReadyOutboxItems(input);
        if (claimed.length === 0) {
            return result;
        }
        result.iterations++;
        for (const item of claimed) {
            await drainClaimedOutboxItem(input, item, result, sentByKind);
        }
    }
    return result;
}
function claimReadyOutboxItems(input) {
    const nextReady = nextReadyOutboxItem(input);
    if (!nextReady) {
        return [];
    }
    if (nextReady.kind === "checkpoint" && hasCheckpointPredecessorBlockingWork(input.outbox, nextReady)) {
        return [];
    }
    const claimInput = {
        excludeKinds: nextReady.kind === "checkpoint" ? [] : ["checkpoint"],
        holder: input.holderId,
        leaseMs: input.policy.leaseMs,
        limit: nextReady.kind === "checkpoint" ? 1 : input.policy.drainBatchSize,
    };
    if (input.sourceInstanceId) {
        claimInput.sourceInstanceId = input.sourceInstanceId;
    }
    return input.outbox.claimReady(claimInput);
}
function nextReadyOutboxItem(input) {
    return input.outbox.peekReady(input.sourceInstanceId ? { sourceInstanceId: input.sourceInstanceId } : {});
}
function hasCheckpointPredecessorBlockingWork(outbox, checkpoint) {
    return outbox.hasNonSucceededPredecessor({
        beforeInsertOrder: checkpoint.insert_order,
        kinds: ["record_batch", "gap"],
        sourceInstanceId: checkpoint.source_instance_id,
    });
}
async function drainClaimedOutboxItem(input, item, result, sentByKind) {
    throwIfAborted(input.abortSignal);
    try {
        const current = input.outbox.renewLease({
            holder: input.holderId,
            id: item.id,
            leaseEpoch: item.lease_epoch,
            leaseMs: input.policy.leaseMs,
        });
        await sendOutboxItem(input.client, current);
        input.outbox.acknowledge({ holder: input.holderId, id: current.id, leaseEpoch: current.lease_epoch });
        result.sent++;
        sentByKind[current.kind] = (sentByKind[current.kind] ?? 0) + 1;
    }
    catch (error) {
        failOutboxItem(input, item, error, result);
    }
}
function failOutboxItem(input, item, error, result) {
    const message = sanitizeCollectorGapDetails(error instanceof Error ? error.message : String(error));
    try {
        if (error instanceof OutboxPayloadShapeError || item.attempt_count + 1 >= input.policy.maxAttempts) {
            input.outbox.deadLetter({
                error: message,
                holder: input.holderId,
                id: item.id,
                leaseEpoch: item.lease_epoch,
            });
            result.deadLettered++;
            return;
        }
        input.outbox.failRetryable({
            error: message,
            holder: input.holderId,
            id: item.id,
            leaseEpoch: item.lease_epoch,
            retryBackoffMs: input.policy.retryBackoffMs * (item.attempt_count + 1),
        });
        result.failed++;
    }
    catch (transitionError) {
        if (isLeaseNotCurrentError(transitionError)) {
            result.failed++;
            return;
        }
        throw transitionError;
    }
}
function isLeaseNotCurrentError(error) {
    return error instanceof Error && error.message.startsWith("local outbox lease not current");
}
class OutboxPayloadShapeError extends Error {
    constructor(message) {
        super(message);
        this.name = "OutboxPayloadShapeError";
    }
}
const DEFAULT_GAP_RETRY_BACKOFF_MS = 15 * 60_000;
async function sendOutboxItem(client, item) {
    if (item.kind === "record_batch") {
        const payload = assertRecordBatchPayload(item.payload, item.id);
        if (payload.records.length === 0) {
            throw new OutboxPayloadShapeError(`record_batch payload has no records: ${item.id}`);
        }
        await client.ingestBatch({
            batch_id: payload.batchId,
            batch_seq: payload.batchSeq,
            body_hash: hashCanonicalJson(payload.records),
            connector_id: payload.connectorId,
            device_id: payload.deviceId,
            records: payload.records.map((record) => ({
                data: record.data,
                emitted_at: record.emitted_at,
                record_key: record.record_key,
                stream: record.stream,
            })),
            source_instance_id: payload.sourceInstanceId,
        });
        return;
    }
    if (item.kind === "checkpoint") {
        const payload = assertCheckpointPayload(item.payload, item.id);
        await client.putSourceInstanceState({
            sourceInstanceId: payload.sourceInstanceId,
            state: payload.state,
        });
        return;
    }
    if (item.kind === "gap") {
        const payload = assertGapPayload(item.payload, item.id);
        await client.ackLocalCollectorGap({
            connector_id: payload.connectorId,
            first_seen_at: payload.firstSeenAt,
            next_attempt_backoff_ms: payload.nextAttemptBackoffMs,
            reason: payload.reason,
            retryable: payload.retryable,
            source_instance_id: payload.sourceInstanceId,
            ...(payload.stream ? { stream: payload.stream } : {}),
            ...(payload.streamBoundary ? { stream_boundary: payload.streamBoundary } : {}),
            ...(payload.firstSeenRunId ? { first_seen_run_id: payload.firstSeenRunId } : {}),
            ...(payload.firstSeenRunId ? { last_run_id: payload.firstSeenRunId } : {}),
            ...(payload.details ? { details: payload.details } : {}),
        });
        return;
    }
    throw new OutboxPayloadShapeError(`unsupported outbox kind ${item.kind} for id ${item.id}`);
}
function assertRecordBatchPayload(payload, id) {
    if (!isRecord(payload)) {
        throw new OutboxPayloadShapeError(`record_batch payload is not an object: ${id}`);
    }
    if (typeof payload.batchId !== "string" ||
        typeof payload.batchSeq !== "number" ||
        typeof payload.connectorId !== "string" ||
        typeof payload.deviceId !== "string" ||
        typeof payload.sourceInstanceId !== "string" ||
        !Array.isArray(payload.records) ||
        !payload.records.every(isLocalDeviceRecordEnvelope)) {
        throw new OutboxPayloadShapeError(`record_batch payload missing required fields: ${id}`);
    }
    return {
        batchId: payload.batchId,
        batchSeq: payload.batchSeq,
        connectorId: payload.connectorId,
        deviceId: payload.deviceId,
        records: payload.records,
        sourceInstanceId: payload.sourceInstanceId,
    };
}
function assertGapPayload(payload, id) {
    if (!isRecord(payload)) {
        throw new OutboxPayloadShapeError(`gap payload is not an object: ${id}`);
    }
    if (typeof payload.connectorId !== "string" ||
        typeof payload.sourceInstanceId !== "string" ||
        typeof payload.firstSeenAt !== "string" ||
        typeof payload.nextAttemptBackoffMs !== "number" ||
        typeof payload.retryable !== "boolean" ||
        (payload.reason !== "policy_budget" && payload.reason !== "connector_child_failure") ||
        (payload.stream !== undefined && typeof payload.stream !== "string") ||
        (payload.streamBoundary !== undefined && typeof payload.streamBoundary !== "string") ||
        (payload.firstSeenRunId !== undefined && typeof payload.firstSeenRunId !== "string") ||
        (payload.details !== undefined && typeof payload.details !== "string")) {
        throw new OutboxPayloadShapeError(`gap payload missing or invalid fields: ${id}`);
    }
    const gap = {
        connectorId: payload.connectorId,
        firstSeenAt: payload.firstSeenAt,
        nextAttemptBackoffMs: payload.nextAttemptBackoffMs,
        reason: payload.reason,
        retryable: payload.retryable,
        sourceInstanceId: payload.sourceInstanceId,
    };
    if (typeof payload.stream === "string") {
        gap.stream = payload.stream;
    }
    if (typeof payload.streamBoundary === "string") {
        gap.streamBoundary = payload.streamBoundary;
    }
    if (typeof payload.firstSeenRunId === "string") {
        gap.firstSeenRunId = payload.firstSeenRunId;
    }
    if (typeof payload.details === "string") {
        gap.details = payload.details;
    }
    return gap;
}
function assertCheckpointPayload(payload, id) {
    if (!isRecord(payload)) {
        throw new OutboxPayloadShapeError(`checkpoint payload is not an object: ${id}`);
    }
    if (typeof payload.connectorId !== "string" ||
        typeof payload.sourceInstanceId !== "string" ||
        !isRecord(payload.state)) {
        throw new OutboxPayloadShapeError(`checkpoint payload missing required fields: ${id}`);
    }
    return {
        connectorId: payload.connectorId,
        sourceInstanceId: payload.sourceInstanceId,
        state: payload.state,
    };
}
function isLocalDeviceRecordEnvelope(value) {
    return (isRecord(value) &&
        typeof value.batch_id === "string" &&
        typeof value.batch_seq === "number" &&
        typeof value.body_hash === "string" &&
        typeof value.connector_id === "string" &&
        isRecord(value.data) &&
        typeof value.device_id === "string" &&
        typeof value.emitted_at === "string" &&
        typeof value.record_key === "string" &&
        typeof value.source_instance_id === "string" &&
        typeof value.stream === "string");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function buildOutboxBatchId(input) {
    return `local-batch:${hashCanonicalJson({
        batch_seq: input.batchSeq,
        connector_id: input.connectorId,
        records: input.records.map((record) => ({
            data: record.data,
            emitted_at: record.emitted_at,
            key: String(record.key),
            stream: record.stream,
        })),
        source_instance_id: input.sourceInstanceId,
    })}`;
}
function pendingOutboxWorkCount(summary) {
    return summary.ready + summary.leased;
}
function hasScanBlockingOutboxWork(outbox, sourceInstanceId, policy) {
    if (outbox.hasNonSucceededWork({ excludeKinds: ["gap"], sourceInstanceId })) {
        return true;
    }
    return outbox.listByKind({ kind: "gap", sourceInstanceId }).some((item) => isUnresolvedScanBudgetGap(item, policy));
}
function hasCheckpointBlockingOutboxWork(outbox, sourceInstanceId) {
    return outbox.hasNonSucceededWork({ sourceInstanceId });
}
function isUnresolvedScanBudgetGap(item, policy) {
    if (item.status === "dead_letter") {
        return false;
    }
    let payload;
    try {
        payload = assertGapPayload(item.payload, item.id);
    }
    catch {
        return item.status !== "succeeded";
    }
    if (payload.reason !== "policy_budget" || !payload.retryable || !payload.details) {
        return false;
    }
    const match = payload.details.match(SCAN_BATCH_LIMIT_DETAIL_RE);
    if (!match?.[1]) {
        return false;
    }
    return policy.maxEnqueuedBatchesPerRun <= Number(match[1]);
}
export const LOCAL_COLLECTOR_LIFECYCLE_STATES = [
    "healthy_idle",
    "draining",
    "retryable_backlog",
    "dead_letter",
    "stale_lease",
    "coverage_missing",
];
export function deriveLocalCollectorLifecycleState(input) {
    const { summary } = input;
    if (summary.deadLetter > 0) {
        return "dead_letter";
    }
    if (summary.staleLeases > 0) {
        return "stale_lease";
    }
    const claimableNow = Math.max(0, summary.ready - summary.retrying);
    if (summary.leased > 0 || claimableNow > 0) {
        return "draining";
    }
    if (summary.retrying > 0) {
        return "retryable_backlog";
    }
    if (input.coverageObserved === false && input.recordBatchCount > 0) {
        return "coverage_missing";
    }
    return "healthy_idle";
}
function heartbeatStatusForSummary(summary, policy) {
    if (summary.deadLetter > 0) {
        return "blocked";
    }
    const pending = pendingOutboxWorkCount(summary);
    if (policy && pending >= policy.maxQueueDepth) {
        return "blocked";
    }
    if (pending > 0) {
        return "retrying";
    }
    return "healthy";
}
export function buildHeartbeatOutboxDiagnostics(summary, options = {}) {
    return {
        backlog_open: Math.max(0, options.backlogOpen ?? 0),
        dead_letter: summary.deadLetter,
        leased: summary.leased,
        oldest_pending_at: summary.oldestReadyAt,
        pending: summary.ready,
        retrying: summary.retrying,
        stale_leases: summary.staleLeases,
        succeeded: summary.succeeded,
        total: summary.total,
    };
}
function buildHeartbeatDeadLetterError(outbox, sourceInstanceId) {
    const summary = outbox.deadLetterErrorSummary({ sourceInstanceId });
    if (summary.dead_letter_count === 0) {
        return null;
    }
    return {
        kind: "dead_letter_backlog",
        top_dead_letter_classes: summary.top_classes,
    };
}
function countOpenBacklogGaps(outbox, sourceInstanceId) {
    return outbox.countOpenGaps({ sourceInstanceId });
}
function nextOutboxBatchSeq(outbox, sourceInstanceId) {
    return outbox.maxRecordBatchSeq({ sourceInstanceId }) + 1;
}
export async function drainCollectorQueue(input) {
    let sent = 0;
    for (;;) {
        throwIfAborted(input.abortSignal);
        const item = await input.queue.dequeueReady();
        if (!item) {
            return sent;
        }
        try {
            await sendQueueItem(input.client, item);
            await input.queue.markSent(item.batch_id);
            sent++;
        }
        catch (error) {
            await input.queue.markRetry(item.batch_id, error instanceof Error ? error.message : String(error));
            return sent;
        }
    }
}
export function recoverAndSummarizeOutbox(outbox, input = {}) {
    const recovered = input.sourceInstanceId
        ? outbox.recoverExpiredLeases({ sourceInstanceId: input.sourceInstanceId })
        : outbox.recoverExpiredLeases();
    const summary = input.sourceInstanceId
        ? outbox.summary({ sourceInstanceId: input.sourceInstanceId })
        : outbox.summary();
    return { recovered, summary };
}
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
    }
}
async function sendQueueItem(client, item) {
    const firstRecord = item.records[0];
    if (!firstRecord) {
        throw new Error(`collector batch has no records: ${item.batch_id}`);
    }
    await client.ingestBatch({
        batch_id: item.batch_id,
        batch_seq: item.batch_seq,
        body_hash: hashCanonicalJson(item.records),
        connector_id: firstRecord.connector_id,
        device_id: firstRecord.device_id,
        records: item.records.map((record) => ({
            data: record.data,
            emitted_at: record.emitted_at,
            record_key: record.record_key,
            stream: record.stream,
        })),
        source_instance_id: item.source_instance_id,
    });
}
function buildCollectorChildEnv(context) {
    const env = {
        PDPP_REFERENCE_BASE_URL: context.baseUrl,
        PDPP_LOCAL_DEVICE_TOKEN: context.deviceToken,
    };
    if (context.runId) {
        env.PDPP_RUN_ID = context.runId;
    }
    return env;
}
class BoundedStderrBuffer {
    #limit;
    #chunks = [];
    #size = 0;
    #dropped = 0;
    constructor(limit) {
        this.#limit = Math.max(1024, limit);
    }
    push(chunk) {
        this.#chunks.push(chunk);
        this.#size += chunk.length;
        while (this.#size > this.#limit && this.#chunks.length > 0) {
            const head = this.#chunks[0];
            if (!head) {
                break;
            }
            const overflow = this.#size - this.#limit;
            if (head.length <= overflow) {
                this.#chunks.shift();
                this.#size -= head.length;
                this.#dropped += head.length;
                continue;
            }
            this.#chunks[0] = head.subarray(overflow);
            this.#size -= overflow;
            this.#dropped += overflow;
            break;
        }
    }
    toString() {
        const body = Buffer.concat(this.#chunks).toString("utf8");
        if (this.#dropped === 0) {
            return body;
        }
        return `[truncated ${this.#dropped} stderr bytes]\n${body}`;
    }
}
function spawnConnector(connector, childContext) {
    const env = { ...process.env, ...buildCollectorChildEnv(childContext), ...connector.env };
    env.PATH = buildCollectorChildPath(env.PATH);
    return spawn(connector.command, [...connector.args], {
        cwd: PACKAGE_ROOT,
        env,
    });
}
function buildCollectorChildPath(pathValue) {
    return [join(PACKAGE_ROOT, "node_modules", ".bin"), join(REPO_ROOT, "node_modules", ".bin"), pathValue]
        .filter((part) => Boolean(part))
        .join(delimiter);
}
