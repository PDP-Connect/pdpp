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
  prune-sent                      Delete sent (succeeded) outbox rows to reclaim disk space.
          [--queue <path>]
          [--connection-id <id>]
          [--older-than-days <n>]  Delete sent rows older than N days (default: 30).
          [--keep-count <n>]       Keep at most N most-recent sent rows per connection.
          [--apply]                Dry-run by default; --apply mutates after a DB backup.
                                   Never touches pending, leased, retrying, or dead-letter rows.
  compact                         Rebuild the outbox SQLite file to return freed pages to disk.
          [--queue <path>]         prune-sent deletes rows but the file never shrinks on its own
          [--connection-id <id>]   (auto_vacuum=NONE); compact runs VACUUM to reclaim the freelist.
          [--apply]                Dry-run by default; --apply rebuilds after a DB backup.
          [--force]                Apply is refused while unsent (ready/leased/dead-letter) rows
                                   exist; --force compacts anyway (VACUUM is lossless either way).
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
    if (options.command === "prune-sent") {
        const result = pruneSentOutboxRows(options);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (options.command === "compact") {
        const result = compactOutbox(options);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.refused) {
            process.exitCode = 1;
        }
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
    const summary = result.outboxSummary;
    const lifecycleState = deriveLocalCollectorLifecycleState({
        coverageObserved: null,
        recordBatchCount: 0,
        summary,
    });
    const openWork = pendingOpenWork(summary);
    const drained = openWork === 0;
    return {
        ...result,
        drain_note: runDrainNote(result, summary, drained),
        drained,
        flushedState: summarizeCollectorState(result.flushedState),
        lifecycle_state: lifecycleState,
        priorState: summarizeCollectorState(result.priorState),
        residual_backlog: {
            dead_letter: summary.deadLetter,
            leased: summary.leased,
            ready: summary.ready,
            retrying: summary.retrying,
            total_open: openWork,
        },
    };
}
function runDrainNote(result, summary, drained) {
    if (result.skippedScanForBacklog) {
        return (`Scan was skipped: ${pendingOpenWork(summary)} open outbox row(s) from a prior run still need to drain first. ` +
            "No new source work was collected this pass; re-run to continue draining.");
    }
    if (drained) {
        return "Outbox fully drained — no ready, retrying, leased, or dead-letter work remains.";
    }
    const parts = [];
    if (summary.ready > 0) {
        parts.push(`${summary.ready} ready (drains on the next scheduled run)`);
    }
    if (summary.retrying > 0) {
        parts.push(`${summary.retrying} retrying (waiting on backoff)`);
    }
    if (summary.leased > 0) {
        parts.push(`${summary.leased} leased (in flight)`);
    }
    if (summary.deadLetter > 0) {
        parts.push(`${summary.deadLetter} dead-letter (run \`retry-dead-letters\` then re-run)`);
    }
    const scanNote = result.scanBudgetExceeded
        ? " The connector was stopped by the per-run enqueue budget, so more source work likely remains; re-run to continue."
        : "";
    return `Run succeeded on the source but the outbox is NOT fully drained: ${parts.join(", ")}.${scanNote}`;
}
function pendingOpenWork(summary) {
    return summary.ready + summary.retrying + summary.leased + summary.deadLetter;
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
    if (record.file_cursors && typeof record.file_cursors === "object" && !Array.isArray(record.file_cursors)) {
        summary.file_cursors_count = Object.keys(record.file_cursors).length;
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
            "Re-run with a build that emits `coverage_diagnostics` by default and the default stream set (no `--streams`): " +
            "`npx -y @pdpp/local-collector@beta run …` (or `pdpp-local-collector run …` if already on a current build). " +
            "Older installs may omit `coverage_diagnostics` from bundled defaults. `npx -y` fetches the latest *published* `@beta`, " +
            "which can still lag the repo build — if the gap persists, confirm `@beta` carries the fix with " +
            "`pnpm release:dist-tag-check` (release owner) rather than assuming the published build is current.");
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
        "The published `@beta` can lag the repo build, so confirm it carries the " +
        "fixes you need before re-pinning — `pnpm release:dist-tag-check` (release " +
        "owner) reports whether `@beta` is current; a `repo_dist_override` that is " +
        "ahead of `@beta` is dev evidence, not a build to downgrade to. " +
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
        const backupPath = dryRun ? null : backupSqliteDb(outbox, dbPath, "retry-dead-letters");
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
const DEFAULT_PRUNE_SENT_OLDER_THAN_DAYS = 30;
export function pruneSentOutboxRows(options) {
    const olderThanDays = options.olderThanDays ?? (options.keepCount === undefined ? DEFAULT_PRUNE_SENT_OLDER_THAN_DAYS : undefined);
    const olderThanIso = olderThanDays !== undefined ? daysAgoIso(olderThanDays) : undefined;
    const dbPath = resolveOutboxPath(options);
    const exists = existsSync(dbPath);
    const reportedOlderThanDays = olderThanDays ?? null;
    const reportedOlderThanIso = olderThanIso ?? null;
    if (!exists) {
        return {
            backup_path: null,
            db: { exists: false, path: dbPath },
            dry_run: !options.apply,
            filter: {
                keep_count: options.keepCount ?? null,
                older_than_days: reportedOlderThanDays,
                older_than_iso: reportedOlderThanIso,
                source_instance_id: options.sourceInstanceId ?? null,
            },
            matched: 0,
            note: "Outbox DB does not exist; nothing to prune.",
            pruned: 0,
            status_after: null,
            status_before: null,
        };
    }
    const outbox = new LocalDeviceOutbox({ path: dbPath });
    try {
        const statusBefore = summaryCounts(outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}));
        const dryRun = !options.apply;
        const pruneInput = {
            dryRun,
            ...(olderThanIso !== undefined ? { olderThanIso } : {}),
            ...(options.keepCount !== undefined ? { keepCount: options.keepCount } : {}),
            ...(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}),
        };
        const backupPath = dryRun ? null : backupSqliteDb(outbox, dbPath, "prune-sent");
        const result = outbox.pruneSent(pruneInput);
        const statusAfter = summaryCounts(outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}));
        const note = pruneSentNote(result, dryRun, reportedOlderThanDays, options.keepCount);
        return {
            backup_path: backupPath,
            db: { exists: true, path: dbPath },
            dry_run: dryRun,
            filter: {
                keep_count: options.keepCount ?? null,
                older_than_days: reportedOlderThanDays,
                older_than_iso: reportedOlderThanIso,
                source_instance_id: options.sourceInstanceId ?? null,
            },
            matched: result.matched,
            note,
            pruned: result.pruned,
            status_after: statusAfter,
            status_before: statusBefore,
        };
    }
    finally {
        outbox.close();
    }
}
function pruneSentNote(result, dryRun, olderThanDays, keepCount) {
    if (result.matched === 0) {
        return `No sent rows matched the retention policy (${pruneSentPolicyDescription(olderThanDays, keepCount)}). Nothing to prune.`;
    }
    if (dryRun) {
        return (`${result.matched} sent row(s) would be pruned (dry run). ` +
            `Re-run with --apply to delete (backs up the DB first). ` +
            `This only removes sent rows — pending, leased, retrying, and dead-letter rows are never touched.`);
    }
    return (`${result.pruned} sent row(s) pruned. ` +
        `Pending, leased, retrying, and dead-letter rows were not touched. ` +
        `Run \`pdpp-local-collector status\` to confirm the new outbox size.`);
}
function pruneSentPolicyDescription(olderThanDays, keepCount) {
    const parts = [];
    if (olderThanDays !== null) {
        parts.push(`older than ${olderThanDays} days`);
    }
    if (keepCount !== undefined) {
        parts.push(`keep-count ${keepCount}`);
    }
    return parts.length > 0 ? parts.join(", ") : "default sent-row retention";
}
function daysAgoIso(days) {
    const ms = days * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms).toISOString();
}
export function compactOutbox(options) {
    const dbPath = resolveOutboxPath(options);
    const exists = existsSync(dbPath);
    const dryRun = !options.apply;
    if (!exists) {
        return {
            backup_path: null,
            compacted: null,
            db: { exists: false, path: dbPath },
            dry_run: dryRun,
            note: "Outbox DB does not exist; nothing to compact.",
            non_succeeded_rows: 0,
            page_stats: null,
            reclaimed_bytes: 0,
            refused: false,
        };
    }
    const outbox = new LocalDeviceOutbox({ path: dbPath });
    try {
        const pageStats = outbox.pageStats();
        const nonSucceeded = outbox.countNonSucceeded();
        if (dryRun) {
            return {
                backup_path: null,
                compacted: null,
                db: { exists: true, path: dbPath },
                dry_run: true,
                note: compactDryRunNote(pageStats, nonSucceeded, Boolean(options.force)),
                non_succeeded_rows: nonSucceeded,
                page_stats: pageStats,
                reclaimed_bytes: 0,
                refused: false,
            };
        }
        if (nonSucceeded > 0 && !options.force) {
            return {
                backup_path: null,
                compacted: null,
                db: { exists: true, path: dbPath },
                dry_run: false,
                note: `Refusing to compact: ${nonSucceeded} non-succeeded (ready/leased/dead-letter) row(s) are still in the outbox. ` +
                    "Drain the lane first (`pdpp-local-collector run …`, then `retry-dead-letters --apply` for any dead-letter rows), " +
                    "or pass --force to compact anyway. VACUUM is lossless — unsent rows are copied, never dropped — but compacting a " +
                    "live lane is refused by default so the reclaim runs on a quiet outbox.",
                non_succeeded_rows: nonSucceeded,
                page_stats: pageStats,
                reclaimed_bytes: 0,
                refused: true,
            };
        }
        const backupPath = backupSqliteDb(outbox, dbPath, "compact");
        const result = outbox.compact();
        return {
            backup_path: backupPath,
            compacted: result.after,
            db: { exists: true, path: dbPath },
            dry_run: false,
            note: compactAppliedNote(result, nonSucceeded, Boolean(options.force)),
            non_succeeded_rows: nonSucceeded,
            page_stats: result.before,
            reclaimed_bytes: result.reclaimedBytes,
            refused: false,
        };
    }
    finally {
        outbox.close();
    }
}
function compactDryRunNote(stats, nonSucceeded, force) {
    const reclaimMb = (stats.reclaimableBytes / (1024 * 1024)).toFixed(1);
    if (stats.reclaimableBytes === 0) {
        return "The outbox has no reclaimable free pages; a compact would return ~0 bytes. Nothing to do.";
    }
    const base = `~${reclaimMb} MiB of free pages can be returned to the filesystem (${stats.freelistPages} of ${stats.pageCount} pages). ` +
        "Re-run with --apply to rebuild the DB in place (backs up the DB first).";
    if (nonSucceeded > 0 && !force) {
        return (`${base} NOTE: ${nonSucceeded} non-succeeded (unsent) row(s) are present, so --apply will be refused unless you ` +
            "drain the lane first or pass --force. VACUUM never drops unsent rows; the refusal just keeps the reclaim on a quiet outbox.");
    }
    return base;
}
function compactAppliedNote(result, nonSucceeded, force) {
    const reclaimedMb = (result.reclaimedBytes / (1024 * 1024)).toFixed(1);
    const forcedNote = nonSucceeded > 0 && force
        ? ` Compacted with --force while ${nonSucceeded} non-succeeded row(s) were present; VACUUM copied them losslessly.`
        : "";
    return (`Compacted: ~${reclaimedMb} MiB returned to the filesystem ` +
        `(${result.before.pageCount} → ${result.after.pageCount} pages).${forcedNote} ` +
        "Run `pdpp-local-collector status` to confirm the new outbox size.");
}
function backupSqliteDb(outbox, dbPath, label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${dbPath}.pre-${label}-${stamp}.bak`;
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
        command !== "retry-dead-letters" &&
        command !== "prune-sent" &&
        command !== "compact") {
        throw new CollectorUsageError(`usage: pdpp-local-collector <enroll|run|advertise|status|doctor|retry-dead-letters|prune-sent|compact> --base-url <url> [options]`);
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
    if (arg === "--force") {
        options.force = true;
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
        "--older-than-days": (next) => {
            options.olderThanDays = parseNonNegativeInteger("--older-than-days", next);
        },
        "--keep-count": (next) => {
            options.keepCount = parseNonNegativeInteger("--keep-count", next);
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
function parseNonNegativeInteger(label, value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new CollectorUsageError(`${label} must be a non-negative integer`);
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
