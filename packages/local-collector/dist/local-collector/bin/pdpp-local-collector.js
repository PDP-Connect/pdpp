#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW_CUSTOM_COMMAND_ENV, CollectorCustomCommandRefusedError, CollectorUsageError, } from "../src/errors.js";
import { BUNDLED_CONNECTOR_IDS, COLLECTOR_PROTOCOL_VERSION, COLLECTOR_RUNTIME_CAPABILITIES, LocalDeviceOutbox, enrollCollector, getBundledConnector, isMainModule, runCollectorConnector, } from "../src/runner.js";
const DEFAULT_QUEUE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".pdpp-data", "collector-runner-queue.json");
const LOCAL_COLLECTOR_PACKAGE_NAME = "@pdpp/local-collector";
const LOCAL_COLLECTOR_PACKAGE_VERSION = "0.0.0";
const HELP_TEXT = `pdpp-local-collector — PDPP local collector runner.

Subcommands:
  advertise                       Print runtime capabilities and protocol version.
  status                          Print local durable outbox health as JSON.
          [--queue <path>]
          [--connection-id <id>]
  doctor                          Print local durable outbox operator diagnostics as JSON.
          [--queue <path>]
          [--connection-id <id>]
  enroll  --base-url <url>        Exchange a one-time enrollment code for a
          --code <code>             device id + device token.
          [--device-label <label>]
  run     --base-url <url>        Run a bundled filesystem-class connector
          --connector claude_code|codex
          --device-id <id>
          --device-token <token>
          --connection-id <id>
          [--streams a,b,c]
          [--backfill-streams attachments]
          [--run-id <id>]

Public connectors: ${BUNDLED_CONNECTOR_IDS.join(", ")}.
Browser-bound connectors stay in the monorepo until each has its own
publishability review.

See: openspec/changes/publish-pdpp-local-collector/design.md.
`;
async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "advertise") {
        process.stdout.write(`${JSON.stringify({
            runtime: COLLECTOR_RUNTIME_CAPABILITIES.id,
            bindings: [...COLLECTOR_RUNTIME_CAPABILITIES.bindings],
            collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
            bundled_connectors: BUNDLED_CONNECTOR_IDS,
        }, null, 2)}\n`);
        return;
    }
    if (options.command === "status" || options.command === "doctor") {
        const status = inspectLocalOutboxStatus(options);
        process.stdout.write(`${JSON.stringify(options.command === "doctor" ? buildLocalOutboxDoctor(status) : status, null, 2)}\n`);
        return;
    }
    if (options.command === "enroll") {
        if (!options.code) {
            throw new CollectorUsageError("enroll requires --code <one-time-code>");
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
        throw new CollectorUsageError("run requires --device-id <id>, --device-token <token>, and --connection-id <id>");
    }
    if (!options.connector) {
        throw new CollectorUsageError("run requires --connector <connector-id>");
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
export function inspectLocalOutboxStatus(options) {
    const dbPath = resolveOutboxPath(options);
    const exists = existsSync(dbPath);
    const summary = exists ? readOutboxSummary(dbPath, options.sourceInstanceId) : emptyOutboxSummary();
    return {
        collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
        configured_device: {
            device_id_configured: Boolean(options.deviceId),
            device_token_configured: Boolean(options.deviceToken),
        },
        db: {
            configured: Boolean(options.queuePath),
            exists,
            path: dbPath,
        },
        outbox: {
            counts: {
                dead_letter: summary.deadLetter,
                leased: summary.leased,
                pending: summary.ready,
                retrying: summary.retrying,
                sent: summary.succeeded,
                total: summary.total,
            },
            expired_leases: summary.staleLeases,
            oldest_pending_at: summary.oldestReadyAt,
        },
        package: {
            name: LOCAL_COLLECTOR_PACKAGE_NAME,
            version: LOCAL_COLLECTOR_PACKAGE_VERSION,
        },
        source: {
            source_instance_id: options.sourceInstanceId ?? null,
        },
    };
}
export function buildLocalOutboxDoctor(status) {
    const checks = {
        expired_leases: status.outbox.expired_leases > 0 ? "warn" : "ok",
        outbox_db: status.db.exists ? "ok" : "missing",
        outbox_failures: status.outbox.counts.dead_letter > 0 ? "fail" : "ok",
    };
    return {
        ...status,
        checks,
        status: checks.outbox_failures === "fail"
            ? "critical"
            : checks.expired_leases === "warn" || checks.outbox_db === "missing"
                ? "warning"
                : "ok",
    };
}
export function buildConnectorSpec(options) {
    if (!options.connector) {
        throw new CollectorUsageError("connector required");
    }
    const bundled = getBundledConnector(options.connector);
    const customAllowed = process.env[ALLOW_CUSTOM_COMMAND_ENV] === "1";
    if (options.entrypointCommand && !customAllowed) {
        throw new CollectorCustomCommandRefusedError();
    }
    if (!(bundled || customAllowed)) {
        throw new CollectorUsageError(`connector '${options.connector}' is not bundled with pdpp-local-collector. ` +
            `Supported: ${BUNDLED_CONNECTOR_IDS.join(", ")}. ` +
            `Set ${ALLOW_CUSTOM_COMMAND_ENV}=1 to use --command <bin> for monorepo development.`);
    }
    const command = options.entrypointCommand ?? bundled?.command ?? "tsx";
    const args = options.args ?? [...(bundled?.args ?? [`connectors/${options.connector}/index.ts`])];
    const streams = options.streams ?? [...(bundled?.streams ?? [])];
    if (streams.length === 0) {
        throw new CollectorUsageError(`run requires --streams <a,b,c> for connector ${options.connector}`);
    }
    return {
        connector_id: options.connector,
        streams,
        ...(options.streamsToBackfill ? { streamsToBackfill: options.streamsToBackfill } : {}),
        command,
        args,
        runtime_requirements: { bindings: bundled?.bindings ?? {} },
    };
}
export function parseArgs(args) {
    const [command, ...rest] = args;
    if (command === "--help" || command === "-h" || command === "help" || !command) {
        process.stdout.write(HELP_TEXT);
        process.exit(0);
    }
    if (command !== "enroll" && command !== "run" && command !== "advertise" && command !== "status" && command !== "doctor") {
        throw new CollectorUsageError(`usage: pdpp-local-collector <enroll|run|advertise|status|doctor> --base-url <url> [options]`);
    }
    const options = {
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
            throw new CollectorUsageError("missing option");
        }
        const value = rest[index + 1];
        applyOption(options, arg, value);
        index++;
    }
    return options;
}
function applyOption(options, arg, value) {
    if (!value) {
        throw new CollectorUsageError(`missing option value: ${arg}`);
    }
    const setters = {
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
        throw new CollectorUsageError(`unknown option: ${arg}`);
    }
    set(value);
}
function parseCsv(value) {
    return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
export function scopedDefaultQueuePath(queuePath, defaultQueuePath, connectionId) {
    if (queuePath !== defaultQueuePath) {
        return queuePath;
    }
    const extension = extname(defaultQueuePath);
    const stem = basename(defaultQueuePath, extension);
    return join(dirname(defaultQueuePath), `${stem}.${safeQueuePathSegment(connectionId)}${extension}`);
}
function resolveOutboxPath(options) {
    return options.sourceInstanceId
        ? scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId)
        : options.queuePath;
}
function readOutboxSummary(path, sourceInstanceId) {
    const outbox = new LocalDeviceOutbox({ path });
    try {
        return outbox.summary(sourceInstanceId ? { sourceInstanceId } : {});
    }
    finally {
        outbox.close();
    }
}
function emptyOutboxSummary() {
    return {
        deadLetter: 0,
        leased: 0,
        oldestReadyAt: null,
        ready: 0,
        retrying: 0,
        staleLeases: 0,
        succeeded: 0,
        total: 0,
    };
}
function safeQueuePathSegment(value) {
    return encodeURIComponent(value).replaceAll("%", "_");
}
if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        const exitCode = error instanceof CollectorUsageError ? error.exitCode : 1;
        process.exit(exitCode);
    });
}
