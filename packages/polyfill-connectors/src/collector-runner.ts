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
import {
  type EnrollmentExchangeResponse,
  type HeartbeatOutboxDiagnostics,
  LocalDeviceClient,
} from "./local-device-client.ts";
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

const COLLECTOR_GAP_DETAILS_MAX_CHARS = 300;
const KEYED_SECRET_RE =
  /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;
const OTP_RE = /\b\d{6}\b/g;
const LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const SCAN_BATCH_LIMIT_DETAIL_RE =
  /enqueued\s+\d+\s+batches\s+>=\s+(?:run batch limit|(?:maxEnqueuedBatchesPerRun|\[REDACTED\]))\s+(\d+)/;

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
 * - `maxDrainDurationMs`: wall-clock budget for a single drain pass.
 *   When exceeded, the drain stops cleanly between iterations and the
 *   remaining ready rows surface via the next runner invocation. Combined
 *   with `maxDrainIterations` this prevents a poisoned-but-fast outbox
 *   from monopolizing a runner invocation.
 * - `retryBackoffMs`: bounded backoff base; per-attempt grows linearly.
 * - `maxAttempts`: after this many failed attempts, the row dead-letters
 *   so it stops occupying drain bandwidth.
 * - `maxQueueDepth`: ceiling on pending-or-retrying outbox depth per
 *   source instance. When pending work crosses this ceiling the runner
 *   skips spawning a new connector child and surfaces an honest
 *   `blocked` heartbeat instead of growing the backlog further. The
 *   already-pending work continues to drain on subsequent invocations.
 * - `maxEnqueuedBatchesPerRun`: first-backfill/scan safety valve. When a
 *   connector emits more durable record batches than this during one
 *   invocation, the runner stops the child, records a retryable
 *   policy-budget gap, drains already-queued work, and refuses to commit
 *   checkpoint state for the interrupted scan.
 */
export interface CollectorOutboxPolicy {
  drainBatchSize: number;
  leaseMs: number;
  maxAttempts: number;
  maxDrainDurationMs: number;
  maxDrainIterations: number;
  maxEnqueuedBatchesPerRun: number;
  maxQueueDepth: number;
  retryBackoffMs: number;
}

export const DEFAULT_COLLECTOR_OUTBOX_POLICY: Readonly<CollectorOutboxPolicy> = Object.freeze({
  drainBatchSize: 4,
  leaseMs: 60_000,
  maxAttempts: 5,
  maxDrainDurationMs: 120_000,
  maxDrainIterations: 256,
  maxEnqueuedBatchesPerRun: 10_000,
  maxQueueDepth: 10_000,
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
  /**
   * True when a spawned connector was stopped by the per-run scan enqueue
   * budget. Already-emitted records remain durable; checkpoint state is
   * intentionally not committed because the scan boundary is incomplete.
   */
  scanBudgetExceeded: boolean;
  sentBatches: number;
  /**
   * True when the runner skipped scanning a source for new work because
   * durable work was already pending/retrying/leased/dead-letter for the
   * source instance. The connector child does not spawn in this case.
   */
  skippedScanForBacklog: boolean;
  /** True when the runner failed to persist accumulated STATE after a successful drain. */
  statePutFailed: boolean;
  /**
   * Highest number of unflushed RECORDs the streaming buffer held at once.
   * Bounded by `batchSize`; exposed so memory-bounding behavior can be
   * asserted in tests without inspecting heap usage directly.
   */
  streamingBufferHighWaterMark: number;
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
      connector_id: config.connector.connector_id,
      outbox: buildHeartbeatOutboxDiagnostics(postDrainSummary, {
        backlogOpen: countOpenBacklogGaps(outbox, config.sourceInstanceId),
      }),
      records_pending: pendingOutboxWorkCount(postDrainSummary),
      source_instance_id: config.sourceInstanceId,
      status: "starting",
    });

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
    const finalSummary = outbox.summary({ sourceInstanceId: config.sourceInstanceId });
    const recordsPending = pendingOutboxWorkCount(finalSummary);

    if (!checkpointResult.statePutFailed) {
      await client.heartbeat({
        connector_id: config.connector.connector_id,
        outbox: buildHeartbeatOutboxDiagnostics(finalSummary, {
          backlogOpen: countOpenBacklogGaps(outbox, config.sourceInstanceId),
        }),
        records_pending: recordsPending,
        source_instance_id: config.sourceInstanceId,
        status: streamResult.scanBudgetExceeded ? "retrying" : heartbeatStatusForSummary(finalSummary, policy),
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
      scanBudgetExceeded: streamResult.scanBudgetExceeded,
      statePutFailed: checkpointResult.statePutFailed,
      streamingBufferHighWaterMark: streamResult.bufferHighWaterMark,
    };
  } finally {
    outbox.close();
  }
}

interface MaybeSkipScanInput {
  client: Pick<LocalDeviceClient, "heartbeat">;
  config: CollectorRunConfig;
  outbox: LocalDeviceOutbox;
  policy: CollectorOutboxPolicy;
  postDrainSummary: LocalDeviceOutboxSummary;
  preScanDrain: DrainCollectorOutboxResult;
  recoveredLeases: number;
  satisfiedBindings: readonly RuntimeBindingName[];
}

async function maybeSkipScanForBacklog(input: MaybeSkipScanInput): Promise<CollectorRunResult | null> {
  if (!hasScanBlockingOutboxWork(input.outbox, input.config.sourceInstanceId, input.policy)) {
    return null;
  }
  const recordsPending = pendingOutboxWorkCount(input.postDrainSummary);
  // When the skip is triggered by the configured queue-depth ceiling we
  // record a durable gap row so the deferred scan is visible as
  // first-class diagnostic evidence (not just an in-flight heartbeat).
  // Skips caused by pre-existing pending work that is still well under
  // the ceiling do not get a gap row: that pending work is already
  // represented by its own outbox rows.
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
    done: null,
    enqueuedBatches: 0,
    flushedState: null,
    outboxSummary: summaryAfterGap,
    priorState: Object.freeze({}),
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

interface StreamConnectorIntoOutboxInput {
  abortSignal?: AbortSignal;
  batchSize: number;
  config: CollectorRunConfig;
  outbox: LocalDeviceOutbox;
  policy: CollectorOutboxPolicy;
  priorState: Readonly<Record<string, unknown>>;
}

interface StreamConnectorIntoOutboxResult {
  bufferedState: Readonly<Record<string, unknown>>;
  bufferHighWaterMark: number;
  done: Extract<EmittedMessage, { type: "DONE" }> | null;
  enqueuedBatches: number;
  recordsQueued: number;
  scanBudgetExceeded: boolean;
}

/**
 * Drive the connector child process and translate its protocol output
 * into durable outbox rows incrementally.
 *
 * Memory bounds:
 *
 * - At most `batchSize` RECORD messages are held in the streaming buffer
 *   at any time; the buffer flushes to a durable record_batch outbox row
 *   as soon as it fills.
 * - STATE messages are projected per-stream (last-wins) into a small
 *   in-memory map keyed by stream name. The map size is bounded by the
 *   connector's declared in-scope streams; out-of-scope STATE is dropped
 *   with the same stderr warning the buffered implementation used.
 * - DONE retains only the final `DONE` message (one reference).
 *
 * Failure semantics:
 *
 * - If the child exits non-zero (or stdout streaming fails), the function
 *   throws. Before throwing, any RECORD messages already parsed and
 *   accepted — including a partial trailing batch smaller than batchSize —
 *   are flushed into a durable record_batch row so the next runner
 *   invocation can drain them. STATE is intentionally NOT turned into a
 *   checkpoint outbox row here — the caller only enqueues a checkpoint
 *   after the record drain succeeds, so a mid-stream crash cannot
 *   advance the destination checkpoint past acknowledged work.
 */
async function streamConnectorIntoOutbox(
  input: StreamConnectorIntoOutboxInput
): Promise<StreamConnectorIntoOutboxResult> {
  throwIfAborted(input.abortSignal);

  const child = spawnConnector(input.config.connector, {
    baseUrl: input.config.baseUrl,
    deviceToken: input.config.deviceToken,
    ...(input.config.runId ? { runId: input.config.runId } : {}),
  });
  const stderr = new BoundedStderrBuffer(COLLECTOR_STDERR_MAX_BYTES);
  const inScopeStreams = new Set(input.config.connector.streams);
  const bufferedState: Record<string, unknown> = {};
  let batchSeq = nextOutboxBatchSeq(input.outbox, input.config.sourceInstanceId);
  let pendingRecords: Extract<EmittedMessage, { type: "RECORD" }>[] = [];
  let bufferHighWaterMark = 0;
  let recordsQueued = 0;
  let enqueuedBatches = 0;
  let done: Extract<EmittedMessage, { type: "DONE" }> | null = null;
  let scanBudgetExceeded = false;

  const flushPendingBatch = (): void => {
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
    scanBudgetExceeded = maybeRecordScanBudgetGap({
      enqueuedBatches,
      input,
      scanBudgetExceeded,
    });
  };

  const handleMessage = (message: EmittedMessage): void => {
    if (message.type === "RECORD") {
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
        process.stderr.write(
          `${input.config.connector.connector_id} dropped out-of-scope STATE for stream '${message.stream}'\n`
        );
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
  if (input.abortSignal && abortListener) {
    input.abortSignal.addEventListener("abort", abortListener, { once: true });
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
      handleMessage(JSON.parse(line) as EmittedMessage);
      if (scanBudgetExceeded) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore — child already exited
        }
        break;
      }
    }
  })();
  child.stdin.on("error", () => {
    // Missing commands or early child exits can close stdin before the
    // START line is accepted. The child error/exit path below is the
    // actionable diagnostic; do not mask it with EPIPE.
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(
    `${JSON.stringify(
      buildCollectorStartMessage(
        input.config.connector.streams,
        input.config.connector.streamsToBackfill,
        input.priorState
      )
    )}\n`
  );

  let exitCode: number | null;
  try {
    [exitCode] = await Promise.all([exitPromise, outputPromise]);
  } catch (error) {
    if (input.abortSignal && abortListener) {
      input.abortSignal.removeEventListener("abort", abortListener);
    }
    // Records already parsed and accepted before the failure must reach the
    // durable outbox; the next runner pass will drain them. State stays
    // buffered-only so the checkpoint cannot advance past acknowledged work.
    flushPendingBatch();
    const details = sanitizeCollectorGapDetails(error instanceof Error ? error.message : String(error));
    recordConnectorChildFailureGap({
      details,
      enqueuedBatches,
      input,
    });
    throw new Error(
      `${input.config.connector.connector_id} connector failed to start or stream output: ${details || "unknown error"}`
    );
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
    done: scanBudgetExceeded ? null : done,
    enqueuedBatches,
    recordsQueued,
    scanBudgetExceeded,
  };
}

function throwIfConnectorExitedUncleanly(input: {
  enqueuedBatches: number;
  exitCode: number | null;
  flushPendingBatch: () => void;
  input: StreamConnectorIntoOutboxInput;
  scanBudgetExceeded: boolean;
  stderr: BoundedStderrBuffer;
}): void {
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
  throw new Error(
    `${input.input.config.connector.connector_id} connector exited ${input.exitCode}: ${details || "unknown error"}`
  );
}

function maybeRecordScanBudgetGap(input: {
  enqueuedBatches: number;
  input: StreamConnectorIntoOutboxInput;
  scanBudgetExceeded: boolean;
}): boolean {
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

/**
 * Persist a `connector_child_failure` gap row when the connector child
 * crashes after the runner already flushed at least one durable record
 * batch for this source instance. Skipping the gap when no records
 * were flushed avoids inventing a known-incomplete-unit when there is
 * no partial progress to attribute — the throw and surrounding
 * heartbeat are already the honest signal.
 */
function recordConnectorChildFailureGap(input: {
  details: string;
  enqueuedBatches: number;
  input: StreamConnectorIntoOutboxInput;
}): void {
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

async function maybeCommitCheckpoint(input: {
  afterRecordsSummary: LocalDeviceOutboxSummary;
  bufferedState: Readonly<Record<string, unknown>>;
  client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "heartbeat" | "ingestBatch" | "putSourceInstanceState">;
  config: CollectorRunConfig;
  holderId: string;
  outbox: LocalDeviceOutbox;
  policy: CollectorOutboxPolicy;
}): Promise<{ flushedState: Readonly<Record<string, unknown>> | null; statePutFailed: boolean }> {
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
  process.stderr.write(
    `${input.config.connector.connector_id} checkpoint not yet committed (drained ${checkpointDrain.sent} this pass; ${checkpointAfter?.last_error ?? "no error"})\n`
  );
  return { flushedState: null, statePutFailed: true };
}

async function recoverResolvedLocalCollectorGaps(input: {
  client: Pick<LocalDeviceClient, "recoverLocalCollectorGap">;
  config: CollectorRunConfig;
  deferRecoveredGapCleanup?: boolean;
  outbox: LocalDeviceOutbox;
}): Promise<void> {
  if (input.deferRecoveredGapCleanup) {
    return;
  }
  if (hasCheckpointBlockingOutboxWork(input.outbox, input.config.sourceInstanceId)) {
    return;
  }
  const succeededGaps = input.outbox
    .list({ sourceInstanceId: input.config.sourceInstanceId })
    .filter((item) => item.kind === "gap" && item.status === "succeeded");
  for (const item of succeededGaps) {
    let payload: GapPayload;
    try {
      payload = assertGapPayload(item.payload, item.id);
    } catch (error) {
      process.stderr.write(
        `${input.config.connector.connector_id} skipped malformed succeeded gap recovery ${item.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
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
    } catch (error) {
      process.stderr.write(
        `${input.config.connector.connector_id} local gap recovery deferred for ${item.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }
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

/**
 * Machine-readable reason taxonomy for `gap` outbox rows. Kept narrow to
 * runner-knowable conditions so connector-specific failure modes do not
 * leak into a shared schema. Connectors that need richer reasons can
 * carry them as opaque `details` in {@link GapPayload}.
 *
 * - `policy_budget`: the runner deferred work because a configured bound
 *   (queue depth, duration, etc.) would otherwise grow the backlog past
 *   the policy ceiling. Retryable: a future invocation can drain and try
 *   again.
 * - `connector_child_failure`: the connector child process exited
 *   abnormally (non-zero exit, stream parse error, or stdin close)
 *   after the runner already flushed at least one durable record batch
 *   for this source instance. The boundary that was partially covered
 *   is preserved so the next invocation can target it.
 */
export type GapReason = "policy_budget" | "connector_child_failure";

/**
 * `gap` outbox payload shape. Records known incomplete or deferred work
 * the runner can describe generically. Stream/boundary identity is
 * optional because the runner cannot always know which stream a child
 * failed on; when absent the gap is scoped to the source instance.
 *
 * Payload fields are stable across re-observations so re-enqueue with a
 * deterministic id is idempotent. Per-attempt metadata (last-attempt
 * timestamp, attempt count, next attempt time) lives on the outbox row
 * itself (`updated_at`, `attempt_count`, `next_attempt_at`,
 * `last_error`) — not in the payload — so an operator surface can
 * project both first-seen (payload) and last-attempt (row) without
 * mutating the body hash.
 *
 * Validated narrowly before sending so malformed rows dead-letter
 * instead of poisoning the drain loop.
 */
export interface GapPayload {
  connectorId: string;
  /** Opaque diagnostic detail (already-redacted free-form text). */
  details?: string;
  /** ISO timestamp of the first run that observed this gap. */
  firstSeenAt: string;
  /** Run id of the first run that observed this gap, when known. */
  firstSeenRunId?: string;
  /**
   * Next-attempt policy hint, expressed as a bounded backoff in
   * milliseconds. The drain loop owns actual scheduling; this field
   * advertises the intended cadence so operator surfaces can show
   * "retries every N minutes" without inspecting drain code.
   */
  nextAttemptBackoffMs: number;
  reason: GapReason;
  /**
   * When true, the gap describes work that can still be retried (e.g.
   * policy budget). When false, the gap is terminal until external
   * action resolves it. Gap rows track retryability semantically; the
   * outbox row status still moves only via leases.
   */
  retryable: boolean;
  sourceInstanceId: string;
  /** Optional stream name when the runner can attribute the gap. */
  stream?: string;
  /**
   * Optional opaque boundary identity (e.g. a partition key, file path,
   * date window). Free-form; the runner does not interpret it.
   */
  streamBoundary?: string;
}

interface EnsureGapInput {
  clock: () => Date;
  connectorId: string;
  details?: string;
  outbox: LocalDeviceOutbox;
  reason: GapReason;
  retryable: boolean;
  runId?: string;
  sourceInstanceId: string;
  stream?: string;
  streamBoundary?: string;
}

/**
 * Persist a gap row durably for the given source instance. Idempotent
 * over the (connectorId, sourceInstanceId, reason, stream, streamBoundary)
 * tuple so re-observing the same condition on a later run does not
 * accumulate new rows — last-attempt metadata is observable from the
 * existing outbox row's `updated_at`/`next_attempt_at`/`attempt_count`
 * after the drain leases it again.
 */
function ensureCollectorGapRow(input: EnsureGapInput): LocalDeviceOutboxItem {
  const firstSeenAt = input.clock().toISOString();
  const idParts: unknown[] = [
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
  const payload: GapPayload = {
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

function sanitizeCollectorGapDetails(value: string): string {
  let next = String(value)
    .replace(KEYED_SECRET_RE, (_match, marker: string) => `${marker}=[REDACTED]`)
    .replace(OTP_RE, "[REDACTED_OTP]")
    .replace(LONG_OPAQUE_RE, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  if (next.length > COLLECTOR_GAP_DETAILS_MAX_CHARS) {
    next = `${next.slice(0, COLLECTOR_GAP_DETAILS_MAX_CHARS - 1)}…`;
  }
  return next;
}

export interface DrainCollectorOutboxInput {
  abortSignal?: AbortSignal;
  client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState">;
  connectorId: string;
  holderId: string;
  outbox: LocalDeviceOutbox;
  policy: CollectorOutboxPolicy;
  sourceInstanceId?: string;
}

export interface DrainCollectorOutboxResult {
  deadLettered: number;
  /** True when the drain stopped because the duration budget was exceeded. */
  durationBudgetExceeded: boolean;
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
  const result: DrainCollectorOutboxResult = {
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

function claimReadyOutboxItems(input: DrainCollectorOutboxInput): LocalDeviceOutboxItem[] {
  const nextReady = nextReadyOutboxItem(input);
  if (!nextReady) {
    return [];
  }
  if (nextReady.kind === "checkpoint" && hasCheckpointPredecessorBlockingWork(input.outbox, nextReady)) {
    return [];
  }
  const claimInput: Parameters<LocalDeviceOutbox["claimReady"]>[0] = {
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

function nextReadyOutboxItem(input: DrainCollectorOutboxInput): LocalDeviceOutboxItem | null {
  return input.outbox.peekReady(input.sourceInstanceId ? { sourceInstanceId: input.sourceInstanceId } : {});
}

function hasCheckpointPredecessorBlockingWork(outbox: LocalDeviceOutbox, checkpoint: LocalDeviceOutboxItem): boolean {
  return outbox.list({ sourceInstanceId: checkpoint.source_instance_id }).some((item) => {
    if (item.id === checkpoint.id) {
      return false;
    }
    if (item.insert_order >= checkpoint.insert_order) {
      return false;
    }
    return (item.kind === "record_batch" || item.kind === "gap") && item.status !== "succeeded";
  });
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

/**
 * Default next-attempt backoff hint advertised in {@link GapPayload}. The
 * payload value is a stable description of the cadence at which the
 * runner would re-observe the same gap on a future invocation; the
 * actual drain scheduling is owned by the outbox lease + retry policy,
 * not by this field.
 */
const DEFAULT_GAP_RETRY_BACKOFF_MS = 15 * 60_000;

async function sendOutboxItem(
  client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState">,
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
  if (item.kind === "gap") {
    // Validate first so a malformed gap dead-letters via OutboxPayloadShapeError
    // before any HTTP call.
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

function assertGapPayload(payload: unknown, id: string): GapPayload {
  if (!isRecord(payload)) {
    throw new OutboxPayloadShapeError(`gap payload is not an object: ${id}`);
  }
  if (
    typeof payload.connectorId !== "string" ||
    typeof payload.sourceInstanceId !== "string" ||
    typeof payload.firstSeenAt !== "string" ||
    typeof payload.nextAttemptBackoffMs !== "number" ||
    typeof payload.retryable !== "boolean" ||
    (payload.reason !== "policy_budget" && payload.reason !== "connector_child_failure") ||
    (payload.stream !== undefined && typeof payload.stream !== "string") ||
    (payload.streamBoundary !== undefined && typeof payload.streamBoundary !== "string") ||
    (payload.firstSeenRunId !== undefined && typeof payload.firstSeenRunId !== "string") ||
    (payload.details !== undefined && typeof payload.details !== "string")
  ) {
    throw new OutboxPayloadShapeError(`gap payload missing or invalid fields: ${id}`);
  }
  const gap: GapPayload = {
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

function hasScanBlockingOutboxWork(
  outbox: LocalDeviceOutbox,
  sourceInstanceId: string,
  policy: Pick<CollectorOutboxPolicy, "maxEnqueuedBatchesPerRun">
): boolean {
  return outbox.list({ sourceInstanceId }).some((item) => {
    if (item.kind !== "gap") {
      return item.status !== "succeeded";
    }
    return isUnresolvedScanBudgetGap(item, policy);
  });
}

function hasCheckpointBlockingOutboxWork(outbox: LocalDeviceOutbox, sourceInstanceId: string): boolean {
  return outbox.list({ sourceInstanceId }).some((item) => item.status !== "succeeded");
}

function isUnresolvedScanBudgetGap(
  item: LocalDeviceOutboxItem,
  policy: Pick<CollectorOutboxPolicy, "maxEnqueuedBatchesPerRun">
): boolean {
  if (item.status === "dead_letter") {
    return false;
  }
  let payload: GapPayload;
  try {
    payload = assertGapPayload(item.payload, item.id);
  } catch {
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

function heartbeatStatusForSummary(
  summary: LocalDeviceOutboxSummary,
  policy?: Pick<CollectorOutboxPolicy, "maxQueueDepth">
): "blocked" | "healthy" | "retrying" {
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

export function buildHeartbeatOutboxDiagnostics(
  summary: LocalDeviceOutboxSummary,
  options: { backlogOpen?: number } = {}
): HeartbeatOutboxDiagnostics {
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

function countOpenBacklogGaps(outbox: LocalDeviceOutbox, sourceInstanceId: string): number {
  return outbox
    .list({ sourceInstanceId })
    .filter((item) => item.kind === "gap" && (item.status === "ready" || item.status === "leased")).length;
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
