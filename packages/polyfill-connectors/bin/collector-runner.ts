#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *           [--resources messages:C123|C456]
 *           [--backfill-streams attachments]
 *           [--command <cmd>] [--args <argv...>]
 *           [--protocol-capabilities <capability,...|none>] [--run-id <id>]
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
 *
 *   status  --connection-id <id> [--queue <path>]
 *     Bounded, read-only inspection of the durable local outbox `run` drains
 *     — no network call, no connector spawn. Reports the same
 *     `LocalDeviceOutbox.summary()`/`deadLetterErrorSummary()` counts `run`
 *     itself acts on, plus a derived `lifecycle_state`
 *     (`@pdpp/collector-runtime`'s `deriveLocalCollectorLifecycleState`) so
 *     an operator does not have to infer the situation from raw counts. Safe
 *     to run at any time, including while a scheduled `run` is in flight
 *     (SQLite readers do not block the outbox's own writer).
 *
 *   recover --connection-id <id> [--queue <path>] [--apply]
 *     Bounded dead-letter recovery for the SAME durable outbox `run` drains.
 *     Without `--apply`, previews: reports how many dead-lettered rows would
 *     be requeued, changes nothing. With `--apply`, requeues them
 *     (`LocalDeviceOutbox.requeueDeadLetters`) so the next `run` retries
 *     them. Two-step by design — this mutates durable local state, so a
 *     dry-run preview is the default. Never replays already-succeeded work
 *     and never contacts the server; the next `run` invocation does the
 *     actual re-send.
 */

import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLLECTOR_RUNTIME_CAPABILITIES,
  type CollectorConnectorSpec,
  deriveLocalCollectorLifecycleState,
  enrollCollector,
  LocalDeviceOutbox,
  runCollectorConnector,
} from "@pdpp/collector-runtime";
import { CONNECTOR_PROTOCOL_CAPABILITIES, type ConnectorProtocolCapability } from "@pdpp/connector-protocol";
import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/collector-registry.ts";
import { resolveExecutionRoot } from "../src/execution-root.ts";

const DEFAULT_QUEUE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".pdpp-data",
  "collector-runner-queue.json"
);

export interface CliOptions {
  apply?: boolean;
  args?: string[];
  baseUrl: string;
  code?: string;
  command: "enroll" | "run" | "advertise" | "status" | "recover";
  connector?: string;
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  entrypointCommand?: string;
  protocolCapabilities?: readonly ConnectorProtocolCapability[];
  queuePath: string;
  resources?: Record<string, string[]>;
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

interface ConnectorDefaults {
  args: string[];
  bindings?: Record<string, { required: boolean }>;
  command: string;
  protocolCapabilities: readonly ConnectorProtocolCapability[];
  streams: string[];
}

/**
 * gmail is network-bound (server-capable), not a filesystem-class local
 * device collector, so it carries no entry in `LOCAL_COLLECTOR_DEFINITIONS`
 * (`src/collector-registry.ts`) — that registry is scoped to connectors the
 * published `@pdpp/local-collector` bundle ships. It keeps its own
 * hand-declared default here.
 */
const NON_LOCAL_DEVICE_CONNECTOR_DEFAULTS: Record<string, ConnectorDefaults> = {
  gmail: {
    command: "tsx",
    args: ["connectors/gmail/index.ts"],
    protocolCapabilities: [],
    streams: ["messages", "message_bodies", "attachments", "threads", "labels"],
    bindings: { network: { required: true } },
  },
};

/**
 * Every filesystem/local-device connector's CLI defaults, derived from its
 * own `LocalCollectorDefinition` (`src/collector-registry.ts`) instead of a
 * second hand-maintained table. `LOCAL_COLLECTOR_DEFINITIONS` is the single
 * source of truth each connector's collector-definition module already
 * declares "so it stays connector-agnostic" (see e.g.
 * `connectors/codex/collector-definition.ts`'s module doc) — this CLI had
 * drifted from that principle by re-declaring its own copy, which silently
 * omitted every connector added after `codex`/`claude_code`/`gmail`
 * (`google_takeout`, `imessage`, `apple_photos`, `google_messages`,
 * `signal`). A connector missing from this table fails closed with
 * "run requires --streams" before any spawn — reproduced for `signal` prior
 * to this fix.
 */
const KNOWN_CONNECTOR_DEFAULTS: Record<string, ConnectorDefaults> = {
  ...NON_LOCAL_DEVICE_CONNECTOR_DEFAULTS,
  ...Object.fromEntries(
    LOCAL_COLLECTOR_DEFINITIONS.map((definition) => [
      definition.connector_id,
      {
        command: "tsx",
        args: [`connectors/${definition.entry}/index.ts`],
        protocolCapabilities: definition.protocol_capabilities,
        streams: [...definition.streams],
        bindings: { ...definition.bindings },
      },
    ])
  ),
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

  if (options.command === "status" || options.command === "recover") {
    if (!options.sourceInstanceId) {
      throw new Error(`${options.command} requires --connection-id <id>`);
    }
    const outboxPath = scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId);
    process.stdout.write(
      `${JSON.stringify(
        options.command === "status"
          ? readOutboxStatus(outboxPath, options.sourceInstanceId)
          : recoverDeadLetters(outboxPath, options.sourceInstanceId, options.apply === true),
        null,
        2
      )}\n`
    );
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
    executionRoot: resolveExecutionRoot(spec),
    queuePath: scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId),
    ...(options.runId ? { runId: options.runId } : {}),
    sourceInstanceId: options.sourceInstanceId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export interface OutboxStatusReport {
  connectionId: string;
  deadLetterErrors: ReturnType<LocalDeviceOutbox["deadLetterErrorSummary"]>;
  lifecycleState: ReturnType<typeof deriveLocalCollectorLifecycleState>;
  outboxPath: string;
  summary: ReturnType<LocalDeviceOutbox["summary"]>;
}

/**
 * Bounded, read-only outbox inspection — opens the same durable SQLite file
 * `run` would, reads its summary/dead-letter counts, and derives the
 * `lifecycle_state` the published `@pdpp/local-collector`'s `status`/`doctor`
 * subcommands already document (`docs/reference/local-collector.md`,
 * `docs/operator/local-collector-runbook.md`). No network call, no connector
 * spawn — safe to run at any time.
 *
 * `coverageObserved` is deliberately `null` here rather than a real scan
 * result: `hasObservedStream` requires naming one stream, and this command
 * reports the connection-wide lifecycle, not one stream's coverage. A `null`
 * `coverageObserved` never yields `deriveLocalCollectorLifecycleState`'s
 * `coverage_missing` state (that state requires a confirmed `false`), so this
 * intentionally under-reports rather than guessing — the same fail-closed
 * discipline `hasObservedStream`'s own bounded-scan-budget `null` uses.
 */
export function readOutboxStatus(outboxPath: string, sourceInstanceId: string): OutboxStatusReport {
  const outbox = new LocalDeviceOutbox({ path: outboxPath });
  try {
    const summary = outbox.summary({ sourceInstanceId });
    const deadLetterErrors = outbox.deadLetterErrorSummary({ sourceInstanceId });
    const lifecycleState = deriveLocalCollectorLifecycleState({
      coverageObserved: null,
      recordBatchCount: outbox.countRecordBatches({ sourceInstanceId }),
      summary,
    });
    return { connectionId: sourceInstanceId, deadLetterErrors, lifecycleState, outboxPath, summary };
  } finally {
    outbox.close();
  }
}

export interface RecoverDeadLettersReport {
  applied: boolean;
  connectionId: string;
  matched: number;
  outboxPath: string;
  requeued: number;
}

/**
 * Bounded dead-letter recovery for the same durable outbox. Two-step by
 * design (`dryRun` default true unless `--apply`): a preview never mutates
 * durable state, matching the staged-safety precedent the `recover --apply`
 * flow documents for the published local collector. Never contacts the
 * server — the requeued rows retry on the connection's next scheduled `run`.
 */
export function recoverDeadLetters(
  outboxPath: string,
  sourceInstanceId: string,
  apply: boolean
): RecoverDeadLettersReport {
  const outbox = new LocalDeviceOutbox({ path: outboxPath });
  try {
    const result = outbox.requeueDeadLetters({ dryRun: !apply, sourceInstanceId });
    return {
      applied: apply,
      connectionId: sourceInstanceId,
      matched: result.matched,
      outboxPath,
      requeued: result.requeued,
    };
  } finally {
    outbox.close();
  }
}

export function buildConnectorSpec(options: CliOptions): CollectorConnectorSpec {
  if (!options.connector) {
    throw new Error("connector required");
  }
  const defaults = KNOWN_CONNECTOR_DEFAULTS[options.connector];
  const command = options.entrypointCommand ?? defaults?.command ?? "tsx";
  const args = options.args ?? defaults?.args ?? [`connectors/${options.connector}/index.ts`];
  const streams = options.streams ?? defaults?.streams ?? [];
  const customCommand = options.entrypointCommand !== undefined || options.args !== undefined;
  const protocolCapabilities = customCommand
    ? options.protocolCapabilities
    : (defaults?.protocolCapabilities ?? options.protocolCapabilities);
  if (streams.length === 0) {
    throw new Error(`run requires --streams <a,b,c> for connector ${options.connector}`);
  }
  if (!protocolCapabilities) {
    throw new Error(
      `run requires --protocol-capabilities <capability,...|none> for custom connector ${options.connector}`
    );
  }
  return {
    connector_id: options.connector,
    protocol_capabilities: protocolCapabilities,
    streams,
    ...(options.streamsToBackfill ? { streamsToBackfill: options.streamsToBackfill } : {}),
    ...(options.resources ? { resources: options.resources } : {}),
    command,
    args,
    runtime_requirements: { bindings: defaults?.bindings ?? {} },
  };
}

const BOOLEAN_FLAGS = new Set(["--apply"]);

export function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (
    command !== "enroll" &&
    command !== "run" &&
    command !== "advertise" &&
    command !== "status" &&
    command !== "recover"
  ) {
    throw new Error("usage: collector-runner <enroll|run|advertise|status|recover> --base-url <url> [options]");
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

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) {
      throw new Error("missing option");
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      applyBooleanFlag(options, arg);
      continue;
    }
    const value = rest[index + 1];
    applyOption(options, arg, value);
    index += 1;
  }

  return options;
}

function applyBooleanFlag(options: CliOptions, arg: string): void {
  if (arg === "--apply") {
    options.apply = true;
    return;
  }
  throw new Error(`unknown flag: ${arg}`);
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
    "--resources": (next) => {
      options.resources = parseResources(next);
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
    "--protocol-capabilities": (next) => {
      options.protocolCapabilities = parseProtocolCapabilities(next);
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

function parseProtocolCapabilities(value: string): ConnectorProtocolCapability[] {
  if (value.trim().toLowerCase() === "none") {
    return [];
  }
  const capabilities = parseCsv(value);
  const unknown = capabilities.find(
    (capability) => !CONNECTOR_PROTOCOL_CAPABILITIES.some((known) => known === capability)
  );
  if (unknown) {
    throw new Error(`unknown protocol capability: ${unknown}`);
  }
  return capabilities.filter((capability): capability is ConnectorProtocolCapability =>
    CONNECTOR_PROTOCOL_CAPABILITIES.some((known) => known === capability)
  );
}

function parseResources(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of parseCsv(value)) {
    const separator = part.indexOf(":");
    if (separator <= 0 || separator === part.length - 1) {
      throw new Error(`invalid --resources entry: ${part}`);
    }
    const stream = part.slice(0, separator);
    const resources = part
      .slice(separator + 1)
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
    if (resources.length === 0) {
      throw new Error(`invalid --resources entry: ${part}`);
    }
    out[stream] = [...new Set([...(out[stream] ?? []), ...resources])];
  }
  return out;
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
