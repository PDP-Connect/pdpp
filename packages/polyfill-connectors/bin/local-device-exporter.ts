#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_CONNECTOR_ID,
  enrollLocalDevice,
  resolveLocalDeviceConnectorProfile,
  runLocalDeviceExporter,
} from "../src/local-device-runtime.ts";

interface CliOptions {
  baseUrl: string;
  code?: string;
  command: "enroll" | "run" | "setup";
  connectorId: string;
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  queuePath: string;
  sample?: number;
  sourceInstanceId: string | undefined;
}

const DEFAULT_QUEUE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".pdpp-data",
  "local-device-exporter-queue.json"
);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "enroll") {
    if (!options.code) {
      throw new Error("enroll requires --code <one-time-code>");
    }
    const response = await enrollLocalDevice({
      baseUrl: options.baseUrl,
      code: options.code,
      ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
    });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (options.command === "setup") {
    if (!options.code) {
      throw new Error("setup requires --code <one-time-code>");
    }
    // Validate the connector up front so an unknown --connector fails before
    // any network call.
    resolveLocalDeviceConnectorProfile(options.connectorId);
    const enrollment = await enrollLocalDevice({
      baseUrl: options.baseUrl,
      code: options.code,
      ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
    });
    const result = await runLocalDeviceExporter({
      baseUrl: options.baseUrl,
      connectorId: options.connectorId,
      deviceId: enrollment.device_id,
      deviceToken: enrollment.device_token,
      queuePath: scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, enrollment.source_instance_id),
      ...(options.sample === undefined ? {} : { sampleLimit: options.sample }),
      sourceInstanceId: enrollment.source_instance_id,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          device_id: enrollment.device_id,
          note: options.sample
            ? `Sample run: queued ${result.recordsQueued} of ${result.recordsSeen} record(s) seen (limit ${options.sample}). ` +
              (result.truncatedBySample
                ? "This is NOT a complete collection — re-run without --sample to collect the full source."
                : "The connector emitted fewer records than the sample limit — this was a complete pass.")
            : `Collected ${result.recordsQueued} record(s).`,
          object: "local_device_exporter_setup",
          record_queue_result: result,
          run_command:
            `PDPP_LOCAL_DEVICE_ID=${enrollment.device_id} PDPP_LOCAL_DEVICE_TOKEN=<device_token> ` +
            `PDPP_CONNECTION_ID=${enrollment.source_instance_id} ` +
            "pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts run " +
            `--base-url ${options.baseUrl} --connector ${options.connectorId}`,
          source_instance_id: enrollment.source_instance_id,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (!(options.deviceId && options.deviceToken && options.sourceInstanceId)) {
    throw new Error("run requires --device-id <id>, --device-token <token>, and --connection-id <id>");
  }
  // Validate the connector up front so an unknown --connector fails before we
  // touch the queue or heartbeat the server.
  resolveLocalDeviceConnectorProfile(options.connectorId);
  const result = await runLocalDeviceExporter({
    baseUrl: options.baseUrl,
    connectorId: options.connectorId,
    deviceId: options.deviceId,
    deviceToken: options.deviceToken,
    queuePath: scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId),
    ...(options.sample === undefined ? {} : { sampleLimit: options.sample }),
    sourceInstanceId: options.sourceInstanceId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (command !== "enroll" && command !== "run" && command !== "setup") {
    throw new Error("usage: local-device-exporter <enroll|run|setup> --base-url <url> [options]");
  }
  const options: CliOptions = {
    baseUrl: process.env.PDPP_REFERENCE_BASE_URL ?? "http://127.0.0.1:3000",
    command,
    connectorId: process.env.PDPP_CONNECTOR_ID ?? CODEX_CONNECTOR_ID,
    queuePath: process.env.PDPP_LOCAL_DEVICE_QUEUE ?? DEFAULT_QUEUE_PATH,
    sourceInstanceId: process.env.PDPP_CONNECTION_ID ?? process.env.PDPP_SOURCE_INSTANCE_ID,
  };
  if (process.env.PDPP_LOCAL_DEVICE_ID) {
    options.deviceId = process.env.PDPP_LOCAL_DEVICE_ID;
  }
  if (process.env.PDPP_LOCAL_DEVICE_TOKEN) {
    options.deviceToken = process.env.PDPP_LOCAL_DEVICE_TOKEN;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) {
      throw new Error("missing option");
    }
    const value = rest[index + 1];
    applyOption(options, arg, value);
    index += 1;
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
    "--code": (next) => {
      options.code = next;
    },
    "--connector": (next) => {
      options.connectorId = next;
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
    "--connection-id": (next) => {
      options.sourceInstanceId = next;
    },
    "--source-instance-id": (next) => {
      options.sourceInstanceId = next;
    },
    "--sample": (next) => {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--sample requires a positive integer");
      }
      options.sample = parsed;
    },
  };
  const set = setters[arg];
  if (!set) {
    throw new Error(`unknown option: ${arg}`);
  }
  set(value);
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
