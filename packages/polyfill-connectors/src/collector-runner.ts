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
import type { LocalDeviceOutbox } from "./local-device-outbox.ts";
import { LocalDeviceQueue, type LocalDeviceQueueItem } from "./local-device-queue.ts";
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
  throwIfAborted(config.abortSignal);
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
    throwIfAborted(config.abortSignal);
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

  throwIfAborted(config.abortSignal);
  const messages = await collectConnectorMessages(
    config.connector,
    {
      baseUrl: config.baseUrl,
      deviceToken: config.deviceToken,
      ...(config.runId ? { runId: config.runId } : {}),
    },
    priorState,
    config.abortSignal
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

  const sentBatches = await drainCollectorQueue({
    client,
    queue,
    ...(config.abortSignal ? { abortSignal: config.abortSignal } : {}),
  });
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

function nextBatchSeq(items: readonly LocalDeviceQueueItem[], sourceInstanceId: string): number {
  return (
    Math.max(0, ...items.filter((item) => item.source_instance_id === sourceInstanceId).map((item) => item.batch_seq)) +
    1
  );
}
