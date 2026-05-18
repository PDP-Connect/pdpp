#!/usr/bin/env node

/**
 * Local collector runner CLI.
 *
 * Subcommands:
 *
 *   enroll  --base-url <url> --code <code> [--device-label <label>]
 *     Pair this host with the provider via the device-exporter
 *     enrollment-code exchange. Prints the device id + token to stdout
 *     so the operator can persist them somewhere safe (env file,
 *     keychain). Reuses the existing device-scoped credential boundary —
 *     the issued token CANNOT read records, mint owner tokens, or
 *     mutate unrelated devices.
 *
 *   run     --base-url <url> --connector <id>
 *           --device-id <id> --device-token <token>
 *           --connection-id <id> [--streams a,b,c]
 *           [--backfill-streams attachments]
 *           [--command <cmd>] [--args <argv...>] [--run-id <id>]
 *     Run the connector under the collector runtime. Gates the
 *     connector against COLLECTOR_RUNTIME_CAPABILITIES before spawn;
 *     a connector requiring a binding the collector does not advertise
 *     fails with `runtime_capability_mismatch` before any child process
 *     starts. When `--run-id` is supplied (or PDPP_RUN_ID is set in env),
 *     the spawned connector subprocess receives PDPP_RUN_ID,
 *     PDPP_REFERENCE_BASE_URL, and PDPP_LOCAL_DEVICE_TOKEN so the runtime
 *     can register its launched browser's CDP page-target with the
 *     reference server's run-target registry for streaming-companion
 *     resolution. Omit `--run-id` for runs that don't need streaming.
 *
 *     `--backfill-streams` lets the operator opt a connector run into
 *     explicit per-stream historical rehydration that is independent
 *     of the incremental cursor. For Gmail, `--connector gmail
 *     --backfill-streams attachments` requests one bounded UID window
 *     of historical attachment backfill in the connector's START
 *     envelope; window size is governed by
 *     `PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS`. Attachment backfill
 *     also requires `PDPP_RS_URL` and `PDPP_OWNER_TOKEN` for blob
 *     upload — the Gmail connector's preflight fails before mailbox
 *     work when those are missing.
 *
 *     STATE handling: this CLI now persists and replays connector STATE
 *     through the device-scoped state route under
 *     `/_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`.
 *     The CLI prefers connection terminology; `--source-instance-id` and
 *     `PDPP_SOURCE_INSTANCE_ID` remain compatibility aliases for existing
 *     local device bindings until the server route is renamed.
 *     `runCollectorConnector` fetches prior state before spawning the
 *     connector child, populates `START.state`, buffers emitted STATE
 *     messages per stream (last-wins, in-scope only), and flushes the
 *     resulting map back to the server only after every queued record
 *     batch has been durably accepted. See OpenSpec
 *     `design-local-collector-state-sync` for the load/replay/persist
 *     contract and the honest-crash semantics (state never advances past
 *     records the server has acknowledged).
 *
 *   advertise
 *     Print the collector runtime's advertised capabilities as JSON.
 *     Useful for operator scripts that want to verify what the runtime
 *     can satisfy before pairing.
 */

import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CollectorConnectorSpec, enrollCollector, runCollectorConnector } from "../src/collector-runner.ts";
import { COLLECTOR_RUNTIME_CAPABILITIES } from "../src/runtime-capabilities.ts";

const DEFAULT_QUEUE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".pdpp-data",
  "collector-runner-queue.json"
);

export interface CliOptions {
  args?: string[];
  baseUrl: string;
  code?: string;
  command: "enroll" | "run" | "advertise";
  connector?: string;
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  entrypointCommand?: string;
  queuePath: string;
  /**
   * Optional stable run id propagated to the connector subprocess as
   * PDPP_RUN_ID. Required for streaming-companion target registration;
   * harmless to omit for runs that don't need streaming.
   */
  runId?: string;
  sourceInstanceId?: string;
  streams?: string[];
  streamsToBackfill?: string[];
}

const KNOWN_CONNECTOR_DEFAULTS: Record<
  string,
  { command: string; args: string[]; streams: string[]; bindings?: Record<string, { required: boolean }> }
> = {
  codex: {
    command: "tsx",
    args: ["connectors/codex/index.ts"],
    streams: ["sessions", "messages", "function_calls", "rules", "prompts", "skills"],
    bindings: { filesystem: { required: true } },
  },
  claude_code: {
    command: "tsx",
    args: ["connectors/claude_code/index.ts"],
    streams: ["sessions", "messages", "attachments", "memory_notes", "skills", "slash_commands"],
    bindings: { filesystem: { required: true } },
  },
  gmail: {
    command: "tsx",
    args: ["connectors/gmail/index.ts"],
    streams: ["messages", "message_bodies", "attachments", "threads", "labels"],
    bindings: { network: { required: true } },
  },
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "advertise") {
    process.stdout.write(
      `${JSON.stringify(
        {
          runtime: COLLECTOR_RUNTIME_CAPABILITIES.id,
          bindings: [...COLLECTOR_RUNTIME_CAPABILITIES.bindings],
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (options.command === "enroll") {
    if (!options.code) {
      throw new Error("enroll requires --code <one-time-code>");
    }
    const response = await enrollCollector({
      baseUrl: options.baseUrl,
      code: options.code,
      ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
    });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (!(options.deviceId && options.deviceToken && options.sourceInstanceId)) {
    throw new Error("run requires --device-id <id>, --device-token <token>, and --connection-id <id>");
  }
  if (!options.connector) {
    throw new Error("run requires --connector <connector-id>");
  }

  const spec = buildConnectorSpec(options);
  const result = await runCollectorConnector({
    baseUrl: options.baseUrl,
    connector: spec,
    deviceId: options.deviceId,
    deviceToken: options.deviceToken,
    queuePath: scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId),
    ...(options.runId ? { runId: options.runId } : {}),
    sourceInstanceId: options.sourceInstanceId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function buildConnectorSpec(options: CliOptions): CollectorConnectorSpec {
  if (!options.connector) {
    throw new Error("connector required");
  }
  const defaults = KNOWN_CONNECTOR_DEFAULTS[options.connector];
  const command = options.entrypointCommand ?? defaults?.command ?? "tsx";
  const args = options.args ?? defaults?.args ?? [`connectors/${options.connector}/index.ts`];
  const streams = options.streams ?? defaults?.streams ?? [];
  if (streams.length === 0) {
    throw new Error(`run requires --streams <a,b,c> for connector ${options.connector}`);
  }
  return {
    connector_id: options.connector,
    streams,
    ...(options.streamsToBackfill ? { streamsToBackfill: options.streamsToBackfill } : {}),
    command,
    args,
    runtime_requirements: { bindings: defaults?.bindings ?? {} },
  };
}

export function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (command !== "enroll" && command !== "run" && command !== "advertise") {
    throw new Error("usage: collector-runner <enroll|run|advertise> --base-url <url> [options]");
  }
  const options: CliOptions = {
    baseUrl: process.env.PDPP_REFERENCE_BASE_URL ?? "http://127.0.0.1:7662",
    command,
    queuePath: process.env.PDPP_COLLECTOR_QUEUE ?? DEFAULT_QUEUE_PATH,
  };
  if (process.env.PDPP_LOCAL_DEVICE_ID) {
    options.deviceId = process.env.PDPP_LOCAL_DEVICE_ID;
  }
  if (process.env.PDPP_LOCAL_DEVICE_TOKEN) {
    options.deviceToken = process.env.PDPP_LOCAL_DEVICE_TOKEN;
  }
  if (process.env.PDPP_SOURCE_INSTANCE_ID) {
    options.sourceInstanceId = process.env.PDPP_SOURCE_INSTANCE_ID;
  }
  if (process.env.PDPP_CONNECTION_ID) {
    options.sourceInstanceId = process.env.PDPP_CONNECTION_ID;
  }
  if (process.env.PDPP_RUN_ID) {
    options.runId = process.env.PDPP_RUN_ID;
  }

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg) {
      throw new Error("missing option");
    }
    const value = rest[index + 1];
    applyOption(options, arg, value);
    index++;
  }

  return options;
}

function applyOption(options: CliOptions, arg: string, value: string | undefined): void {
  if (!value) {
    throw new Error(`missing option value: ${arg}`);
  }
  const setters: Record<string, (next: string) => void> = {
    "--base-url": (next) => {
      options.baseUrl = next;
    },
    "--backfill-streams": (next) => {
      options.streamsToBackfill = parseCsv(next);
    },
    "--code": (next) => {
      options.code = next;
    },
    "--connector": (next) => {
      options.connector = next;
    },
    "--device-id": (next) => {
      options.deviceId = next;
    },
    "--device-label": (next) => {
      options.deviceLabel = next;
    },
    "--device-token": (next) => {
      options.deviceToken = next;
    },
    "--queue": (next) => {
      options.queuePath = next;
    },
    "--run-id": (next) => {
      options.runId = next;
    },
    "--connection-id": (next) => {
      options.sourceInstanceId = next;
    },
    "--source-instance-id": (next) => {
      options.sourceInstanceId = next;
    },
    "--streams": (next) => {
      options.streams = parseCsv(next);
    },
    "--command": (next) => {
      options.entrypointCommand = next;
    },
    "--args": (next) => {
      options.args = next.split(" ").filter(Boolean);
    },
  };
  const set = setters[arg];
  if (!set) {
    throw new Error(`unknown option: ${arg}`);
  }
  set(value);
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function scopedDefaultQueuePath(queuePath: string, defaultQueuePath: string, connectionId: string): string {
  if (queuePath !== defaultQueuePath) {
    return queuePath;
  }
  const extension = extname(defaultQueuePath);
  const stem = basename(defaultQueuePath, extension);
  return join(dirname(defaultQueuePath), `${stem}.${safeQueuePathSegment(connectionId)}${extension}`);
}

function safeQueuePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

// Run the CLI only when invoked directly (`tsx bin/collector-runner.ts`),
// not when imported by tests. Compares the resolved entry argv against
// the current module's path; identical means "this file is the entry."
const SELF_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] === SELF_PATH) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
