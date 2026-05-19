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
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { EmittedMessage, StartMessage, StreamScope } from "./connector-runtime-protocol.ts";
import { type EnrollmentExchangeResponse, LocalDeviceClient } from "./local-device-client.ts";
import {
  buildLocalDeviceRecordEnvelope,
  hashCanonicalJson,
  type LocalDeviceRecordEnvelope,
} from "./local-device-envelope.ts";
import {
  buildLocalDeviceOutboxId,
  LocalDeviceOutbox,
  type LocalDeviceOutboxItem,
  type LocalDeviceOutboxSummary,
} from "./local-device-outbox.ts";
import type { LocalDeviceQueue, LocalDeviceQueueItem } from "./local-device-queue.ts";
import {
  assertPlacementOrThrow,
  COLLECTOR_RUNTIME_CAPABILITIES,
  type ConnectorPlacementInput,
  type RuntimeBindingName,
} from "./runtime-capabilities.ts";

/**
 * Maximum stderr bytes retained from a connector child before the runner
 * truncates and notes the drop. Connector failures should surface in the
 * exit-code error message; large local backfills can otherwise emit
 * progress logs that would balloon the runner's heap before the child
 * exits. 256 KiB keeps a meaningful tail without becoming a memory risk.
 */
export const COLLECTOR_STDERR_MAX_BYTES = 256 * 1024;

/**
 * Default policy bounds for durable outbox drains. These are intentionally
 * conservative; callers may override via `CollectorRunConfig.outboxPolicy`.
 *
 * - `leaseMs`: how long a claimed row stays leased before
 *   `recoverExpiredLeases` reclaims it. Must exceed worst-case ingest RTT.
 * - `drainBatchSize`: rows claimed per drain iteration.
 * - `maxDrainIterations`: hard ceiling so a single runner invocation can
 *   never spin forever on a poisoned outbox; remaining work surfaces via
 *   heartbeat and the next invocation continues.
 * - `retryBackoffMs`: bounded backoff base; per-attempt grows linearly.
 * - `maxAttempts`: after this many failed attempts, the row dead-letters
 *   so it stops occupying drain bandwidth.
 */
export interface CollectorOutboxPolicy {
  drainBatchSize: number;
  leaseMs: number;
  maxAttempts: number;
  maxDrainIterations: number;
  retryBackoffMs: number;
}

export const DEFAULT_COLLECTOR_OUTBOX_POLICY: Readonly<CollectorOutboxPolicy> = Object.freeze({
  drainBatchSize: 4,
  leaseMs: 60_000,
  maxAttempts: 5,
  maxDrainIterations: 256,
  retryBackoffMs: 30_000,
});

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

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
  /**
   * Optional cooperative cancellation signal. When aborted, the runner
   * tears down the connector child process, stops draining the queue at
   * the next safe boundary, and surfaces an AbortError. Honored at the
   * pre-spawn capability gate, the prior-state read, child stdout
   * consumption, and between queue drain iterations.
   */
  abortSignal?: AbortSignal;
  baseUrl: string;
  batchSize?: number;
  /**
   * Stable identifier for the runner instance holding outbox leases. When
   * omitted, a fresh UUID is generated per invocation. Tests and host
   * supervisors that need predictable lease holders (e.g. for assertions
   * about which holder must acknowledge) can pin this.
   */
  collectorHolderId?: string;
  connector: CollectorConnectorSpec;
  deviceId: string;
  deviceToken: string;
  /**
   * Path to the durable SQLite outbox. The legacy `queuePath` field is
   * accepted as a fallback when this is omitted so existing call sites
   * (CLI, tests) keep working as the implementation cuts over.
   */
  outboxPath?: string;
  /**
   * Override drain/retry bounds. Defaults to {@link DEFAULT_COLLECTOR_OUTBOX_POLICY}.
   */
  outboxPolicy?: Partial<CollectorOutboxPolicy>;
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
   * Null when STATE was buffered but the flush was skipped because the
   * outbox still held undrained record work, or when no in-scope STATE
   * was emitted.
   */
  flushedState: Readonly<Record<string, unknown>> | null;
  /**
   * Outbox summary after this invocation's drain. Operators use it to
   * decide between rescheduling (pending/retrying > 0) and idle.
   */
  outboxSummary: LocalDeviceOutboxSummary;
  /** Prior state replayed into the START message (empty when first run). */
  priorState: Readonly<Record<string, unknown>>;
  recordsQueued: number;
  /**
   * Number of leases recovered before scan/spawn. Non-zero means the
   * previous runner instance crashed mid-drain and left work claimed.
   */
  recoveredLeases: number;
  satisfiedBindings: readonly RuntimeBindingName[];
  sentBatches: number;
  /**
   * True when the runner skipped scanning a source for new work because
   * durable work was already pending/retrying/leased/dead-letter for the
   * source instance. The connector child does not spawn in this case.
   */
  skippedScanForBacklog: boolean;
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
 * Post-spawn: builds device-scoped envelopes, enqueues them in the
 * durable outbox, drains acknowledged work against the device-exporter
 * ingest endpoint, and heartbeats start/healthy.
 */
export async function runCollectorConnector(config: CollectorRunConfig): Promise<CollectorRunResult> {
  throwIfAborted(config.abortSignal);
  const satisfiedBindings = assertPlacementOrThrow(config.connector, COLLECTOR_RUNTIME_CAPABILITIES);

  const policy: CollectorOutboxPolicy = { ...DEFAULT_COLLECTOR_OUTBOX_POLICY, ...(config.outboxPolicy ?? {}) };
  const holderId = config.collectorHolderId ?? randomUUID();
  const outboxPath = config.outboxPath ?? config.queuePath;
  const outbox = new LocalDeviceOutbox({ path: outboxPath });
  const client = new LocalDeviceClient({
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    deviceToken: config.deviceToken,
  });

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
      client,
      config,
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
      connector_id: config.connector.connector_id,
      records_pending: pendingOutboxWorkCount(postDrainSummary),
      source_instance_id: config.sourceInstanceId,
      status: "starting",
    });

    const messages = await collectMessagesForRun(config, priorState);
    const records = messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
    const done =
      messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE") ?? null;

    const inScopeStreams = new Set(config.connector.streams);
    const bufferedState = projectEmittedState(messages, inScopeStreams, config.connector.connector_id);
    const enqueueResult = enqueueRecordBatches({
      batchSize: config.batchSize ?? 100,
      config,
      outbox,
      records,
    });

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

    const finalSummary = outbox.summary({ sourceInstanceId: config.sourceInstanceId });
    const recordsPending = pendingOutboxWorkCount(finalSummary);

    if (!checkpointResult.statePutFailed) {
      await client.heartbeat({
        connector_id: config.connector.connector_id,
        records_pending: recordsPending,
        source_instance_id: config.sourceInstanceId,
        status: heartbeatStatusForSummary(finalSummary),
      });
    }

    return {
      done,
      enqueuedBatches: enqueueResult.enqueuedBatches,
      flushedState: checkpointResult.flushedState,
      outboxSummary: finalSummary,
      priorState,
      recordsQueued: enqueueResult.recordsQueued,
      recoveredLeases,
      satisfiedBindings,
      sentBatches: (preScanDrain.sentByKind.record_batch ?? 0) + (recordDrain.sentByKind.record_batch ?? 0),
      skippedScanForBacklog: false,
      statePutFailed: checkpointResult.statePutFailed,
    };
  } finally {
    outbox.close();
  }
}

interface MaybeSkipScanInput {
  client: Pick<LocalDeviceClient, "heartbeat">;
  config: CollectorRunConfig;
  postDrainSummary: LocalDeviceOutboxSummary;
  preScanDrain: DrainCollectorOutboxResult;
  recoveredLeases: number;
  satisfiedBindings: readonly RuntimeBindingName[];
}

async function maybeSkipScanForBacklog(input: MaybeSkipScanInput): Promise<CollectorRunResult | null> {
  if (!hasBlockingOutboxWork(input.postDrainSummary)) {
    return null;
  }
  const recordsPending = pendingOutboxWorkCount(input.postDrainSummary);
  await safeHeartbeat(input.client, {
    connector_id: input.config.connector.connector_id,
    records_pending: recordsPending,
    source_instance_id: input.config.sourceInstanceId,
    status: heartbeatStatusForSummary(input.postDrainSummary),
  });
  return {
    done: null,
    enqueuedBatches: 0,
    flushedState: null,
    outboxSummary: input.postDrainSummary,
    priorState: Object.freeze({}),
    recordsQueued: 0,
    recoveredLeases: input.recoveredLeases,
    satisfiedBindings: input.satisfiedBindings,
    sentBatches: input.preScanDrain.sentByKind.record_batch ?? 0,
    skippedScanForBacklog: true,
    statePutFailed: false,
  };
}

async function readPriorStateOrBlock(input: {
  client: Pick<LocalDeviceClient, "getSourceInstanceState" | "heartbeat">;
  config: CollectorRunConfig;
  recordsPending: number;
}): Promise<Readonly<Record<string, unknown>>> {
  try {
    throwIfAborted(input.config.abortSignal);
    const projection = await input.client.getSourceInstanceState({ sourceInstanceId: input.config.sourceInstanceId });
    return projection.state && typeof projection.state === "object"
      ? Object.freeze({ ...projection.state })
      : Object.freeze({});
  } catch (error) {
    await safeHeartbeat(input.client, {
      connector_id: input.config.connector.connector_id,
      records_pending: input.recordsPending,
      source_instance_id: input.config.sourceInstanceId,
      status: "blocked",
    });
    throw new CollectorStateReadError(
      `failed to read prior state for ${input.config.sourceInstanceId}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

async function collectMessagesForRun(
  config: CollectorRunConfig,
  priorState: Readonly<Record<string, unknown>>
): Promise<EmittedMessage[]> {
  throwIfAborted(config.abortSignal);
  return await collectConnectorMessages(
    config.connector,
    {
      baseUrl: config.baseUrl,
      deviceToken: config.deviceToken,
      ...(config.runId ? { runId: config.runId } : {}),
    },
    priorState,
    config.abortSignal
  );
}

function enqueueRecordBatches(input: {
  batchSize: number;
  config: CollectorRunConfig;
  outbox: LocalDeviceOutbox;
  records: readonly Extract<EmittedMessage, { type: "RECORD" }>[];
}): { enqueuedBatches: number; recordsQueued: number } {
  let recordsQueued = 0;
  let enqueuedBatches = 0;
  let batchSeq = nextOutboxBatchSeq(input.outbox, input.config.sourceInstanceId);
  for (const chunk of chunkRecords(input.records, input.batchSize)) {
    const batchId = buildOutboxBatchId({
      batchSeq,
      connectorId: input.config.connector.connector_id,
      records: chunk,
      sourceInstanceId: input.config.sourceInstanceId,
    });
    const envelopes = chunk.map((record) =>
      buildLocalDeviceRecordEnvelope({
        batchId,
        batchSeq,
        connectorId: input.config.connector.connector_id,
        deviceId: input.config.deviceId,
        record,
        sourceInstanceId: input.config.sourceInstanceId,
      })
    );
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
      } satisfies RecordBatchPayload,
      sourceInstanceId: input.config.sourceInstanceId,
    });
    recordsQueued += envelopes.length;
    enqueuedBatches++;
    batchSeq++;
  }
  return { enqueuedBatches, recordsQueued };
}

async function maybeCommitCheckpoint(input: {
  afterRecordsSummary: LocalDeviceOutboxSummary;
  bufferedState: Readonly<Record<string, unknown>>;
  client: Pick<LocalDeviceClient, "heartbeat" | "ingestBatch" | "putSourceInstanceState">;
  config: CollectorRunConfig;
  holderId: string;
  outbox: LocalDeviceOutbox;
  policy: CollectorOutboxPolicy;
}): Promise<{ flushedState: Readonly<Record<string, unknown>> | null; statePutFailed: boolean }> {
  if (hasBlockingOutboxWork(input.afterRecordsSummary) || Object.keys(input.bufferedState).length === 0) {
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
    } satisfies CheckpointPayload,
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

  await safeHeartbeat(input.client, {
    connector_id: input.config.connector.connector_id,
    records_pending: pendingOutboxWorkCount(input.afterRecordsSummary),
    source_instance_id: input.config.sourceInstanceId,
    status: "retrying",
  });
  process.stderr.write(
    `${input.config.connector.connector_id} checkpoint not yet committed (drained ${checkpointDrain.sent} this pass; ${checkpointAfter?.last_error ?? "no error"})\n`
  );
  return { flushedState: null, statePutFailed: true };
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

/**
 * `record_batch` outbox payload shape. Validated narrowly before sending
 * so malformed rows dead-letter instead of poisoning the drain loop.
 */
export interface RecordBatchPayload {
  batchId: string;
  batchSeq: number;
  connectorId: string;
  deviceId: string;
  records: LocalDeviceRecordEnvelope[];
  sourceInstanceId: string;
}

/**
 * `checkpoint` outbox payload shape. Validated narrowly before sending.
 */
export interface CheckpointPayload {
  connectorId: string;
  sourceInstanceId: string;
  state: Record<string, unknown>;
}

export interface DrainCollectorOutboxInput {
  abortSignal?: AbortSignal;
  client: Pick<LocalDeviceClient, "ingestBatch" | "putSourceInstanceState">;
  connectorId: string;
  holderId: string;
  outbox: LocalDeviceOutbox;
  policy: CollectorOutboxPolicy;
  sourceInstanceId?: string;
}

export interface DrainCollectorOutboxResult {
  deadLettered: number;
  failed: number;
  iterations: number;
  sent: number;
  /** Acknowledged-this-pass counts broken down by outbox row kind. */
  sentByKind: Readonly<Partial<Record<LocalDeviceOutboxItem["kind"], number>>>;
}

/**
 * Drain ready durable outbox rows for a source instance.
 *
 * Acknowledges only after a successful destination call. Retries with
 * bounded backoff up to `policy.maxAttempts`, then dead-letters the row
 * so it stops occupying drain bandwidth.
 *
 * Iterates at most `policy.maxDrainIterations` times so a single
 * invocation cannot spin. Remaining ready rows surface via the next
 * runner pass.
 */
export async function drainCollectorOutbox(input: DrainCollectorOutboxInput): Promise<DrainCollectorOutboxResult> {
  const sentByKind: Partial<Record<LocalDeviceOutboxItem["kind"], number>> = {};
  const result: DrainCollectorOutboxResult = { deadLettered: 0, failed: 0, iterations: 0, sent: 0, sentByKind };
  for (let i = 0; i < input.policy.maxDrainIterations; i++) {
    throwIfAborted(input.abortSignal);
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

function claimReadyOutboxItems(input: DrainCollectorOutboxInput): LocalDeviceOutboxItem[] {
  const claimInput: Parameters<LocalDeviceOutbox["claimReady"]>[0] = {
    holder: input.holderId,
    leaseMs: input.policy.leaseMs,
    limit: input.policy.drainBatchSize,
  };
  if (input.sourceInstanceId) {
    claimInput.sourceInstanceId = input.sourceInstanceId;
  }
  return input.outbox.claimReady(claimInput);
}

async function drainClaimedOutboxItem(
  input: DrainCollectorOutboxInput,
  item: LocalDeviceOutboxItem,
  result: DrainCollectorOutboxResult,
  sentByKind: Partial<Record<LocalDeviceOutboxItem["kind"], number>>
): Promise<void> {
  throwIfAborted(input.abortSignal);
  try {
    await sendOutboxItem(input.client, item);
    input.outbox.acknowledge({ holder: input.holderId, id: item.id, leaseEpoch: item.lease_epoch });
    result.sent++;
    sentByKind[item.kind] = (sentByKind[item.kind] ?? 0) + 1;
  } catch (error) {
    failOutboxItem(input, item, error, result);
  }
}

function failOutboxItem(
  input: DrainCollectorOutboxInput,
  item: LocalDeviceOutboxItem,
  error: unknown,
  result: DrainCollectorOutboxResult
): void {
  const message = error instanceof Error ? error.message : String(error);
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

class OutboxPayloadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxPayloadShapeError";
  }
}

async function sendOutboxItem(
  client: Pick<LocalDeviceClient, "ingestBatch" | "putSourceInstanceState">,
  item: LocalDeviceOutboxItem
): Promise<void> {
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
  throw new OutboxPayloadShapeError(`unsupported outbox kind ${item.kind} for id ${item.id}`);
}

function assertRecordBatchPayload(payload: unknown, id: string): RecordBatchPayload {
  if (!isRecord(payload)) {
    throw new OutboxPayloadShapeError(`record_batch payload is not an object: ${id}`);
  }
  if (
    typeof payload.batchId !== "string" ||
    typeof payload.batchSeq !== "number" ||
    typeof payload.connectorId !== "string" ||
    typeof payload.deviceId !== "string" ||
    typeof payload.sourceInstanceId !== "string" ||
    !Array.isArray(payload.records) ||
    !payload.records.every(isLocalDeviceRecordEnvelope)
  ) {
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

function assertCheckpointPayload(payload: unknown, id: string): CheckpointPayload {
  if (!isRecord(payload)) {
    throw new OutboxPayloadShapeError(`checkpoint payload is not an object: ${id}`);
  }
  if (
    typeof payload.connectorId !== "string" ||
    typeof payload.sourceInstanceId !== "string" ||
    !isRecord(payload.state)
  ) {
    throw new OutboxPayloadShapeError(`checkpoint payload missing required fields: ${id}`);
  }
  return {
    connectorId: payload.connectorId,
    sourceInstanceId: payload.sourceInstanceId,
    state: payload.state,
  };
}

function isLocalDeviceRecordEnvelope(value: unknown): value is LocalDeviceRecordEnvelope {
  return (
    isRecord(value) &&
    typeof value.batch_id === "string" &&
    typeof value.batch_seq === "number" &&
    typeof value.body_hash === "string" &&
    typeof value.connector_id === "string" &&
    isRecord(value.data) &&
    typeof value.device_id === "string" &&
    typeof value.emitted_at === "string" &&
    typeof value.record_key === "string" &&
    typeof value.source_instance_id === "string" &&
    typeof value.stream === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildOutboxBatchId(input: {
  batchSeq: number;
  connectorId: string;
  records: readonly Extract<EmittedMessage, { type: "RECORD" }>[];
  sourceInstanceId: string;
}): string {
  return `local-batch:${hashCanonicalJson({
    batch_seq: input.batchSeq,
    connector_id: input.connectorId,
    records: input.records.map((record) => ({
      data: record.data,
      key: String(record.key),
      stream: record.stream,
    })),
    source_instance_id: input.sourceInstanceId,
  })}`;
}

function pendingOutboxWorkCount(summary: LocalDeviceOutboxSummary): number {
  return summary.ready + summary.leased;
}

function hasBlockingOutboxWork(summary: LocalDeviceOutboxSummary): boolean {
  return pendingOutboxWorkCount(summary) > 0 || summary.deadLetter > 0;
}

function heartbeatStatusForSummary(summary: LocalDeviceOutboxSummary): "blocked" | "healthy" | "retrying" {
  if (summary.deadLetter > 0) {
    return "blocked";
  }
  if (pendingOutboxWorkCount(summary) > 0) {
    return "retrying";
  }
  return "healthy";
}

function nextOutboxBatchSeq(outbox: LocalDeviceOutbox, sourceInstanceId: string): number {
  const items = outbox.list({ sourceInstanceId });
  let max = 0;
  for (const item of items) {
    if (item.kind !== "record_batch") {
      continue;
    }
    const payload = item.payload as { batchSeq?: unknown };
    if (typeof payload?.batchSeq === "number" && payload.batchSeq > max) {
      max = payload.batchSeq;
    }
  }
  return max + 1;
}

export async function drainCollectorQueue(input: {
  abortSignal?: AbortSignal;
  client: Pick<LocalDeviceClient, "ingestBatch">;
  queue: LocalDeviceQueue;
}): Promise<number> {
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
    } catch (error) {
      await input.queue.markRetry(item.batch_id, error instanceof Error ? error.message : String(error));
      return sent;
    }
  }
}

/**
 * Drain-before-scan helper for the durable outbox path.
 *
 * Recovers expired leases first so any work abandoned by a previous
 * runner becomes claimable, then exposes a summary the caller can use
 * to decide whether to scan a source for new work or finish out the
 * existing backlog. Matches the design-note ordering: recover, drain
 * acknowledged-safe pending work, only then scan more source data.
 */
export function recoverAndSummarizeOutbox(
  outbox: Pick<LocalDeviceOutbox, "recoverExpiredLeases" | "summary">,
  input: { sourceInstanceId?: string } = {}
): { recovered: number; summary: ReturnType<LocalDeviceOutbox["summary"]> } {
  const recovered = input.sourceInstanceId
    ? outbox.recoverExpiredLeases({ sourceInstanceId: input.sourceInstanceId })
    : outbox.recoverExpiredLeases();
  const summary = input.sourceInstanceId
    ? outbox.summary({ sourceInstanceId: input.sourceInstanceId })
    : outbox.summary();
  return { recovered, summary };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
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
  priorState?: Readonly<Record<string, unknown>>,
  abortSignal?: AbortSignal
): Promise<EmittedMessage[]> {
  const child = spawnConnector(connector, childContext);
  const messages: EmittedMessage[] = [];
  const stderr = new BoundedStderrBuffer(COLLECTOR_STDERR_MAX_BYTES);

  const abortListener = abortSignal
    ? () => {
        // Best-effort: SIGTERM, then escalate to SIGKILL if the child
        // is still alive shortly after. The child's exit code will
        // surface as a non-zero exit and the abort error will be
        // re-thrown to the caller below.
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore — child already exited
        }
        setTimeout(() => {
          try {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          } catch {
            // ignore
          }
        }, 1000).unref?.();
      }
    : null;
  if (abortSignal && abortListener) {
    abortSignal.addEventListener("abort", abortListener, { once: true });
  }

  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const outputPromise = (async () => {
    const lines = createInterface({ input: child.stdout, terminal: false });
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      messages.push(JSON.parse(line) as EmittedMessage);
    }
  })();
  child.stdin.on("error", () => {
    // Missing commands or early child exits can close stdin before the
    // START line is accepted. The child error/exit path below is the
    // actionable diagnostic; do not mask it with EPIPE.
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(
    `${JSON.stringify(buildCollectorStartMessage(connector.streams, connector.streamsToBackfill, priorState))}\n`
  );

  let exitCode: number | null;
  try {
    [exitCode] = await Promise.all([exitPromise, outputPromise]);
  } catch (error) {
    if (abortSignal && abortListener) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    throw new Error(
      `${connector.connector_id} connector failed to start or stream output: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (abortSignal && abortListener) {
    abortSignal.removeEventListener("abort", abortListener);
  }
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error ? abortSignal.reason : new DOMException("Aborted", "AbortError");
  }
  if (exitCode !== 0) {
    throw new Error(`${connector.connector_id} connector exited ${exitCode}: ${stderr.toString().trim()}`);
  }
  return messages;
}

/**
 * Fixed-capacity stderr ring. Connectors emitting verbose progress logs
 * can otherwise pin proportional heap during long backfills. We retain
 * the tail (which carries the actionable failure message) and prepend a
 * truncation marker when bytes were dropped.
 */
class BoundedStderrBuffer {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #dropped = 0;

  constructor(limit: number) {
    this.#limit = Math.max(1024, limit);
  }

  push(chunk: Buffer): void {
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

  toString(): string {
    const body = Buffer.concat(this.#chunks).toString("utf8");
    if (this.#dropped === 0) {
      return body;
    }
    return `[truncated ${this.#dropped} stderr bytes]\n${body}`;
  }
}

function spawnConnector(
  connector: CollectorConnectorSpec,
  childContext: CollectorChildContext
): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...buildCollectorChildEnv(childContext), ...connector.env };
  env.PATH = buildCollectorChildPath(env.PATH);
  return spawn(connector.command, [...connector.args], {
    cwd: PACKAGE_ROOT,
    env,
  });
}

function buildCollectorChildPath(pathValue: string | undefined): string {
  return [join(PACKAGE_ROOT, "node_modules", ".bin"), join(REPO_ROOT, "node_modules", ".bin"), pathValue]
    .filter((part): part is string => Boolean(part))
    .join(delimiter);
}

function chunkRecords<T>(records: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += size) {
    chunks.push(records.slice(index, index + size));
  }
  return chunks;
}
