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
}

export interface CollectorRunConfig {
  baseUrl: string;
  batchSize?: number;
  connector: CollectorConnectorSpec;
  deviceId: string;
  deviceToken: string;
  queuePath: string;
  sourceInstanceId: string;
}

export interface CollectorRunResult {
  done: Extract<EmittedMessage, { type: "DONE" }> | null;
  enqueuedBatches: number;
  recordsQueued: number;
  satisfiedBindings: readonly RuntimeBindingName[];
  sentBatches: number;
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

  await client.heartbeat({
    connector_id: config.connector.connector_id,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "starting",
  });

  const messages = await collectConnectorMessages(config.connector);
  const records = messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
  const done =
    messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE") ?? null;

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
  await client.heartbeat({
    connector_id: config.connector.connector_id,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "healthy",
  });

  return { done, enqueuedBatches, recordsQueued, sentBatches, satisfiedBindings };
}

export function buildCollectorStartMessage(streams: readonly string[]): StartMessage {
  return {
    scope: { streams: streams.map((name): StreamScope => ({ name })) },
    type: "START",
  };
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

async function collectConnectorMessages(connector: CollectorConnectorSpec): Promise<EmittedMessage[]> {
  const child = spawnConnector(connector);
  const messages: EmittedMessage[] = [];
  const stderr: Buffer[] = [];
  child.stdin.end(`${JSON.stringify(buildCollectorStartMessage(connector.streams))}\n`);
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

function spawnConnector(connector: CollectorConnectorSpec): ChildProcessWithoutNullStreams {
  return spawn(connector.command, [...connector.args], {
    cwd: dirname(fileURLToPath(new URL("..", import.meta.url))),
    env: { ...process.env, ...connector.env },
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
