import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LocalDeviceClient } from "./local-device-client.js";
import { buildLocalDeviceRecordEnvelope, hashCanonicalJson, } from "./local-device-envelope.js";
import { LocalDeviceQueue } from "./local-device-queue.js";
import { assertPlacementOrThrow, COLLECTOR_RUNTIME_CAPABILITIES, } from "./runtime-capabilities.js";
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
export async function enrollCollector(config) {
    const client = new LocalDeviceClient({ baseUrl: config.baseUrl });
    return await client.exchangeEnrollment({
        enrollment_code: config.code,
        ...(config.deviceLabel ? { deviceLabel: config.deviceLabel } : {}),
    });
}
export class CollectorStateReadError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = "CollectorStateReadError";
    }
}
export async function runCollectorConnector(config) {
    const satisfiedBindings = assertPlacementOrThrow(config.connector, COLLECTOR_RUNTIME_CAPABILITIES);
    const batchSize = config.batchSize ?? 100;
    const queue = new LocalDeviceQueue({ path: config.queuePath });
    const client = new LocalDeviceClient({
        baseUrl: config.baseUrl,
        deviceId: config.deviceId,
        deviceToken: config.deviceToken,
    });
    let priorState = Object.freeze({});
    try {
        const projection = await client.getSourceInstanceState({ sourceInstanceId: config.sourceInstanceId });
        if (projection.state && typeof projection.state === "object") {
            priorState = Object.freeze({ ...projection.state });
        }
    }
    catch (error) {
        await safeHeartbeat(client, {
            connector_id: config.connector.connector_id,
            records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
            source_instance_id: config.sourceInstanceId,
            status: "blocked",
        });
        throw new CollectorStateReadError(`failed to read prior state for ${config.sourceInstanceId}: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    await client.heartbeat({
        connector_id: config.connector.connector_id,
        records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
        source_instance_id: config.sourceInstanceId,
        status: "starting",
    });
    const messages = await collectConnectorMessages(config.connector, {
        baseUrl: config.baseUrl,
        deviceToken: config.deviceToken,
        ...(config.runId ? { runId: config.runId } : {}),
    }, priorState);
    const records = messages.filter((msg) => msg.type === "RECORD");
    const done = messages.findLast((msg) => msg.type === "DONE") ?? null;
    const inScopeStreams = new Set(config.connector.streams);
    const bufferedState = projectEmittedState(messages, inScopeStreams, config.connector.connector_id);
    let recordsQueued = 0;
    let enqueuedBatches = 0;
    let batchSeq = nextBatchSeq(await queue.list(), config.sourceInstanceId);
    for (const chunk of chunkRecords(records, batchSize)) {
        const batchId = `${config.sourceInstanceId}-${batchSeq}-${randomUUID()}`;
        const envelopes = chunk.map((record) => buildLocalDeviceRecordEnvelope({
            batchId,
            batchSeq,
            connectorId: config.connector.connector_id,
            deviceId: config.deviceId,
            record,
            sourceInstanceId: config.sourceInstanceId,
        }));
        await queue.enqueue({ batchId, batchSeq, records: envelopes, sourceInstanceId: config.sourceInstanceId });
        recordsQueued += envelopes.length;
        enqueuedBatches++;
        batchSeq++;
    }
    const sentBatches = await drainCollectorQueue({ client, queue });
    const pendingAfterDrain = (await queue.list()).filter((item) => item.status !== "sent").length;
    let flushedState = null;
    let statePutFailed = false;
    if (pendingAfterDrain === 0 && Object.keys(bufferedState).length > 0) {
        try {
            await client.putSourceInstanceState({
                sourceInstanceId: config.sourceInstanceId,
                state: bufferedState,
            });
            flushedState = Object.freeze({ ...bufferedState });
        }
        catch (error) {
            statePutFailed = true;
            await safeHeartbeat(client, {
                connector_id: config.connector.connector_id,
                records_pending: pendingAfterDrain,
                source_instance_id: config.sourceInstanceId,
                status: "retrying",
            });
            process.stderr.write(`${config.connector.connector_id} state PUT failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
    if (!statePutFailed) {
        await client.heartbeat({
            connector_id: config.connector.connector_id,
            records_pending: pendingAfterDrain,
            source_instance_id: config.sourceInstanceId,
            status: pendingAfterDrain > 0 ? "retrying" : "healthy",
        });
    }
    return {
        done,
        enqueuedBatches,
        flushedState,
        priorState,
        recordsQueued,
        satisfiedBindings,
        sentBatches,
        statePutFailed,
    };
}
function projectEmittedState(messages, inScopeStreams, connectorId) {
    const projected = {};
    for (const message of messages) {
        if (message.type !== "STATE") {
            continue;
        }
        if (!inScopeStreams.has(message.stream)) {
            process.stderr.write(`${connectorId} dropped out-of-scope STATE for stream '${message.stream}'\n`);
            continue;
        }
        projected[message.stream] = message.cursor;
    }
    return projected;
}
async function safeHeartbeat(client, request) {
    try {
        await client.heartbeat(request);
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
export async function drainCollectorQueue(input) {
    let sent = 0;
    for (;;) {
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
async function collectConnectorMessages(connector, childContext, priorState) {
    const child = spawnConnector(connector, childContext);
    const messages = [];
    const stderr = [];
    const exitPromise = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    const outputPromise = (async () => {
        const lines = createInterface({ input: child.stdout, terminal: false });
        for await (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            messages.push(JSON.parse(line));
        }
    })();
    child.stdin.on("error", () => {
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(`${JSON.stringify(buildCollectorStartMessage(connector.streams, connector.streamsToBackfill, priorState))}\n`);
    let exitCode;
    try {
        [exitCode] = await Promise.all([exitPromise, outputPromise]);
    }
    catch (error) {
        throw new Error(`${connector.connector_id} connector failed to start or stream output: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (exitCode !== 0) {
        throw new Error(`${connector.connector_id} connector exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
    }
    return messages;
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
function chunkRecords(records, size) {
    const chunks = [];
    for (let index = 0; index < records.length; index += size) {
        chunks.push(records.slice(index, index + size));
    }
    return chunks;
}
function nextBatchSeq(items, sourceInstanceId) {
    return (Math.max(0, ...items.filter((item) => item.source_instance_id === sourceInstanceId).map((item) => item.batch_seq)) +
        1);
}
