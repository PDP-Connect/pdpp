#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enrollLocalDevice, runCodexLocalDeviceExporter } from "../src/local-device-runtime.ts";

interface CliOptions {
  baseUrl: string;
  code?: string;
  command: "enroll" | "run";
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  queuePath: string;
  sourceInstanceId: string;
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
      sourceInstanceId: options.sourceInstanceId,
    });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (!(options.deviceId && options.deviceToken)) {
    throw new Error("run requires --device-id <id> and --device-token <token>");
  }
  const result = await runCodexLocalDeviceExporter({
    baseUrl: options.baseUrl,
    deviceId: options.deviceId,
    deviceToken: options.deviceToken,
    queuePath: options.queuePath,
    sourceInstanceId: options.sourceInstanceId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (command !== "enroll" && command !== "run") {
    throw new Error("usage: local-device-exporter <enroll|run> --base-url <url> --source-instance-id <id> [options]");
  }
  const options: CliOptions = {
    baseUrl: process.env.PDPP_REFERENCE_BASE_URL ?? "http://127.0.0.1:3000",
    command,
    queuePath: process.env.PDPP_LOCAL_DEVICE_QUEUE ?? DEFAULT_QUEUE_PATH,
    sourceInstanceId: process.env.PDPP_SOURCE_INSTANCE_ID ?? "codex-local",
  };
  if (process.env.PDPP_LOCAL_DEVICE_ID) {
    options.deviceId = process.env.PDPP_LOCAL_DEVICE_ID;
  }
  if (process.env.PDPP_LOCAL_DEVICE_TOKEN) {
    options.deviceToken = process.env.PDPP_LOCAL_DEVICE_TOKEN;
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
    "--code": (next) => {
      options.code = next;
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
    "--source-instance-id": (next) => {
      options.sourceInstanceId = next;
    },
  };
  const set = setters[arg];
  if (!set) {
    throw new Error(`unknown option: ${arg}`);
  }
  set(value);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
