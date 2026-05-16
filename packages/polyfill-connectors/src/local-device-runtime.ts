import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
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

export const CODEX_CONNECTOR_ID = "codex";
export const DEFAULT_CODEX_STREAMS = ["sessions", "messages", "function_calls", "rules", "prompts", "skills"] as const;
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

export interface LocalDeviceEnrollmentConfig {
  baseUrl: string;
  code: string;
  deviceLabel?: string;
}

export interface LocalDeviceRuntimeConfig {
  baseUrl: string;
  batchSize?: number;
  codexArgs?: string[];
  codexCommand?: string;
  codexEnv?: NodeJS.ProcessEnv;
  deviceId: string;
  deviceToken: string;
  queuePath: string;
  sourceInstanceId: string;
  streams?: readonly string[];
}

export interface LocalDeviceRuntimeResult {
  done: Extract<EmittedMessage, { type: "DONE" }> | null;
  enqueuedBatches: number;
  recordsQueued: number;
  sentBatches: number;
}

export async function enrollLocalDevice(config: LocalDeviceEnrollmentConfig): Promise<EnrollmentExchangeResponse> {
  const client = new LocalDeviceClient({ baseUrl: config.baseUrl });
  return await client.exchangeEnrollment({
    enrollment_code: config.code,
    ...(config.deviceLabel ? { device_label: config.deviceLabel } : {}),
  });
}

export async function runCodexLocalDeviceExporter(config: LocalDeviceRuntimeConfig): Promise<LocalDeviceRuntimeResult> {
  const batchSize = config.batchSize ?? 100;
  const queue = new LocalDeviceQueue({ path: config.queuePath });
  const client = new LocalDeviceClient({
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    deviceToken: config.deviceToken,
  });

  await client.heartbeat({
    connector_id: CODEX_CONNECTOR_ID,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "starting",
  });

  const messages = await collectCodexMessages(config);
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
        connectorId: CODEX_CONNECTOR_ID,
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

  const sentBatches = await drainLocalDeviceQueue({ client, queue });
  await client.heartbeat({
    connector_id: CODEX_CONNECTOR_ID,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "healthy",
  });

  return { done, enqueuedBatches, recordsQueued, sentBatches };
}

export function buildCodexStartMessage(streams: readonly string[] = DEFAULT_CODEX_STREAMS): StartMessage {
  return {
    scope: { streams: streams.map((name): StreamScope => ({ name })) },
    type: "START",
  };
}

export function transformRecordsToLocalDeviceEnvelopes(input: {
  batchId: string;
  batchSeq: number;
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
        connectorId: CODEX_CONNECTOR_ID,
        deviceId: input.deviceId,
        record,
        sourceInstanceId: input.sourceInstanceId,
      })
    );
}

export async function drainLocalDeviceQueue(input: {
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
    throw new Error(`local device batch has no records: ${item.batch_id}`);
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

async function collectCodexMessages(config: LocalDeviceRuntimeConfig): Promise<EmittedMessage[]> {
  const child = spawnCodex(config);
  const messages: EmittedMessage[] = [];
  const stderr: Buffer[] = [];
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
    // Missing commands or early child exits can close stdin before START
    // is accepted. Preserve the child error/exit diagnostic.
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify(buildCodexStartMessage(config.streams))}\n`);

  let exitCode: number | null;
  try {
    [exitCode] = await Promise.all([exitPromise, outputPromise]);
  } catch (error) {
    throw new Error(
      `codex connector failed to start or stream output: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (exitCode !== 0) {
    throw new Error(`codex connector exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  return messages;
}

function spawnCodex(config: LocalDeviceRuntimeConfig): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...config.codexEnv };
  env.PATH = buildLocalDeviceChildPath(env.PATH);
  return spawn(config.codexCommand ?? "tsx", config.codexArgs ?? ["connectors/codex/index.ts"], {
    cwd: PACKAGE_ROOT,
    env,
  });
}

function buildLocalDeviceChildPath(pathValue: string | undefined): string {
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
