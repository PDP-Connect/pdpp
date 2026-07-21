import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildAgentVersion } from "./collector-build-info.ts";
import type { EmittedMessage, StartMessage, StreamScope } from "./connector-runtime-protocol.ts";
import { type EnrollmentExchangeResponse, LocalDeviceClient } from "./local-device-client.ts";
import {
  buildLocalDeviceIngestBatchRequest,
  buildLocalDeviceRecordEnvelope,
  type LocalDeviceRecordEnvelope,
} from "./local-device-envelope.ts";
import { LocalDeviceQueue, type LocalDeviceQueueItem } from "./local-device-queue.ts";

export const CODEX_CONNECTOR_ID = "codex";
export const CLAUDE_CODE_CONNECTOR_ID = "claude-code";
export const AMAZON_CONNECTOR_ID = "amazon";
export const DEFAULT_CODEX_STREAMS = ["sessions", "messages", "function_calls", "rules", "prompts", "skills"] as const;
export const DEFAULT_CLAUDE_CODE_STREAMS = [
  "sessions",
  "messages",
  "attachments",
  "memory_notes",
  "skills",
  "slash_commands",
] as const;
export const DEFAULT_AMAZON_STREAMS = ["orders", "order_items"] as const;
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

/**
 * Per-connector wiring for the local-device exporter. The device-envelope
 * export path (enroll → spawn connector → wrap RECORDs in
 * {device_id, source_instance_id, record_key} envelopes → ingest) is
 * connector-agnostic; this table is the only connector-specific part.
 *
 * The default child command is `tsx <entrypoint>`; the connector itself owns
 * its source-home resolution from env (CODEX_HOME, CLAUDE_CODE_HOME, …), so
 * binding a source home to a connector instance is a matter of running the
 * exporter once per (source_instance_id, source-home env) pair.
 */
export interface LocalDeviceConnectorProfile {
  readonly connectorId: string;
  readonly defaultStreams: readonly string[];
  readonly entrypoint: string;
}

export const LOCAL_DEVICE_CONNECTOR_PROFILES: Readonly<Record<string, LocalDeviceConnectorProfile>> = {
  [CODEX_CONNECTOR_ID]: {
    connectorId: CODEX_CONNECTOR_ID,
    defaultStreams: DEFAULT_CODEX_STREAMS,
    entrypoint: "connectors/codex/index.ts",
  },
  [CLAUDE_CODE_CONNECTOR_ID]: {
    connectorId: CLAUDE_CODE_CONNECTOR_ID,
    defaultStreams: DEFAULT_CLAUDE_CODE_STREAMS,
    entrypoint: "connectors/claude_code/index.ts",
  },
  // Amazon is a browser-bound connector. Unlike codex/claude-code it requires a
  // real, owner-mediated browser session (live login, possibly 2FA) to produce
  // RECORDs, so spawning it in a headless/no-human context will fail at the
  // session probe — that is expected and is exactly the step the
  // browser-collector proof keeps owner-mediated. Registering the profile here
  // is the deterministic monorepo-runner wiring the owner-run live proof needs;
  // it does NOT add a new browser transport, and it is intentionally absent from the published
  // `@pdpp/local-collector` bundle (see `src/runner.ts` — that registry stays
  // filesystem-class only so the publish stays browser-free). The
  // device-exporter ingest path it feeds is connector-agnostic; binding-aware
  // enrollment records this connector as `browser_collector`.
  [AMAZON_CONNECTOR_ID]: {
    connectorId: AMAZON_CONNECTOR_ID,
    defaultStreams: DEFAULT_AMAZON_STREAMS,
    entrypoint: "connectors/amazon/index.ts",
  },
};

export function resolveLocalDeviceConnectorProfile(connectorId: string): LocalDeviceConnectorProfile {
  const profile = LOCAL_DEVICE_CONNECTOR_PROFILES[connectorId];
  if (!profile) {
    const known = Object.keys(LOCAL_DEVICE_CONNECTOR_PROFILES).join(", ");
    throw new Error(`unsupported local-device connector "${connectorId}" (known: ${known})`);
  }
  return profile;
}

export interface LocalDeviceEnrollmentConfig {
  baseUrl: string;
  code: string;
  deviceLabel?: string;
}

export interface LocalDeviceRuntimeConfig {
  baseUrl: string;
  batchSize?: number;
  /** @deprecated use connectorArgs */
  codexArgs?: string[];
  /** @deprecated use connectorCommand */
  codexCommand?: string;
  /** @deprecated use connectorEnv */
  codexEnv?: NodeJS.ProcessEnv;
  /** Override the child args (defaults to the profile entrypoint). */
  connectorArgs?: string[];
  /** Override the child command (defaults to `tsx`). */
  connectorCommand?: string;
  /** Connector child env (e.g. CLAUDE_CODE_HOME / CODEX_HOME source-home binding). */
  connectorEnv?: NodeJS.ProcessEnv;
  /**
   * Connector to export. Defaults to {@link CODEX_CONNECTOR_ID} for backward
   * compatibility with the original Codex-only exporter. Claude Code source
   * homes export through this same path via {@link CLAUDE_CODE_CONNECTOR_ID}.
   */
  connectorId?: string;
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

/**
 * Run the local-device exporter for any supported connector. Binds the given
 * source home (carried in `connectorEnv`) to `sourceInstanceId`: every RECORD
 * the connector emits is wrapped in an envelope tagged with that
 * source-instance + device identity before it is queued and ingested, so two
 * source homes that share connector-local record keys never collide — the
 * reference store keys records by `(connector_instance_id, stream,
 * record_key)`, and each enrolled source home resolves to a distinct
 * connector instance.
 */
export async function runLocalDeviceExporter(config: LocalDeviceRuntimeConfig): Promise<LocalDeviceRuntimeResult> {
  const profile = resolveLocalDeviceConnectorProfile(config.connectorId ?? CODEX_CONNECTOR_ID);
  const batchSize = config.batchSize ?? 100;
  const queue = new LocalDeviceQueue({ path: config.queuePath });
  const client = new LocalDeviceClient({
    baseUrl: config.baseUrl,
    deviceId: config.deviceId,
    deviceToken: config.deviceToken,
  });

  await client.heartbeat({
    agent_version: buildAgentVersion(),
    connector_id: profile.connectorId,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "starting",
  });

  const messages = await collectConnectorMessages(profile, config);
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
        connectorId: profile.connectorId,
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
    agent_version: buildAgentVersion(),
    connector_id: profile.connectorId,
    records_pending: (await queue.list()).filter((item) => item.status !== "sent").length,
    source_instance_id: config.sourceInstanceId,
    status: "healthy",
  });

  return { done, enqueuedBatches, recordsQueued, sentBatches };
}

/** @deprecated use {@link runLocalDeviceExporter}; retained for back-compat. */
export function runCodexLocalDeviceExporter(config: LocalDeviceRuntimeConfig): Promise<LocalDeviceRuntimeResult> {
  return runLocalDeviceExporter({ ...config, connectorId: config.connectorId ?? CODEX_CONNECTOR_ID });
}

export function buildLocalDeviceStartMessage(streams: readonly string[]): StartMessage {
  return {
    scope: { streams: streams.map((name): StreamScope => ({ name })) },
    type: "START",
  };
}

/** @deprecated use {@link buildLocalDeviceStartMessage}. */
export function buildCodexStartMessage(streams: readonly string[] = DEFAULT_CODEX_STREAMS): StartMessage {
  return buildLocalDeviceStartMessage(streams);
}

export function transformRecordsToLocalDeviceEnvelopes(input: {
  batchId: string;
  batchSeq: number;
  connectorId?: string;
  deviceId: string;
  messages: readonly EmittedMessage[];
  sourceInstanceId: string;
}): LocalDeviceRecordEnvelope[] {
  const connectorId = input.connectorId ?? CODEX_CONNECTOR_ID;
  return input.messages
    .filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD")
    .map((record) =>
      buildLocalDeviceRecordEnvelope({
        batchId: input.batchId,
        batchSeq: input.batchSeq,
        connectorId,
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
  await client.ingestBatch(
    buildLocalDeviceIngestBatchRequest({
      batchId: item.batch_id,
      batchSeq: item.batch_seq,
      connectorId: firstRecord.connector_id,
      deviceId: firstRecord.device_id,
      records: item.records,
      sourceInstanceId: item.source_instance_id,
    })
  );
}

async function collectConnectorMessages(
  profile: LocalDeviceConnectorProfile,
  config: LocalDeviceRuntimeConfig
): Promise<EmittedMessage[]> {
  const streams = config.streams ?? profile.defaultStreams;
  const child = spawnConnector(profile, config);
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
  child.stdin.end(`${JSON.stringify(buildLocalDeviceStartMessage(streams))}\n`);

  let exitCode: number | null;
  try {
    [exitCode] = await Promise.all([exitPromise, outputPromise]);
  } catch (error) {
    throw new Error(
      `${profile.connectorId} connector failed to start or stream output: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `${profile.connectorId} connector exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}`
    );
  }
  return messages;
}

function spawnConnector(
  profile: LocalDeviceConnectorProfile,
  config: LocalDeviceRuntimeConfig
): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...config.codexEnv, ...config.connectorEnv };
  env.PATH = buildLocalDeviceChildPath(env.PATH);
  const command = config.connectorCommand ?? config.codexCommand ?? "tsx";
  const args = config.connectorArgs ?? config.codexArgs ?? [profile.entrypoint];
  return spawn(command, args, {
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
