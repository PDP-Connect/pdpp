#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW_CUSTOM_COMMAND_ENV, CollectorCustomCommandRefusedError, CollectorUsageError, } from "../src/errors.js";
import { BUNDLED_CONNECTOR_IDS, COLLECTOR_PROTOCOL_VERSION, COLLECTOR_RUNTIME_CAPABILITIES, deriveLocalCollectorLifecycleState, LocalDeviceOutbox, enrollCollector, getBundledConnector, isMainModule, runCollectorConnector, } from "../src/runner.js";
const COVERAGE_DIAGNOSTICS_STREAM = "coverage_diagnostics";
const DEFAULT_QUEUE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".pdpp-data", "collector-runner-queue.json");
const LOCAL_COLLECTOR_PACKAGE_NAME = "@pdpp/local-collector";
const LOCAL_COLLECTOR_PACKAGE_VERSION_FALLBACK = "0.0.0";
const LOCAL_COLLECTOR_PLACEHOLDER_VERSION = "0.0.0";
const REPO_ONLY_PACKAGE_SIBLINGS = ["src", "bin", "test", "scripts", "tsconfig.build.json"];
function resolveLocalCollectorManifest(startUrl) {
    const startPath = typeof startUrl === "string" && !startUrl.startsWith("file:")
        ? startUrl
        : fileURLToPath(startUrl);
    let realStart = startPath;
    try {
        realStart = realpathSync(startPath);
    }
    catch {
    }
    let current = dirname(realStart);
    for (;;) {
        const manifestPath = join(current, "package.json");
        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
                if (manifest.name === LOCAL_COLLECTOR_PACKAGE_NAME &&
                    typeof manifest.version === "string" &&
                    manifest.version) {
                    return { packageRoot: current, version: manifest.version };
                }
            }
            catch {
            }
        }
        const parent = dirname(current);
        if (parent === current) {
            return { packageRoot: null, version: LOCAL_COLLECTOR_PACKAGE_VERSION_FALLBACK };
        }
        current = parent;
    }
}
export function resolveLocalCollectorPackageVersion(startUrl = import.meta.url) {
    return resolveLocalCollectorManifest(startUrl).version;
}
export function classifyLocalCollectorDeploymentPosture(startUrl = import.meta.url) {
    const startPath = typeof startUrl === "string" && !startUrl.startsWith("file:")
        ? startUrl
        : fileURLToPath(startUrl);
    const moduleBasename = basename(startPath);
    const isSourceEntrypoint = extname(startPath) === ".ts";
    const { packageRoot, version } = resolveLocalCollectorManifest(startUrl);
    let kind;
    let locationHint;
    if (!packageRoot) {
        kind = isSourceEntrypoint ? "repo_dist_override" : "unknown";
        locationHint = "unresolved";
    }
    else if (isUnderNodeModulesPackage(packageRoot)) {
        kind = "published_package";
        locationHint = `node_modules/${LOCAL_COLLECTOR_PACKAGE_NAME}`;
    }
    else if (isSourceEntrypoint || hasRepoOnlySiblings(packageRoot)) {
        kind = "repo_dist_override";
        locationHint = `packages/${basename(packageRoot)}`;
    }
    else {
        kind = "unknown";
        locationHint = `packages/${basename(packageRoot)}`;
    }
    return {
        kind,
        is_placeholder_version: version === LOCAL_COLLECTOR_PLACEHOLDER_VERSION,
        location_hint: locationHint,
        module_basename: moduleBasename,
        version,
    };
}
function isUnderNodeModulesPackage(dir) {
    return dir.split(sep).includes("node_modules");
}
function hasRepoOnlySiblings(packageRoot) {
    return REPO_ONLY_PACKAGE_SIBLINGS.some((entry) => existsSync(join(packageRoot, entry)));
}
const HELP_TEXT = `pdpp-local-collector — PDPP local collector runner.

Ownership: the local device/host supervisor decides when filesystem-class
collectors run. The reference server owns enrollment, ingestion, state, health
diagnostics, and optional desired-freshness/request-run signals; it does not
start local processes.

Subcommands:
  advertise                       Print runtime capabilities and protocol version.
  status                          Print local durable outbox health as JSON.
          [--queue <path>]
          [--connection-id <id>]
  doctor                          Print local durable outbox operator diagnostics as JSON.
          [--queue <path>]
          [--connection-id <id>]
  retry-dead-letters              Requeue local dead-letter outbox rows.
          [--queue <path>]
          [--connection-id <id>]
          [--kind record_batch|checkpoint|gap|blob_upload]
          [--limit <n>]
          [--apply]                Dry-run by default; --apply mutates after a DB backup.
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
Connection id is the stable source identity for one device/account/home binding;
enrollment responses currently return it as source_instance_id.
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
        if (options.command === "doctor") {
            const errorSummary = readLocalOutboxDeadLetterErrorSummary(options);
            process.stdout.write(`${JSON.stringify(buildLocalOutboxDoctor(status, errorSummary), null, 2)}\n`);
            return;
        }
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
    }
    if (options.command === "retry-dead-letters") {
        const result = retryLocalOutboxDeadLetters(options);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    process.stdout.write(`${JSON.stringify(summarizeRunResultForCli(result), null, 2)}\n`);
}
export function summarizeRunResultForCli(result) {
    return {
        ...result,
        flushedState: summarizeCollectorState(result.flushedState),
        priorState: summarizeCollectorState(result.priorState),
    };
}
function summarizeCollectorState(state) {
    if (!state || Object.keys(state).length === 0) {
        return null;
    }
    const streams = {};
    for (const [stream, cursor] of Object.entries(state).sort(([a], [b]) => a.localeCompare(b))) {
        streams[stream] = summarizeCursor(cursor);
    }
    return {
        stream_count: Object.keys(streams).length,
        streams,
    };
}
function summarizeCursor(cursor) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        return { keys: [] };
    }
    const record = cursor;
    const summary = {
        keys: Object.keys(record).sort(),
    };
    if (typeof record.fetched_at === "string") {
        summary.fetched_at = record.fetched_at;
    }
    if (record.file_mtimes && typeof record.file_mtimes === "object" && !Array.isArray(record.file_mtimes)) {
        summary.file_mtimes_count = Object.keys(record.file_mtimes).length;
    }
    return summary;
}
export function inspectLocalOutboxStatus(options, deps = {}) {
    const dbPath = resolveOutboxPath(options);
    const exists = existsSync(dbPath);
    const inspection = exists
        ? readOutboxInspection(dbPath, options.sourceInstanceId)
        : { coverageObserved: null, recordBatchCount: 0, summary: emptyOutboxSummary() };
    const summary = inspection.summary;
    const lifecycleState = deriveLocalCollectorLifecycleState({
        coverageObserved: inspection.coverageObserved,
        recordBatchCount: inspection.recordBatchCount,
        summary,
    });
    const deploymentPosture = deps.deploymentPosture ?? classifyLocalCollectorDeploymentPosture();
    return {
        collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
        configured_device: {
            device_id_configured: Boolean(options.deviceId),
            device_token_configured: Boolean(options.deviceToken),
        },
        coverage: {
            observed: inspection.coverageObserved,
            record_batches: inspection.recordBatchCount,
        },
        db: {
            configured: Boolean(options.queuePath),
            exists,
            path: dbPath,
        },
        deployment_posture: deploymentPosture,
        lifecycle_state: lifecycleState,
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
            version: resolveLocalCollectorPackageVersion(),
        },
        source: {
            connection_id: options.sourceInstanceId ?? null,
            source_instance_id: options.sourceInstanceId ?? null,
        },
    };
}
export function buildLocalOutboxDoctor(status, errorSummary) {
    const posture = status.deployment_posture;
    const postureDisqualifiesEvidence = posture.kind === "repo_dist_override" || posture.is_placeholder_version;
    const checks = {
        coverage_diagnostics: status.lifecycle_state === "coverage_missing" ? "warn" : "ok",
        deployment_posture: postureDisqualifiesEvidence ? "warn" : "ok",
        expired_leases: status.outbox.expired_leases > 0 ? "warn" : "ok",
        outbox_db: status.db.exists ? "ok" : "missing",
        outbox_failures: status.outbox.counts.dead_letter > 0 ? "fail" : "ok",
    };
    const remediation = [];
    if (checks.outbox_failures === "fail") {
        const topClass = errorSummary?.top_classes?.[0];
        const causeHint = topClass
            ? ` Most common cause: ${topClass.error_class} (${topClass.count} row(s)).`
            : "";
        remediation.push(`${status.outbox.counts.dead_letter} dead-letter row(s) need recovery.${causeHint} ` +
            "Preview with `pdpp-local-collector retry-dead-letters`, then requeue with " +
            "`pdpp-local-collector retry-dead-letters --apply` (backs up the DB first), " +
            "then re-run the collector to drain the requeued rows.");
    }
    if (checks.expired_leases === "warn") {
        remediation.push(`${status.outbox.expired_leases} lease(s) are past expiry — a previous run likely crashed mid-drain. ` +
            "The next `pdpp-local-collector run …` recovers expired leases automatically before scanning; " +
            "no manual action is required.");
    }
    if (checks.coverage_diagnostics === "warn") {
        remediation.push(`This lane drained ${status.coverage.record_batches} record batch(es) but never carried a ` +
            "`coverage_diagnostics` record, so the dashboard can only show coverage_unknown. " +
            "Re-run `pdpp-local-collector run …` with the default stream set (no `--streams`); " +
            "it requests `coverage_diagnostics` and the next pass promotes the coverage axis.");
    }
    if (checks.deployment_posture === "warn") {
        remediation.push(deploymentPostureRemediation(posture));
    }
    const includeSummary = Boolean(errorSummary) && status.outbox.counts.dead_letter > 0;
    return {
        ...status,
        checks,
        ...(includeSummary && errorSummary ? { dead_letter_error_summary: errorSummary } : {}),
        ...(remediation.length > 0 ? { remediation } : {}),
        status: doctorSeverityForChecks(checks),
    };
}
function deploymentPostureRemediation(posture) {
    const parts = [];
    if (posture.kind === "repo_dist_override") {
        parts.push(`This collector resolves to a repo \`dist/\` override (${posture.location_hint}), ` +
            "not a published package — treat its output as dev evidence, not published " +
            "operator-host evidence.");
    }
    if (posture.is_placeholder_version) {
        parts.push(`The reported version is the \`${posture.version}\` placeholder, which is older than ` +
            "every real build (a bare or `@latest` global install resolves it).");
    }
    parts.push("Pin a published version before capturing operator-host evidence: " +
        "`npm i -g @pdpp/local-collector@beta` (or an explicit `@0.1.0-beta.<n>`). " +
        "See docs/local-collector.md §\"Deployment Posture: Published vs Dev\".");
    return parts.join(" ");
}
function doctorSeverityForChecks(checks) {
    if (checks.outbox_failures === "fail") {
        return "critical";
    }
    if (checks.expired_leases === "warn" ||
        checks.outbox_db === "missing" ||
        checks.coverage_diagnostics === "warn" ||
        checks.deployment_posture === "warn") {
        return "warning";
    }
    return "ok";
}
export function readLocalOutboxDeadLetterErrorSummary(options) {
    const dbPath = resolveOutboxPath(options);
    if (!existsSync(dbPath)) {
        return null;
    }
    const outbox = new LocalDeviceOutbox({ path: dbPath });
    try {
        const summary = outbox.deadLetterErrorSummary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {});
        return summary.dead_letter_count > 0 ? summary : null;
    }
    finally {
        outbox.close();
    }
}
const RETRY_DEAD_LETTERS_NO_MATCH_NOTE = "No dead-letter rows matched. If the dashboard shows this connection as " +
    "blocked/stalled, that is a state-read block, not a dead-letter backlog — " +
    "there is nothing to requeue. Recovery is to re-run the collector " +
    "(`pdpp-local-collector run …`), which re-reads prior state and clears the block.";
function retryDeadLettersMatchNote(matched, dryRun) {
    if (matched === 0) {
        return RETRY_DEAD_LETTERS_NO_MATCH_NOTE;
    }
    const requeued = dryRun
        ? `${matched} dead-letter row(s) would be requeued (dry run). Re-run with --apply to requeue (backs up the DB first), `
        : `${matched} dead-letter row(s) matched and were requeued to pending. `;
    return `${requeued}then re-run the collector (\`pdpp-local-collector run …\`) to drain them — requeue moves rows to pending, it does not ingest.`;
}
export function retryLocalOutboxDeadLetters(options) {
    const dbPath = resolveOutboxPath(options);
    const exists = existsSync(dbPath);
    if (!exists) {
        return {
            backup_path: null,
            db: { exists: false, path: dbPath },
            dry_run: !options.apply,
            filter: {
                kind: options.deadLetterKind ?? null,
                limit: options.limit ?? null,
                source_instance_id: options.sourceInstanceId ?? null,
            },
            matched: 0,
            note: retryDeadLettersMatchNote(0, !options.apply),
            requeued: 0,
            status_after: null,
            status_before: null,
        };
    }
    const outbox = new LocalDeviceOutbox({ path: dbPath });
    try {
        const statusBefore = summaryCounts(outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}));
        const errorSummary = outbox.deadLetterErrorSummary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {});
        const dryRun = !options.apply;
        const backupPath = dryRun ? null : backupSqliteDb(outbox, dbPath);
        const result = outbox.requeueDeadLetters({
            dryRun,
            ...(options.deadLetterKind ? { kind: options.deadLetterKind } : {}),
            ...(options.limit ? { limit: options.limit } : {}),
            ...(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}),
        });
        const statusAfter = summaryCounts(outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}));
        return {
            backup_path: backupPath,
            db: { exists: true, path: dbPath },
            ...(errorSummary.dead_letter_count > 0 ? { dead_letter_error_summary: errorSummary } : {}),
            dry_run: dryRun,
            filter: {
                kind: options.deadLetterKind ?? null,
                limit: options.limit ?? null,
                source_instance_id: options.sourceInstanceId ?? null,
            },
            matched: result.matched,
            note: retryDeadLettersMatchNote(result.matched, dryRun),
            requeued: result.requeued,
            status_after: statusAfter,
            status_before: statusBefore,
        };
    }
    finally {
        outbox.close();
    }
}
function summaryCounts(summary) {
    return {
        dead_letter: summary.deadLetter,
        leased: summary.leased,
        pending: summary.ready,
        retrying: summary.retrying,
        sent: summary.succeeded,
        total: summary.total,
    };
}
function backupSqliteDb(outbox, dbPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dbPath}.pre-retry-dead-letters-${stamp}.bak`;
    outbox.backupTo(backupPath);
    return backupPath;
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
    if (command !== "enroll" &&
        command !== "run" &&
        command !== "advertise" &&
        command !== "status" &&
        command !== "doctor" &&
        command !== "retry-dead-letters") {
        throw new CollectorUsageError(`usage: pdpp-local-collector <enroll|run|advertise|status|doctor|retry-dead-letters> --base-url <url> [options]`);
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
    if (process.env.PDPP_COLLECTOR_CONNECTOR) {
        options.connector = process.env.PDPP_COLLECTOR_CONNECTOR;
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
        if (applyFlagOption(options, arg)) {
            continue;
        }
        const value = rest[index + 1];
        applyOption(options, arg, value);
        index++;
    }
    return options;
}
function applyFlagOption(options, arg) {
    if (arg === "--apply") {
        options.apply = true;
        return true;
    }
    return false;
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
        "--kind": (next) => {
            options.deadLetterKind = parseOutboxKind(next);
        },
        "--limit": (next) => {
            options.limit = parsePositiveInteger("--limit", next);
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
function parseOutboxKind(value) {
    if (value === "record_batch" || value === "checkpoint" || value === "gap" || value === "blob_upload") {
        return value;
    }
    throw new CollectorUsageError(`invalid --kind: ${value}`);
}
function parsePositiveInteger(label, value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new CollectorUsageError(`${label} must be a positive integer`);
    }
    return parsed;
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
function readOutboxInspection(path, sourceInstanceId) {
    const outbox = new LocalDeviceOutbox({ path });
    try {
        const summary = outbox.summary(sourceInstanceId ? { sourceInstanceId } : {});
        if (!sourceInstanceId) {
            return { coverageObserved: null, recordBatchCount: 0, summary };
        }
        return {
            coverageObserved: outbox.hasObservedStream({ sourceInstanceId, stream: COVERAGE_DIAGNOSTICS_STREAM }),
            recordBatchCount: outbox.countRecordBatches({ sourceInstanceId }),
            summary,
        };
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
