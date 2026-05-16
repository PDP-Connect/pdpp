/**
 * Local collector runner.
 *
 * Generalizes the local device exporter pattern: pair with a provider via
 * device-scoped enrollment, advertise runtime capabilities, run a connector
 * through the existing connector runtime, and upload records/blobs/run-events
 * through the device-scoped ingest routes.
 *
 * Spec: openspec/changes/introduce-local-collector-runner
 *
 * Boundary: this is reference/control-plane behavior. The Resource Server
 * stays read/query-only. Collector enrollment, heartbeat, ingest, and
 * diagnostics flow through the device-exporter scoped routes already
 * declared in `reference-implementation/server/index.js`.
 *
 * Capability gate: every collector run starts with a placement decision
 * against the COLLECTOR_RUNTIME_CAPABILITIES profile. Connectors whose
 * required bindings are not advertised by the collector runtime fail
 * before spawn with a typed `RuntimeCapabilityMismatchError` — see
 * `runtime-capabilities.ts`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { EmittedMessage, StartMessage, StreamScope } from "./connector-runtime.ts";
import { type EnrollmentExchangeResponse, LocalDeviceClient } from "./local-device-client.ts";
import {
  buildLocalDeviceRecordEnvelope,
  hashCanonicalJson,
  type LocalDeviceRecordEnvelope,
} from "./local-device-envelope.ts";
import { LocalDeviceQueue, type LocalDeviceQueueItem } from "./local-device-queue.ts";
import {
  assertPlacementOrThrow,
  COLLECTOR_RUNTIME_CAPABILITIES,
  type ConnectorPlacementInput,
  type RuntimeBindingName,
} from "./runtime-capabilities.ts";

export interface CollectorEnrollmentConfig {
  baseUrl: string;
  code: string;
  deviceLabel?: string;
}

export async function enrollCollector(config: CollectorEnrollmentConfig): Promise<EnrollmentExchangeResponse> {
  const client = new LocalDeviceClient({ baseUrl: config.baseUrl });
  return await client.exchangeEnrollment({
    enrollment_code: config.code,
    ...(config.deviceLabel ? { deviceLabel: config.deviceLabel } : {}),
  });
}

export interface CollectorConnectorSpec extends ConnectorPlacementInput {
  readonly args: readonly string[];
  /** Argv for the connector entrypoint (typically tsx + connector index.ts). */
  readonly command: string;
  /** Stable connector id used for ingest envelopes. */
  readonly connector_id: string;
  /** Optional extra env passed to the connector child process. */
  readonly env?: NodeJS.ProcessEnv;
  /** Streams the collector should request from the connector. */
  readonly streams: readonly string[];
  /** Optional explicit stream backfills requested from the connector. */
  readonly streamsToBackfill?: readonly string[];
}

export interface CollectorRunConfig {
  baseUrl: string;
  batchSize?: number;
  connector: CollectorConnectorSpec;
  deviceId: string;
  deviceToken: string;
  queuePath: string;
  /**
   * Optional stable id for THIS run. When provided alongside `baseUrl`
   * and `deviceToken`, the connector subprocess gets PDPP_RUN_ID,
   * PDPP_REFERENCE_BASE_URL, and PDPP_LOCAL_DEVICE_TOKEN in its env so
   * the runtime can register the launched browser's CDP page-target
   * wsUrl with the reference server's run-target registry.
   *
   * Omit to disable streaming-target registration entirely (the
   * connector run is unaffected, but operator-side streaming will not
   * resolve a wsUrl for this run). Best-effort throughout: a missing
   * runId is the honest no-op mode.
   */
  runId?: string;
  sourceInstanceId: string;
}

export interface CollectorRunResult {
  done: Extract<EmittedMessage, { type: "DONE" }> | null;
  enqueuedBatches: number;
  /**
   * Map of stream → cursor for STATE messages flushed to the server this pass.
   * Null when STATE was buffered but the flush was skipped because the queue
   * still held unsent items, or when no in-scope STATE was emitted.
   */
  flushedState: Readonly<Record<string, unknown>> | null;
  /** Prior state replayed into the START message (empty when first run). */
  priorState: Readonly<Record<string, unknown>>;
  recordsQueued: number;
  satisfiedBindings: readonly RuntimeBindingName[];
  sentBatches: number;
  /** True when the runner failed to persist accumulated STATE after a successful drain. */
  statePutFailed: boolean;
}

export class CollectorStateReadError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CollectorStateReadError";
  }
}

/**
 * Generalization of the codex local-device exporter loop.
 *
 * Pre-spawn: gates the connector against the collector runtime
 * capability profile. If a required binding is absent, throws
 * `RuntimeCapabilityMismatchError` before any child process or
 * heartbeat is created.
 *
 * Spawn: runs the connector entrypoint as a child process, feeding
 * START on stdin and parsing emitted protocol messages off stdout.
 *
 * Post-spawn: builds device-scoped envelopes, enqueues them for ingest,
 * drains the queue against the device-exporter ingest endpoint, and
 * heartbeats start/healthy.
 */
export async function runCollectorConnector(config: CollectorRunConfig): Promise<CollectorRunResult> {
  const satisfiedBindings = assertPlacementOrThrow(config.connector, COLLECTOR_RUNTIME_CAPABILITIES);

  const batchSize = config.batchSize ?? 100;
  const queue = new LocalDeviceQueue({ path: config.queuePath });
  const client = new LocalDeviceClient({
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    deviceToken: config.deviceToken,
  });

  let priorState: Readonly<Record<string, unknown>> = Object.freeze({});
  try {
    const projection = await client.getSourceInstanceState({ sourceInstanceId: config.sourceInstanceId });
    if (projection.state && typeof projection.state === "object") {
      priorState = Object.freeze({ ...projection.state });
    }
  } catch (error) {
    // Honest-crash: we cannot safely advance without knowing prior state.
    // Surface the failure via heartbeat and bail before spawning the child,
    // so the operator can see the blocker on the dashboard.
    await safeHeartbeat(client, {
      connector_id: config.connector.connector_id,
      records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
      source_instance_id: config.sourceInstanceId,
      status: "blocked",
    });
    throw new CollectorStateReadError(
      `failed to read prior state for ${config.sourceInstanceId}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }

  await client.heartbeat({
    connector_id: config.connector.connector_id,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "starting",
  });

  const messages = await collectConnectorMessages(
    config.connector,
    {
      baseUrl: config.baseUrl,
      deviceToken: config.deviceToken,
      ...(config.runId ? { runId: config.runId } : {}),
    },
    priorState
  );
  const records = messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
  const done =
    messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE") ?? null;

  const inScopeStreams = new Set(config.connector.streams);
  const bufferedState = projectEmittedState(messages, inScopeStreams, config.connector.connector_id);

  let recordsQueued = 0;
  let enqueuedBatches = 0;
  let batchSeq = nextBatchSeq(await queue.list(), config.sourceInstanceId);
  for (const chunk of chunkRecords(records, batchSize)) {
    const batchId = `${config.sourceInstanceId}-${batchSeq}-${randomUUID()}`;
    const envelopes = chunk.map((record) =>
      buildLocalDeviceRecordEnvelope({
        batchId,
        batchSeq,
        connectorId: config.connector.connector_id,
        deviceId: config.deviceId,
        record,
        sourceInstanceId: config.sourceInstanceId,
      })
    );
    await queue.enqueue({ batchId, batchSeq, records: envelopes, sourceInstanceId: config.sourceInstanceId });
    recordsQueued += envelopes.length;
    enqueuedBatches++;
    batchSeq++;
  }

  const sentBatches = await drainCollectorQueue({ client, queue });
  const pendingAfterDrain = (await queue.list()).filter((item) => item.status !== "sent").length;

  let flushedState: Readonly<Record<string, unknown>> | null = null;
  let statePutFailed = false;
  if (pendingAfterDrain === 0 && Object.keys(bufferedState).length > 0) {
    try {
      await client.putSourceInstanceState({
        sourceInstanceId: config.sourceInstanceId,
        state: bufferedState,
      });
      flushedState = Object.freeze({ ...bufferedState });
    } catch (error) {
      statePutFailed = true;
      // Surface via heartbeat. Next pass re-reads state from the server and
      // re-emits records; device-ingest idempotency absorbs duplicates.
      await safeHeartbeat(client, {
        connector_id: config.connector.connector_id,
        records_pending: pendingAfterDrain,
        source_instance_id: config.sourceInstanceId,
        status: "retrying",
      });
      process.stderr.write(
        `${config.connector.connector_id} state PUT failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
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

/**
 * Project emitted STATE messages into a stream-keyed map.
 *
 * - Per-stream last-wins ordering (matches `connector-state-store` semantics).
 * - Drops STATE for streams that were not in `START.scope.streams` and emits a
 *   stderr warning identifying the offending stream. Mirrors the in-process
 *   runtime's strictness on stream membership.
 */
function projectEmittedState(
  messages: readonly EmittedMessage[],
  inScopeStreams: Set<string>,
  connectorId: string
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
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

async function safeHeartbeat(
  client: Pick<LocalDeviceClient, "heartbeat">,
  request: Parameters<LocalDeviceClient["heartbeat"]>[0]
): Promise<void> {
  try {
    await client.heartbeat(request);
  } catch {
    // Heartbeat is best-effort here; the caller is already handling a more
    // important failure and we do not want to mask it with a heartbeat error.
  }
}

export function buildCollectorStartMessage(
  streams: readonly string[],
  streamsToBackfill: readonly string[] = [],
  priorState?: Readonly<Record<string, unknown>> | null
): StartMessage {
  const start: StartMessage = {
    scope: { streams: streams.map((name): StreamScope => ({ name })) },
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

export function transformRecordsToCollectorEnvelopes(input: {
  batchId: string;
  batchSeq: number;
  connectorId: string;
  deviceId: string;
  messages: readonly EmittedMessage[];
  sourceInstanceId: string;
}): LocalDeviceRecordEnvelope[] {
  return input.messages
    .filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD")
    .map((record) =>
      buildLocalDeviceRecordEnvelope({
        batchId: input.batchId,
        batchSeq: input.batchSeq,
        connectorId: input.connectorId,
        deviceId: input.deviceId,
        record,
        sourceInstanceId: input.sourceInstanceId,
      })
    );
}

export async function drainCollectorQueue(input: {
  client: Pick<LocalDeviceClient, "ingestBatch">;
  queue: LocalDeviceQueue;
}): Promise<number> {
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
    } catch (error) {
      await input.queue.markRetry(item.batch_id, error instanceof Error ? error.message : String(error));
      return sent;
    }
  }
}

async function sendQueueItem(
  client: Pick<LocalDeviceClient, "ingestBatch">,
  item: LocalDeviceQueueItem
): Promise<void> {
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

/**
 * Collector context the connector subprocess needs in env beyond
 * `connector.env`. The streaming-registration plumbing (see
 * `connector-runtime.ts → resolveStreamingRegistrationFromEnv`)
 * reads these to construct a registration client.
 */
export interface CollectorChildContext {
  /** Reference server base URL (forwarded as PDPP_REFERENCE_BASE_URL). */
  readonly baseUrl: string;
  /** Device-exporter bearer token (forwarded as PDPP_LOCAL_DEVICE_TOKEN). */
  readonly deviceToken: string;
  /** Optional run id (forwarded as PDPP_RUN_ID). Omit to skip streaming. */
  readonly runId?: string;
}

function buildCollectorChildEnv(context: CollectorChildContext): Record<string, string> {
  const env: Record<string, string> = {
    PDPP_REFERENCE_BASE_URL: context.baseUrl,
    PDPP_LOCAL_DEVICE_TOKEN: context.deviceToken,
  };
  if (context.runId) {
    env.PDPP_RUN_ID = context.runId;
  }
  return env;
}

async function collectConnectorMessages(
  connector: CollectorConnectorSpec,
  childContext: CollectorChildContext,
  priorState?: Readonly<Record<string, unknown>>
): Promise<EmittedMessage[]> {
  const child = spawnConnector(connector, childContext);
  const messages: EmittedMessage[] = [];
  const stderr: Buffer[] = [];
  child.stdin.end(
    `${JSON.stringify(buildCollectorStartMessage(connector.streams, connector.streamsToBackfill, priorState))}\n`
  );
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const lines = createInterface({ input: child.stdout, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    messages.push(JSON.parse(line) as EmittedMessage);
  }

  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  if (exitCode !== 0) {
    throw new Error(
      `${connector.connector_id} connector exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}`
    );
  }
  return messages;
}

function spawnConnector(
  connector: CollectorConnectorSpec,
  childContext: CollectorChildContext
): ChildProcessWithoutNullStreams {
  return spawn(connector.command, [...connector.args], {
    cwd: dirname(fileURLToPath(new URL("..", import.meta.url))),
    env: { ...process.env, ...buildCollectorChildEnv(childContext), ...connector.env },
  });
}

function chunkRecords<T>(records: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += size) {
    chunks.push(records.slice(index, index + size));
  }
  return chunks;
}

function nextBatchSeq(items: readonly LocalDeviceQueueItem[], sourceInstanceId: string): number {
  return (
    Math.max(0, ...items.filter((item) => item.source_instance_id === sourceInstanceId).map((item) => item.batch_seq)) +
    1
  );
}
