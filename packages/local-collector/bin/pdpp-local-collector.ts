#!/usr/bin/env node

/**
 * `pdpp-local-collector` — public CLI for the PDPP local collector.
 *
 * Subcommands mirror today's monorepo `bin/collector-runner.ts`:
 *
 *   advertise  Print the collector runtime's advertised capabilities and the
 *              published `COLLECTOR_PROTOCOL_VERSION`. Useful for operator
 *              scripts that want to verify what the runtime can satisfy
 *              before pairing.
 *
 *   enroll     Pair this host with a PDPP reference deployment via the
 *              device-exporter enrollment-code exchange.
 *
 *   run        Run a bundled filesystem-class connector (Claude Code or
 *              Codex) under the collector runtime. The published surface
 *              accepts `--connector claude_code|codex` only; `--command
 *              <bin>` is refused unless
 *              `PDPP_LOCAL_COLLECTOR_ALLOW_CUSTOM_COMMAND=1` is set, which
 *              is the monorepo development opt-in.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOW_CUSTOM_COMMAND_ENV,
  CollectorCustomCommandRefusedError,
  CollectorUsageError,
} from "../src/errors.ts";
import {
  BUNDLED_CONNECTOR_IDS,
  COLLECTOR_PROTOCOL_VERSION,
  COLLECTOR_RUNTIME_CAPABILITIES,
  type CollectorConnectorSpec,
  deriveLocalCollectorLifecycleState,
  LocalDeviceOutbox,
  type LocalCollectorLifecycleState,
  type LocalDeviceOutboxCompactResult,
  type LocalDeviceOutboxDeadLetterErrorSummary,
  type LocalDeviceOutboxKind,
  type LocalDeviceOutboxPageStats,
  type LocalDeviceOutboxPruneSentInput,
  type LocalDeviceOutboxPruneSentResult,
  type LocalDeviceOutboxSummary,
  enrollCollector,
  getBundledConnector,
  isMainModule,
  runCollectorConnector,
} from "../src/runner.ts";

/**
 * Stream name the local source inventory emits coverage records on. Kept
 * here (not imported) because the CLI only needs the literal to ask the
 * durable outbox "has this lane ever carried a coverage diagnostic?".
 * Mirrors `COVERAGE_DIAGNOSTICS_STREAM` in the runner.
 */
const COVERAGE_DIAGNOSTICS_STREAM = "coverage_diagnostics";

const DEFAULT_QUEUE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".pdpp-data",
  "collector-runner-queue.json"
);
const LOCAL_COLLECTOR_PACKAGE_NAME = "@pdpp/local-collector";
const LOCAL_COLLECTOR_PACKAGE_VERSION_FALLBACK = "0.0.0";
const LOCAL_COLLECTOR_PROFILE_DIR_ENV = "PDPP_LOCAL_COLLECTOR_PROFILE_DIR";
/**
 * Placeholder version published to the `latest` dist-tag and carried by the
 * in-repo `package.json` by design. It is older than every real beta build, so
 * a host reporting it is either an unpinned `latest` install of the placeholder
 * or an in-repo manifest — neither is real published operator-host evidence.
 * See `docs/local-collector.md`§"Deployment Posture".
 */
const LOCAL_COLLECTOR_PLACEHOLDER_VERSION = "0.0.0";
/**
 * Sibling entries that exist in a monorepo checkout's
 * `packages/local-collector` root but are excluded from the published tarball
 * (`files: ["dist/", "README.md"]`). Their presence next to the resolved
 * manifest is the layout-based discriminator for a repo `dist/` override that
 * does not depend on home-path strings.
 */
const REPO_ONLY_PACKAGE_SIBLINGS = ["src", "bin", "test", "scripts", "tsconfig.build.json"] as const;

interface LocalCollectorManifestResolution {
  /** Directory holding the resolved `@pdpp/local-collector` package.json. */
  packageRoot: string | null;
  /** Resolved package version, or the placeholder fallback when not found. */
  version: string;
}

/**
 * Walk up from `startUrl` (with symlinks resolved) to the nearest
 * `@pdpp/local-collector` package.json, returning its directory and version.
 * Realpath resolution matters: a dev override is usually an `npm link` /
 * `file:` install that symlinks the global bin back into the repo `dist/`, so
 * resolving symlinks is what lets posture classification see the repo tree.
 */
function resolveLocalCollectorManifest(startUrl: string | URL): LocalCollectorManifestResolution {
  const startPath =
    typeof startUrl === "string" && !startUrl.startsWith("file:")
      ? startUrl
      : fileURLToPath(startUrl);
  let realStart = startPath;
  try {
    realStart = realpathSync(startPath);
  } catch {
    // Module path may not exist on disk in some test harnesses; fall back to
    // the lexical path so the walk still resolves the manifest.
  }
  let current = dirname(realStart);

  for (;;) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (
          manifest.name === LOCAL_COLLECTOR_PACKAGE_NAME &&
          typeof manifest.version === "string" &&
          manifest.version
        ) {
          return { packageRoot: current, version: manifest.version };
        }
      } catch {
        // Keep walking; malformed parent manifests should not break diagnostics.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return { packageRoot: null, version: LOCAL_COLLECTOR_PACKAGE_VERSION_FALLBACK };
    }
    current = parent;
  }
}

export function resolveLocalCollectorPackageVersion(startUrl: string | URL = import.meta.url): string {
  return resolveLocalCollectorManifest(startUrl).version;
}

/** Mutually-exclusive runtime-install classification for the collector. */
export type LocalCollectorDeploymentKind = "published_package" | "repo_dist_override" | "unknown";

export interface LocalCollectorDeploymentPosture {
  /**
   * How the running collector resolves: a published `node_modules` install, a
   * monorepo `dist/` (or source) override, or unknown when neither pattern is
   * conclusive. `unknown` is the conservative default — it never guesses
   * `published_package`.
   */
  kind: LocalCollectorDeploymentKind;
  /**
   * True when the resolved version is the `0.0.0` placeholder. Independent of
   * `kind`: a real pinned beta is good even though the in-repo manifest is
   * `0.0.0`, and an unpinned `latest` install of the placeholder is bad even if
   * it lives under `node_modules`. See `LOCAL_COLLECTOR_PLACEHOLDER_VERSION`.
   */
  is_placeholder_version: boolean;
  /**
   * Redacted module-location descriptor. Never an absolute home path: for a
   * published install this is `node_modules/@pdpp/local-collector`; for a repo
   * override it is the repo-relative package dir name `packages/local-collector`
   * (or `unresolved` when the manifest could not be located).
   */
  location_hint: string;
  /** Bin filename only (`pdpp-local-collector.js` / `.ts`), never a path. */
  module_basename: string;
  /** Resolved package version (echoes whatever build is installed). */
  version: string;
}

/**
 * Classify the running collector's deployment posture from its own resolved
 * module location plus the package manifest the CLI already reads. This is the
 * mechanical replacement for the documented manual `command -v` + `readlink -f`
 * + version cross-check ritual in `docs/local-collector.md`§"Deployment
 * Posture". Pure on `startUrl` so it is unit-testable against synthesized
 * published-like and repo-dist-like layouts.
 *
 * Spec: openspec/changes/add-local-collector-deployment-posture-surface.
 */
export function classifyLocalCollectorDeploymentPosture(
  startUrl: string | URL = import.meta.url
): LocalCollectorDeploymentPosture {
  const startPath =
    typeof startUrl === "string" && !startUrl.startsWith("file:")
      ? startUrl
      : fileURLToPath(startUrl);
  const moduleBasename = basename(startPath);
  const isSourceEntrypoint = extname(startPath) === ".ts";

  const { packageRoot, version } = resolveLocalCollectorManifest(startUrl);

  let kind: LocalCollectorDeploymentKind;
  let locationHint: string;
  if (!packageRoot) {
    // A `.ts` entrypoint is always source/dev even when no manifest resolved.
    kind = isSourceEntrypoint ? "repo_dist_override" : "unknown";
    locationHint = "unresolved";
  } else if (isUnderNodeModulesPackage(packageRoot)) {
    kind = "published_package";
    locationHint = `node_modules/${LOCAL_COLLECTOR_PACKAGE_NAME}`;
  } else if (isSourceEntrypoint || hasRepoOnlySiblings(packageRoot)) {
    // Not under node_modules, and either running the raw `.ts` source or the
    // package root still carries repo-only siblings the tarball never ships.
    kind = "repo_dist_override";
    locationHint = `packages/${basename(packageRoot)}`;
  } else {
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

/** True when `dir` sits inside a `node_modules/@pdpp/local-collector` path. */
function isUnderNodeModulesPackage(dir: string): boolean {
  return dir.split(sep).includes("node_modules");
}

/** True when the package root carries any repo-only sibling entry. */
function hasRepoOnlySiblings(packageRoot: string): boolean {
  return REPO_ONLY_PACKAGE_SIBLINGS.some((entry) => existsSync(join(packageRoot, entry)));
}

export interface CliOptions {
  apply?: boolean;
  args?: string[];
  baseUrl: string;
  code?: string;
  command:
    | "enroll"
    | "run"
    | "advertise"
    | "status"
    | "doctor"
    | "recover"
    | "retry-dead-letters"
    | "prune-sent"
    | "compact";
  connector?: string;
  deadLetterKind?: LocalDeviceOutboxKind;
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  entrypointCommand?: string;
  explicitOptions?: ReadonlySet<string>;
  force?: boolean;
  keepCount?: number;
  limit?: number;
  olderThanDays?: number;
  profile?: string;
  queuePath: string;
  runId?: string;
  sourceInstanceId?: string;
  streams?: string[];
  streamsToBackfill?: string[];
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
          [--source-instance-id <id>]
          [--profile <name>]        Optional profile name under the collector profile dir.
  doctor                          Print local durable outbox operator diagnostics as JSON.
          [--queue <path>]
          [--connection-id <id>]
          [--source-instance-id <id>]
          [--profile <name>]        Optional profile name under the collector profile dir.
  retry-dead-letters              Requeue local dead-letter outbox rows.
          [--queue <path>]
          [--connection-id <id>]
          [--source-instance-id <id>]
          [--kind record_batch|checkpoint|gap|blob_upload]
          [--limit <n>]
          [--apply]                Dry-run by default; --apply mutates after a DB backup.
  recover                         Resolve the enrolled local profile, recover stalled outbox work,
                                   and run the collector once.
          --source-instance-id <id>
          [--profile <name>]        Optional profile name under the collector profile dir.
          [--apply]                Dry-run by default; --apply requeues and runs.
  prune-sent                      Delete sent (succeeded) outbox rows to reclaim disk space.
          [--queue <path>]
          [--connection-id <id>]
          [--source-instance-id <id>]
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
          [--source-instance-id <id>]
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "advertise") {
    process.stdout.write(
      `${JSON.stringify(
        {
          runtime: COLLECTOR_RUNTIME_CAPABILITIES.id,
          bindings: [...COLLECTOR_RUNTIME_CAPABILITIES.bindings],
          collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
          bundled_connectors: BUNDLED_CONNECTOR_IDS,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (options.command === "status" || options.command === "doctor") {
    const inspectOptions = resolveInspectionOptions(options);
    const status = inspectLocalOutboxStatus(inspectOptions);
    if (options.command === "doctor") {
      const errorSummary = readLocalOutboxDeadLetterErrorSummary(inspectOptions);
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

  if (options.command === "recover") {
    const result = await recoverLocalCollector(options);
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
    // A refused apply is an operator error (unsent work present); exit non-zero
    // so a supervising script does not mistake the refusal for a successful
    // reclaim. Dry-run and successful apply exit 0.
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

  const result = await runCollectorOnce(options);
  process.stdout.write(`${JSON.stringify(summarizeRunResultForCli(result), null, 2)}\n`);
}

type CollectorRunResult = Awaited<ReturnType<typeof runCollectorConnector>>;

async function runCollectorOnce(options: CliOptions): Promise<CollectorRunResult> {
  if (!(options.deviceId && options.deviceToken && options.sourceInstanceId)) {
    throw new CollectorUsageError(
      "run requires --device-id <id>, --device-token <token>, and --connection-id/--source-instance-id <id>"
    );
  }
  if (!options.connector) {
    throw new CollectorUsageError("run requires --connector <connector-id>");
  }

  const spec = buildConnectorSpec(options);
  return runCollectorConnector({
    baseUrl: options.baseUrl,
    connector: spec,
    deviceId: options.deviceId,
    deviceToken: options.deviceToken,
    queuePath: scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId),
    ...(options.runId ? { runId: options.runId } : {}),
    sourceInstanceId: options.sourceInstanceId,
  });
}

export interface LocalCollectorRunOutput extends Omit<CollectorRunResult, "flushedState" | "priorState"> {
  /**
   * One honest, operator-facing line describing the drain outcome of this
   * invocation. A successful connector pass (`done.status === "succeeded"`)
   * does NOT imply the outbox is empty: the run can succeed on the source
   * while leaving ready/retrying/leased rows that drain on the next scheduled
   * run, or dead-letter rows that need recovery. This note states which.
   */
  drain_note: string;
  /**
   * True only when this invocation left the lane fully drained — no ready,
   * retrying, leased, or dead-letter work remains. False whenever any
   * non-succeeded row is still in the outbox after the drain, so a run that
   * exits with a ready backlog is never reported as fully drained.
   */
  drained: boolean;
  flushedState: LocalCollectorStateSummary | null;
  /**
   * Drain-state lifecycle derived from {@link CollectorRunResult.outboxSummary}
   * using the same taxonomy the `status`/`doctor` surface reports, so the run
   * path and the inspect path never disagree about whether the lane is idle.
   * Coverage is intentionally NOT folded in here (the run separately reports
   * `completeness`); this axis is purely "did the queue drain?".
   */
  lifecycle_state: LocalCollectorLifecycleState;
  priorState: LocalCollectorStateSummary | null;
  /**
   * What is still in the outbox after this invocation. Surfaced as a named
   * block (not just buried in `outboxSummary`) precisely so a successful run
   * that left work behind reads as "still has a backlog", not "done".
   */
  residual_backlog: {
    dead_letter: number;
    leased: number;
    ready: number;
    retrying: number;
    total_open: number;
  };
}

export interface LocalCollectorStateSummary {
  stream_count: number;
  streams: Record<string, LocalCollectorCursorSummary>;
}

export interface LocalCollectorCursorSummary {
  fetched_at?: string;
  file_cursors_count?: number;
  file_mtimes_count?: number;
  keys: string[];
}

export function summarizeRunResultForCli(result: CollectorRunResult): LocalCollectorRunOutput {
  const summary = result.outboxSummary;
  // Derive the drain-state lifecycle from the post-drain outbox summary using
  // the shared taxonomy. Coverage is a separate axis (reported via
  // `completeness` and surfaced by `doctor`), so it is suppressed here with a
  // null observation; this verdict is purely about queue drain state.
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

/**
 * One honest line about the drain outcome. A connector pass can succeed on the
 * source while leaving a ready backlog (the next scheduled run drains it),
 * retrying rows (waiting on backoff), or dead-letter rows (need recovery). The
 * note never says "drained" when work remains — this is the line that keeps a
 * 177k-record run that exits with `pending=1203` from reading as complete.
 */
function runDrainNote(result: CollectorRunResult, summary: LocalDeviceOutboxSummary, drained: boolean): string {
  if (result.skippedScanForBacklog) {
    return (
      `Scan was skipped: ${pendingOpenWork(summary)} open outbox row(s) from a prior run still need to drain first. ` +
      "No new source work was collected this pass; re-run to continue draining."
    );
  }
  if (drained) {
    return "Outbox fully drained — no ready, retrying, leased, or dead-letter work remains.";
  }
  const parts: string[] = [];
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
    parts.push(`${summary.deadLetter} dead-letter (run \`recover --source-instance-id <id> --apply\`)`);
  }
  const scanNote = result.scanBudgetExceeded
    ? " The connector was stopped by the per-run enqueue budget, so more source work likely remains; re-run to continue."
    : "";
  return `Run succeeded on the source but the outbox is NOT fully drained: ${parts.join(", ")}.${scanNote}`;
}

function pendingOpenWork(summary: LocalDeviceOutboxSummary): number {
  return summary.ready + summary.retrying + summary.leased + summary.deadLetter;
}

function summarizeCollectorState(state: Record<string, unknown> | null): LocalCollectorStateSummary | null {
  if (!state || Object.keys(state).length === 0) {
    return null;
  }
  const streams: Record<string, LocalCollectorCursorSummary> = {};
  for (const [stream, cursor] of Object.entries(state).sort(([a], [b]) => a.localeCompare(b))) {
    streams[stream] = summarizeCursor(cursor);
  }
  return {
    stream_count: Object.keys(streams).length,
    streams,
  };
}

function summarizeCursor(cursor: unknown): LocalCollectorCursorSummary {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return { keys: [] };
  }
  const record = cursor as Record<string, unknown>;
  const summary: LocalCollectorCursorSummary = {
    keys: Object.keys(record).sort(),
  };
  if (typeof record.fetched_at === "string") {
    summary.fetched_at = record.fetched_at;
  }
  if (record.file_mtimes && typeof record.file_mtimes === "object" && !Array.isArray(record.file_mtimes)) {
    summary.file_mtimes_count = Object.keys(record.file_mtimes).length;
  }
  // The append-safe rollout cursor adds `file_cursors`: a map keyed by private
  // file path with byte offsets and integrity hashes. Summarize only its COUNT
  // — never its keys (paths) or values (offsets/hashes) — so the CLI surface
  // stays free of payloads, paths, and source content, exactly like file_mtimes.
  if (record.file_cursors && typeof record.file_cursors === "object" && !Array.isArray(record.file_cursors)) {
    summary.file_cursors_count = Object.keys(record.file_cursors).length;
  }
  return summary;
}

export interface LocalOutboxStatusOutput {
  collector_protocol_version: string;
  configured_device: {
    device_id_configured: boolean;
    device_token_configured: boolean;
  };
  /**
   * Local coverage-diagnostic observation for this lane, derived from the
   * durable outbox alone (never the server). A drained lane that has carried
   * real records but never a `coverage_diagnostics` record is the local
   * shape behind the dashboard's stuck `coverage_unknown`.
   *
   * - `observed`: true once any non-dead-letter `record_batch` row has
   *   carried a `coverage_diagnostics` record. `null` when the surface cannot
   *   answer it: either no connection id was supplied (the scan cannot be
   *   scoped, so it does not guess), or a legacy pre-index outbox carries more
   *   unindexed record batches than the bounded coverage-scan budget (the
   *   probe refuses an unbounded payload scan; re-running the collector
   *   indexes the lane and a later probe answers exactly).
   * - `record_batches`: count of non-dead-letter record batches for the lane.
   *   Lets `observed: false` mean "collected records but no coverage" rather
   *   than "nothing collected yet".
   */
  coverage: {
    observed: boolean | null;
    record_batches: number;
  };
  db: {
    configured: boolean;
    exists: boolean;
    path: string | null;
  };
  /**
   * Redaction-safe published-vs-dev runtime posture for the running collector,
   * derived from the module's own resolved location plus the package manifest.
   * Lets an operator or agent tell published operator-host evidence from local
   * development evidence without the manual `command -v`/`readlink -f` ritual.
   * Never carries an absolute home path.
   */
  deployment_posture: LocalCollectorDeploymentPosture;
  /**
   * The single mutually-exclusive lifecycle state for this lane, derived
   * from the outbox counts plus the coverage observation. One of
   * healthy_idle, draining, retryable_backlog, dead_letter, stale_lease, or
   * coverage_missing. This is the honest active/drain/coverage signal an
   * operator or agent reads instead of inferring from raw counts.
   */
  lifecycle_state: LocalCollectorLifecycleState;
  outbox: {
    counts: {
      dead_letter: number;
      leased: number;
      pending: number;
      retrying: number;
      sent: number;
      total: number;
    };
    expired_leases: number;
    oldest_pending_at: string | null;
  };
  package: {
    name: string;
    version: string;
  };
  source: {
    connection_id: string | null;
    source_instance_id: string | null;
  };
}

export interface LocalOutboxDoctorOutput extends LocalOutboxStatusOutput {
  checks: {
    /**
     * `warn` once the lane has collected records but never carried a
     * `coverage_diagnostics` record (the local shape behind a stuck
     * dashboard `coverage_unknown`). `ok` when coverage was observed, the
     * lane is empty, or no connection id scoped the scan.
     */
    coverage_diagnostics: "ok" | "warn";
    /**
     * `warn` when the running collector is a `repo_dist_override` or reports the
     * `0.0.0` placeholder version — either disqualifies the output as published
     * operator-host evidence. `ok` for a published install on a real version.
     * This is a warning (dev is the supported monorepo path), never `critical`.
     */
    deployment_posture: "ok" | "warn";
    expired_leases: "ok" | "warn";
    outbox_db: "ok" | "missing";
    outbox_failures: "ok" | "fail";
  };
  /**
   * Top redacted dead-letter error classes, present only when there are
   * dead-letter rows. This is the "why did these dead-letter?" answer: the
   * `last_error` text already stored on each row, collapsed into stable
   * classes with counts (paths/tokens/ids scrubbed). Omitted on a clean run.
   */
  dead_letter_error_summary?: LocalDeviceOutboxDeadLetterErrorSummary;
  /**
   * Operator-actionable hints, present only when a check is non-`ok`. The
   * field is omitted when everything is healthy so a clean doctor run stays
   * quiet. Hints are static guidance strings — counts/commands only, never
   * payloads, paths from rows, tokens, or cookies.
   */
  remediation?: string[];
  status: "ok" | "warning" | "critical";
}

export interface RetryDeadLettersOutput {
  backup_path: string | null;
  db: {
    exists: boolean;
    path: string;
  };
  /**
   * Top redacted dead-letter error classes for the rows this command
   * matched. Present whenever there are dead-letter rows, so a `--dry-run`
   * preview shows *why* before `--apply` requeues. Omitted when nothing
   * matched.
   */
  dead_letter_error_summary?: LocalDeviceOutboxDeadLetterErrorSummary;
  dry_run: boolean;
  filter: {
    kind: LocalDeviceOutboxKind | null;
    limit: number | null;
    source_instance_id: string | null;
  };
  matched: number;
  /**
   * One-line operator guidance distinguishing the two stall shapes:
   * - dead-letter backlog (matched > 0): requeue then re-run drains it.
   * - state-read block (matched == 0 with a `blocked` heartbeat): there is
   *   nothing to requeue; recovery is simply re-running the collector, which
   *   re-reads prior state and clears the block.
   */
  note: string;
  requeued: number;
  status_after: LocalOutboxStatusOutput["outbox"]["counts"] | null;
  status_before: LocalOutboxStatusOutput["outbox"]["counts"] | null;
}

export interface InspectLocalOutboxStatusDeps {
  /**
   * Injected deployment posture, defaulting to live detection from the running
   * module. Tests inject a synthesized posture so outbox-shape assertions stay
   * deterministic regardless of where the test process itself resolves from.
   */
  deploymentPosture?: LocalCollectorDeploymentPosture;
}

export function inspectLocalOutboxStatus(
  options: CliOptions,
  deps: InspectLocalOutboxStatusDeps = {}
): LocalOutboxStatusOutput {
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

export function buildLocalOutboxDoctor(
  status: LocalOutboxStatusOutput,
  errorSummary?: LocalDeviceOutboxDeadLetterErrorSummary | null
): LocalOutboxDoctorOutput {
  const posture = status.deployment_posture;
  const postureDisqualifiesEvidence =
    posture.kind === "repo_dist_override" || posture.is_placeholder_version;
  const checks: LocalOutboxDoctorOutput["checks"] = {
    coverage_diagnostics: status.lifecycle_state === "coverage_missing" ? "warn" : "ok",
    deployment_posture: postureDisqualifiesEvidence ? "warn" : "ok",
    expired_leases: status.outbox.expired_leases > 0 ? "warn" : "ok",
    outbox_db: status.db.exists ? "ok" : "missing",
    outbox_failures: status.outbox.counts.dead_letter > 0 ? "fail" : "ok",
  };
  const remediation: string[] = [];
  if (checks.outbox_failures === "fail") {
    const topClass = errorSummary?.top_classes?.[0];
    const causeHint = topClass
      ? ` Most common cause: ${topClass.error_class} (${topClass.count} row(s)).`
      : "";
    remediation.push(
      `${status.outbox.counts.dead_letter} dead-letter row(s) need recovery.${causeHint} ` +
        "Preview with `pdpp-local-collector recover --source-instance-id <id>`, then apply with " +
        "`pdpp-local-collector recover --source-instance-id <id> --apply`. The apply step backs up the DB, " +
        "prepares failed uploads for retry when present, and runs the collector once."
    );
  }
  if (checks.expired_leases === "warn") {
    remediation.push(
      `${status.outbox.expired_leases} lease(s) are past expiry — a previous run likely crashed mid-drain. ` +
        "The next `pdpp-local-collector run …` recovers expired leases automatically before scanning; " +
        "no manual action is required."
    );
  }
  if (checks.coverage_diagnostics === "warn") {
    remediation.push(
      `This lane drained ${status.coverage.record_batches} record batch(es) but never carried a ` +
        "`coverage_diagnostics` record, so the dashboard can only show coverage_unknown. " +
        "Re-run with a build that emits `coverage_diagnostics` by default and the default stream set (no `--streams`): " +
        "`npx -y @pdpp/local-collector run …` (or `pdpp-local-collector run …` if already on a current build). " +
        "Older installs may omit `coverage_diagnostics` from bundled defaults. `npx -y` fetches the latest *published* build, " +
        "which can still lag the repo build — if the gap persists, confirm the published `latest` carries the fix with " +
        "`pnpm release:dist-tag-check` (release owner) rather than assuming the published build is current."
    );
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

/**
 * Static guidance for a posture warning. Counts/classification only — no row
 * data, paths beyond the redacted hint, tokens, or payloads. Distinguishes the
 * two disqualifying shapes (repo override vs placeholder version) and points at
 * the posture section of the operator doc.
 */
function deploymentPostureRemediation(posture: LocalCollectorDeploymentPosture): string {
  const parts: string[] = [];
  if (posture.kind === "repo_dist_override") {
    parts.push(
      `This collector resolves to a repo \`dist/\` override (${posture.location_hint}), ` +
        "not a published package — treat its output as dev evidence, not published " +
        "operator-host evidence."
    );
  }
  if (posture.is_placeholder_version) {
    parts.push(
      `The reported version is the \`${posture.version}\` placeholder, which is older than ` +
        "every real build (left over from the npm bootstrap; upgrade to the published release)."
    );
  }
  parts.push(
    "Pin a published version before capturing operator-host evidence: " +
      "`npm i -g @pdpp/local-collector` (or an explicit pinned `@<version>`). " +
      "The published build can lag the repo build, so confirm it carries the " +
      "fixes you need before re-pinning — `pnpm release:dist-tag-check` (release " +
      "owner) reports the live dist-tag posture; a `repo_dist_override` that is " +
      "ahead of the published build is dev evidence, not a build to downgrade to. " +
      "See docs/local-collector.md §\"Deployment Posture: Published vs Dev\"."
  );
  return parts.join(" ");
}

/**
 * Roll the per-check verdicts into the coarse doctor severity. Dead-letter
 * rows are the only `critical` condition (they need operator recovery);
 * expired leases, a missing DB, a coverage gap, and a dev/placeholder
 * deployment posture are `warning` (each self-heals, is informational, or is a
 * supported dev path that merely disqualifies operator-host evidence);
 * everything else is `ok`. A `retryable_backlog`/`draining` lane stays `ok`
 * because it drains itself on the next scheduled run — surfaced via
 * `lifecycle_state`, not as a warning.
 */
function doctorSeverityForChecks(checks: LocalOutboxDoctorOutput["checks"]): "ok" | "warning" | "critical" {
  if (checks.outbox_failures === "fail") {
    return "critical";
  }
  if (
    checks.expired_leases === "warn" ||
    checks.outbox_db === "missing" ||
    checks.coverage_diagnostics === "warn" ||
    checks.deployment_posture === "warn"
  ) {
    return "warning";
  }
  return "ok";
}

/**
 * Read the top dead-letter error classes from the local outbox, if the DB
 * exists and has dead-letter rows. Returns null otherwise so `doctor` stays
 * quiet on a clean host. Selects only the `last_error` column — never
 * payloads, paths, tokens, or record bodies.
 */
export function readLocalOutboxDeadLetterErrorSummary(
  options: CliOptions
): LocalDeviceOutboxDeadLetterErrorSummary | null {
  const dbPath = resolveOutboxPath(options);
  if (!existsSync(dbPath)) {
    return null;
  }
  const outbox = new LocalDeviceOutbox({ path: dbPath });
  try {
    const summary = outbox.deadLetterErrorSummary(
      options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}
    );
    return summary.dead_letter_count > 0 ? summary : null;
  } finally {
    outbox.close();
  }
}

const RETRY_DEAD_LETTERS_NO_MATCH_NOTE =
  "No dead-letter rows matched. If the dashboard shows this connection as " +
  "blocked/stalled, that is a state-read block, not a dead-letter backlog — " +
  "there is nothing to requeue. Use `pdpp-local-collector recover --source-instance-id <id> --apply` " +
  "to run the collector through the enrolled local profile and clear the block.";

function retryDeadLettersMatchNote(matched: number, dryRun: boolean): string {
  if (matched === 0) {
    return RETRY_DEAD_LETTERS_NO_MATCH_NOTE;
  }
  const requeued = dryRun
    ? `${matched} dead-letter row(s) would be requeued (dry run). `
    : `${matched} dead-letter row(s) matched and were requeued to pending. `;
  return (
    `${requeued}Use \`pdpp-local-collector recover --source-instance-id <id> --apply\` for the dashboard recovery path. ` +
    "This low-level command only moves rows to pending; it does not ingest."
  );
}

export function retryLocalOutboxDeadLetters(options: CliOptions): RetryDeadLettersOutput {
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
    const errorSummary = outbox.deadLetterErrorSummary(
      options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}
    );
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
  } finally {
    outbox.close();
  }
}

export interface LocalCollectorProfile {
  env: Record<string, string>;
  name: string;
  path: string;
  source_instance_id: string | null;
}

export interface LocalCollectorProfileLookupResult {
  matches: LocalCollectorProfile[];
  profile_dir: string;
}

export interface RecoverLocalCollectorOutput {
  applied: boolean;
  db: {
    exists: boolean;
    path: string;
  };
  dry_run: boolean;
  note: string;
  object: "local_collector_recovery";
  profile: {
    name: string | null;
    source: "configured_queue" | "local_profile";
  };
  retry_dead_letters: RetryDeadLettersOutput | null;
  run: LocalCollectorRunOutput | null;
  source_instance_id: string;
  status_after: LocalOutboxStatusOutput | null;
  status_before: LocalOutboxStatusOutput;
}

function defaultCollectorProfileDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "pdpp", "collectors");
}

export function parseCollectorProfileEnv(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = assignment.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = assignment.slice(0, eq).trim();
    const rawValue = assignment.slice(eq + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      continue;
    }
    env[key] = unquoteProfileEnvValue(rawValue);
  }
  return env;
}

function unquoteProfileEnvValue(rawValue: string): string {
  if (rawValue.length >= 2) {
    const quote = rawValue[0];
    if ((quote === '"' || quote === "'") && rawValue.endsWith(quote)) {
      const inner = rawValue.slice(1, -1);
      return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
    }
  }
  return rawValue;
}

function profileSourceInstanceId(env: Record<string, string>): string | null {
  return env.PDPP_SOURCE_INSTANCE_ID?.trim() || env.PDPP_CONNECTION_ID?.trim() || null;
}

function safeProfileFileName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new CollectorUsageError("--profile must be a simple profile file name");
  }
  return trimmed.endsWith(".env") ? trimmed : `${trimmed}.env`;
}

export function findLocalCollectorProfiles(input: {
  profileDir?: string;
  profileName?: string | null;
  sourceInstanceId?: string | null;
}): LocalCollectorProfileLookupResult {
  const profileDir = input.profileDir?.trim() || process.env[LOCAL_COLLECTOR_PROFILE_DIR_ENV]?.trim() || defaultCollectorProfileDir();
  const sourceInstanceId = input.sourceInstanceId?.trim() || null;
  const files = input.profileName
    ? [safeProfileFileName(input.profileName)]
    : (() => {
        try {
          return readdirSync(profileDir).filter((name) => name.endsWith(".env")).sort();
        } catch {
          return [];
        }
      })();

  const matches: LocalCollectorProfile[] = [];
  for (const file of files) {
    const path = join(profileDir, file);
    let env: Record<string, string>;
    try {
      env = parseCollectorProfileEnv(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const profileSource = profileSourceInstanceId(env);
    if (sourceInstanceId && profileSource !== sourceInstanceId) {
      continue;
    }
    matches.push({
      env,
      name: file.replace(/\.env$/, ""),
      path,
      source_instance_id: profileSource,
    });
  }

  return { matches, profile_dir: profileDir };
}

function applyProfileEnv(options: CliOptions, profile: LocalCollectorProfile): CliOptions {
  const env = profile.env;
  const explicit = options.explicitOptions;
  const keep = (flag: string): boolean => explicit?.has(flag) === true;
  const next: CliOptions = {
    ...options,
    baseUrl: keep("--base-url") ? options.baseUrl : env.PDPP_REFERENCE_BASE_URL?.trim() || options.baseUrl,
    queuePath: keep("--queue") ? options.queuePath : env.PDPP_COLLECTOR_QUEUE?.trim() || options.queuePath,
  };
  const sourceInstanceId = profile.source_instance_id ?? options.sourceInstanceId;
  const connector = keep("--connector") ? options.connector : env.PDPP_COLLECTOR_CONNECTOR?.trim() || options.connector;
  const deviceId = keep("--device-id") ? options.deviceId : env.PDPP_LOCAL_DEVICE_ID?.trim() || options.deviceId;
  const deviceToken = keep("--device-token") ? options.deviceToken : env.PDPP_LOCAL_DEVICE_TOKEN?.trim() || options.deviceToken;
  if (sourceInstanceId) {
    next.sourceInstanceId = sourceInstanceId;
  }
  if (connector) {
    next.connector = connector;
  }
  if (deviceId) {
    next.deviceId = deviceId;
  }
  if (deviceToken) {
    next.deviceToken = deviceToken;
  }
  return next;
}

function resolveRecoveryOptions(options: CliOptions): {
  options: CliOptions;
  profileName: string | null;
  profileSource: "configured_queue" | "local_profile";
} {
  const sourceInstanceId = options.sourceInstanceId?.trim();
  if (!sourceInstanceId) {
    throw new CollectorUsageError("recover requires --source-instance-id <id>");
  }

  const lookup = findLocalCollectorProfiles({
    profileName: options.profile ?? null,
    sourceInstanceId,
  });
  if (lookup.matches.length > 1) {
    throw new CollectorUsageError(
      `recover found ${lookup.matches.length} local collector profiles for source_instance_id '${sourceInstanceId}'. ` +
        "Pass --profile <name> to disambiguate."
    );
  }
  if (lookup.matches.length === 1) {
    const profile = lookup.matches[0] as LocalCollectorProfile;
    return {
      options: applyProfileEnv(options, profile),
      profileName: profile.name,
      profileSource: "local_profile",
    };
  }

  const configuredQueue =
    options.queuePath !== DEFAULT_QUEUE_PATH || Boolean(process.env.PDPP_COLLECTOR_QUEUE?.trim());
  if (!configuredQueue) {
    throw new CollectorUsageError(
      `recover could not find a local collector profile for source_instance_id '${sourceInstanceId}'. ` +
        "Run this on the collector host after enrollment, pass --profile <name>, or set PDPP_COLLECTOR_QUEUE/--queue explicitly. " +
        "Refusing to inspect the package default queue because it is often unrelated to the enrolled collector."
    );
  }

  return {
    options,
    profileName: null,
    profileSource: "configured_queue",
  };
}

export function resolveInspectionOptions(options: CliOptions): CliOptions {
  const sourceInstanceId = options.sourceInstanceId?.trim();
  if (!sourceInstanceId || options.explicitOptions?.has("--queue") === true) {
    return options;
  }

  const lookup = findLocalCollectorProfiles({
    profileName: options.profile ?? null,
    sourceInstanceId,
  });
  if (lookup.matches.length > 1) {
    throw new CollectorUsageError(
      `${options.command} found ${lookup.matches.length} local collector profiles for source_instance_id '${sourceInstanceId}'. ` +
        "Pass --profile <name> to disambiguate."
    );
  }
  if (lookup.matches.length === 1) {
    return applyProfileEnv(options, lookup.matches[0] as LocalCollectorProfile);
  }

  const configuredQueue =
    options.queuePath !== DEFAULT_QUEUE_PATH || Boolean(process.env.PDPP_COLLECTOR_QUEUE?.trim());
  if (!configuredQueue) {
    throw new CollectorUsageError(
      `${options.command} could not find a local collector profile for source_instance_id '${sourceInstanceId}'. ` +
        "Run this on the collector host after enrollment, pass --profile <name>, or set PDPP_COLLECTOR_QUEUE/--queue explicitly. " +
        "Refusing to inspect the package default queue because it is often unrelated to the enrolled collector."
    );
  }

  return options;
}

function hasDeadLetters(status: LocalOutboxStatusOutput): boolean {
  return status.outbox.counts.dead_letter > 0;
}

function recoverDryRunNote(status: LocalOutboxStatusOutput): string {
  if (hasDeadLetters(status)) {
    return (
      `${status.outbox.counts.dead_letter} failed upload row(s) would be prepared for retry, then the collector would run once. ` +
      "Dry run only; re-run with --apply to mutate the local outbox and upload."
    );
  }
  return (
    "No failed upload rows are present for this source. The recovery apply step would run the collector once on this host " +
    "to refresh state and drain queued work."
  );
}

function recoverAppliedNote(statusBefore: LocalOutboxStatusOutput, retry: RetryDeadLettersOutput | null): string {
  const retried = retry ? `${retry.requeued} failed upload row(s) were prepared for retry. ` : "";
  if (hasDeadLetters(statusBefore)) {
    return `${retried}The collector ran once to upload queued work. Run status again if the dashboard has not refreshed yet.`;
  }
  return "The collector ran once to refresh local state and drain queued work.";
}

export async function recoverLocalCollector(options: CliOptions): Promise<RecoverLocalCollectorOutput> {
  const resolved = resolveRecoveryOptions(options);
  const sourceInstanceId = resolved.options.sourceInstanceId;
  if (!sourceInstanceId) {
    throw new CollectorUsageError("recover requires --source-instance-id <id>");
  }

  const statusBefore = inspectLocalOutboxStatus(resolved.options);
  const retryPreview = hasDeadLetters(statusBefore) ? retryLocalOutboxDeadLetters({ ...resolved.options, apply: false }) : null;

  if (!options.apply) {
    return {
      applied: false,
      db: statusBefore.db.path ? { exists: statusBefore.db.exists, path: statusBefore.db.path } : { exists: false, path: "" },
      dry_run: true,
      note: recoverDryRunNote(statusBefore),
      object: "local_collector_recovery",
      profile: { name: resolved.profileName, source: resolved.profileSource },
      retry_dead_letters: retryPreview,
      run: null,
      source_instance_id: sourceInstanceId,
      status_after: null,
      status_before: statusBefore,
    };
  }

  const retryApply = hasDeadLetters(statusBefore) ? retryLocalOutboxDeadLetters({ ...resolved.options, apply: true }) : null;
  const run = summarizeRunResultForCli(await runCollectorOnce(resolved.options));
  const statusAfter = inspectLocalOutboxStatus(resolved.options);
  return {
    applied: true,
    db: statusAfter.db.path ? { exists: statusAfter.db.exists, path: statusAfter.db.path } : { exists: false, path: "" },
    dry_run: false,
    note: recoverAppliedNote(statusBefore, retryApply),
    object: "local_collector_recovery",
    profile: { name: resolved.profileName, source: resolved.profileSource },
    retry_dead_letters: retryApply,
    run,
    source_instance_id: sourceInstanceId,
    status_after: statusAfter,
    status_before: statusBefore,
  };
}

function summaryCounts(summary: LocalDeviceOutboxSummary): LocalOutboxStatusOutput["outbox"]["counts"] {
  return {
    dead_letter: summary.deadLetter,
    leased: summary.leased,
    pending: summary.ready,
    retrying: summary.retrying,
    sent: summary.succeeded,
    total: summary.total,
  };
}

/**
 * Default sent-row retention policy applied when neither --older-than-days
 * nor --keep-count is supplied. 30 days is long enough to cover any operator
 * debugging window while preventing unbounded growth on a continuously-running
 * host collector.
 */
const DEFAULT_PRUNE_SENT_OLDER_THAN_DAYS = 30;

export interface PruneSentOutput {
  backup_path: string | null;
  db: {
    exists: boolean;
    path: string;
  };
  dry_run: boolean;
  filter: {
    keep_count: number | null;
    older_than_days: number | null;
    older_than_iso: string | null;
    source_instance_id: string | null;
  };
  matched: number;
  note: string;
  pruned: number;
  status_after: LocalOutboxStatusOutput["outbox"]["counts"] | null;
  status_before: LocalOutboxStatusOutput["outbox"]["counts"] | null;
}

/**
 * Prune succeeded (sent) outbox rows to reclaim disk space. Never touches
 * pending, leased, retrying, or dead-letter rows. Dry-run by default;
 * --apply backs up the DB first, then deletes.
 */
export function pruneSentOutboxRows(options: CliOptions): PruneSentOutput {
  // Apply the default age-based filter only when the operator has not specified
  // keepCount as their sole policy. If keepCount is the only flag, skip the age
  // filter so the count cap works independently of row age. If --older-than-days
  // is explicitly set, always apply it (alone or combined with keepCount).
  const olderThanDays =
    options.olderThanDays ?? (options.keepCount === undefined ? DEFAULT_PRUNE_SENT_OLDER_THAN_DAYS : undefined);
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

    const pruneInput: LocalDeviceOutboxPruneSentInput = {
      dryRun,
      ...(olderThanIso !== undefined ? { olderThanIso } : {}),
      ...(options.keepCount !== undefined ? { keepCount: options.keepCount } : {}),
      ...(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}),
    };

    // For dry-run, preview the match count without acquiring a write lock.
    // For apply, back up first then delete.
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
  } finally {
    outbox.close();
  }
}

function pruneSentNote(
  result: LocalDeviceOutboxPruneSentResult,
  dryRun: boolean,
  olderThanDays: number | null,
  keepCount: number | undefined
): string {
  if (result.matched === 0) {
    return `No sent rows matched the retention policy (${pruneSentPolicyDescription(olderThanDays, keepCount)}). Nothing to prune.`;
  }
  if (dryRun) {
    return (
      `${result.matched} sent row(s) would be pruned (dry run). ` +
      `Re-run with --apply to delete (backs up the DB first). ` +
      `This only removes sent rows — pending, leased, retrying, and dead-letter rows are never touched.`
    );
  }
  return (
    `${result.pruned} sent row(s) pruned. ` +
    `Pending, leased, retrying, and dead-letter rows were not touched. ` +
    `Run \`pdpp-local-collector status\` to confirm the new outbox size.`
  );
}

function pruneSentPolicyDescription(olderThanDays: number | null, keepCount: number | undefined): string {
  const parts: string[] = [];
  if (olderThanDays !== null) {
    parts.push(`older than ${olderThanDays} days`);
  }
  if (keepCount !== undefined) {
    parts.push(`keep-count ${keepCount}`);
  }
  return parts.length > 0 ? parts.join(", ") : "default sent-row retention";
}

/** ISO timestamp for N days ago (used as the default sent-row retention boundary). */
function daysAgoIso(days: number): string {
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export interface CompactOutput {
  backup_path: string | null;
  /** Page accounting after a successful apply; null on dry-run or refusal. */
  compacted: LocalDeviceOutboxPageStats | null;
  db: {
    exists: boolean;
    path: string;
  };
  dry_run: boolean;
  note: string;
  /**
   * Count of rows that are NOT `succeeded` (ready/leased/dead-letter) across
   * the whole file. A non-zero value blocks an apply unless `--force` is set.
   */
  non_succeeded_rows: number;
  /** Reclaimable disk before this command ran (`freelist * page_size`). */
  page_stats: LocalDeviceOutboxPageStats | null;
  /** Bytes actually returned to the filesystem (0 on dry-run or refusal). */
  reclaimed_bytes: number;
  /**
   * True when an `--apply` was refused because unsent rows exist and `--force`
   * was not supplied. The DB is never mutated on a refusal.
   */
  refused: boolean;
}

/**
 * Reclaim disk from a large local outbox SQLite file by rebuilding it in place
 * with `VACUUM`. `prune-sent` (and the run-time auto-prune) delete acknowledged
 * rows, but with `auto_vacuum = NONE` the freed pages stay in the file as
 * freelist and never return to the filesystem — so a 35 GB outbox whose rows
 * were all pruned stays a 35 GB file. This command drops that freelist.
 *
 * Safety:
 * - Dry-run by default: reports the reclaimable bytes and the non-succeeded
 *   row count without touching the DB.
 * - `--apply` REFUSES when any non-`succeeded` (ready/leased/dead-letter) row
 *   exists, unless `--force` is supplied. `VACUUM` itself is lossless — it
 *   copies every row including unsent work — so this guard is a quiet-state
 *   policy (compact a drained lane, not one mid-drain), not a data-safety
 *   requirement. The refusal exits non-zero and never mutates the file.
 * - `--apply` backs up the DB (`VACUUM INTO` a `.bak`) before rebuilding, like
 *   `prune-sent` and `retry-dead-letters`.
 */
export function compactOutbox(options: CliOptions): CompactOutput {
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

    // Apply path. Refuse if unsent work exists and --force was not supplied.
    if (nonSucceeded > 0 && !options.force) {
      return {
        backup_path: null,
        compacted: null,
        db: { exists: true, path: dbPath },
        dry_run: false,
        note:
          `Refusing to compact: ${nonSucceeded} non-succeeded (ready/leased/dead-letter) row(s) are still in the outbox. ` +
          "Drain the lane first (`pdpp-local-collector recover --source-instance-id <id> --apply` for stalled work), " +
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
  } finally {
    outbox.close();
  }
}

function compactDryRunNote(stats: LocalDeviceOutboxPageStats, nonSucceeded: number, force: boolean): string {
  const reclaimMb = (stats.reclaimableBytes / (1024 * 1024)).toFixed(1);
  if (stats.reclaimableBytes === 0) {
    return "The outbox has no reclaimable free pages; a compact would return ~0 bytes. Nothing to do.";
  }
  const base =
    `~${reclaimMb} MiB of free pages can be returned to the filesystem (${stats.freelistPages} of ${stats.pageCount} pages). ` +
    "Re-run with --apply to rebuild the DB in place (backs up the DB first).";
  if (nonSucceeded > 0 && !force) {
    return (
      `${base} NOTE: ${nonSucceeded} non-succeeded (unsent) row(s) are present, so --apply will be refused unless you ` +
      "drain the lane first or pass --force. VACUUM never drops unsent rows; the refusal just keeps the reclaim on a quiet outbox."
    );
  }
  return base;
}

function compactAppliedNote(
  result: LocalDeviceOutboxCompactResult,
  nonSucceeded: number,
  force: boolean
): string {
  const reclaimedMb = (result.reclaimedBytes / (1024 * 1024)).toFixed(1);
  const forcedNote =
    nonSucceeded > 0 && force
      ? ` Compacted with --force while ${nonSucceeded} non-succeeded row(s) were present; VACUUM copied them losslessly.`
      : "";
  return (
    `Compacted: ~${reclaimedMb} MiB returned to the filesystem ` +
    `(${result.before.pageCount} → ${result.after.pageCount} pages).${forcedNote} ` +
    "Run `pdpp-local-collector status` to confirm the new outbox size."
  );
}

function backupSqliteDb(outbox: Pick<LocalDeviceOutbox, "backupTo">, dbPath: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-${label}-${stamp}.bak`;
  outbox.backupTo(backupPath);
  return backupPath;
}

export function buildConnectorSpec(options: CliOptions): CollectorConnectorSpec {
  if (!options.connector) {
    throw new CollectorUsageError("connector required");
  }

  const bundled = getBundledConnector(options.connector);
  const customAllowed = process.env[ALLOW_CUSTOM_COMMAND_ENV] === "1";

  if (options.entrypointCommand && !customAllowed) {
    throw new CollectorCustomCommandRefusedError();
  }

  if (!(bundled || customAllowed)) {
    throw new CollectorUsageError(
      `connector '${options.connector}' is not bundled with pdpp-local-collector. ` +
        `Supported: ${BUNDLED_CONNECTOR_IDS.join(", ")}. ` +
        `Set ${ALLOW_CUSTOM_COMMAND_ENV}=1 to use --command <bin> for monorepo development.`
    );
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

export function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help" || !command) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  if (
    command !== "enroll" &&
    command !== "run" &&
    command !== "advertise" &&
    command !== "status" &&
    command !== "doctor" &&
    command !== "recover" &&
    command !== "retry-dead-letters" &&
    command !== "prune-sent" &&
    command !== "compact"
  ) {
    throw new CollectorUsageError(
      `usage: pdpp-local-collector <enroll|run|advertise|status|doctor|recover|retry-dead-letters|prune-sent|compact> --base-url <url> [options]`
    );
  }
  const options: CliOptions = {
    baseUrl: process.env.PDPP_REFERENCE_BASE_URL ?? "http://127.0.0.1:7662",
    command,
    queuePath: process.env.PDPP_COLLECTOR_QUEUE ?? DEFAULT_QUEUE_PATH,
  };
  const explicitOptions = new Set<string>();
  options.explicitOptions = explicitOptions;
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
      explicitOptions.add(arg);
      continue;
    }
    const value = rest[index + 1];
    applyOption(options, arg, value);
    explicitOptions.add(arg);
    index++;
  }

  return options;
}

function applyFlagOption(options: CliOptions, arg: string): boolean {
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

function applyOption(options: CliOptions, arg: string, value: string | undefined): void {
  if (!value) {
    throw new CollectorUsageError(`missing option value: ${arg}`);
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
    "--kind": (next) => {
      options.deadLetterKind = parseOutboxKind(next);
    },
    "--limit": (next) => {
      options.limit = parsePositiveInteger("--limit", next);
    },
    "--queue": (next) => {
      options.queuePath = next;
    },
    "--profile": (next) => {
      options.profile = next;
    },
    "--run-id": (next) => {
      options.runId = next;
    },
    "--connection-id": (next) => {
      setExplicitSourceInstanceId(options, arg, next);
    },
    "--source-instance-id": (next) => {
      setExplicitSourceInstanceId(options, arg, next);
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

function setExplicitSourceInstanceId(options: CliOptions, arg: string, value: string): void {
  const hadExplicitSource =
    options.explicitOptions?.has("--connection-id") || options.explicitOptions?.has("--source-instance-id");
  if (hadExplicitSource && options.sourceInstanceId && options.sourceInstanceId !== value) {
    throw new CollectorUsageError(
      `${arg} disagrees with the already supplied source identity '${options.sourceInstanceId}'`
    );
  }
  options.sourceInstanceId = value;
}

function parseOutboxKind(value: string): LocalDeviceOutboxKind {
  if (value === "record_batch" || value === "checkpoint" || value === "gap" || value === "blob_upload") {
    return value;
  }
  throw new CollectorUsageError(`invalid --kind: ${value}`);
}

function parsePositiveInteger(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CollectorUsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(label: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CollectorUsageError(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function scopedDefaultQueuePath(
  queuePath: string,
  defaultQueuePath: string,
  connectionId: string
): string {
  if (queuePath !== defaultQueuePath) {
    return queuePath;
  }
  const extension = extname(defaultQueuePath);
  const stem = basename(defaultQueuePath, extension);
  return join(dirname(defaultQueuePath), `${stem}.${safeQueuePathSegment(connectionId)}${extension}`);
}

function resolveOutboxPath(options: CliOptions): string {
  return options.sourceInstanceId
    ? scopedDefaultQueuePath(options.queuePath, DEFAULT_QUEUE_PATH, options.sourceInstanceId)
    : options.queuePath;
}

interface LocalOutboxInspection {
  /**
   * Whether the lane has durably carried a `coverage_diagnostics` record.
   * Null when the answer is unknowable: no connection id was supplied (the
   * scan is per-lane, so an unscoped status must not guess), or a legacy
   * pre-index outbox exceeds the bounded coverage-scan budget (the probe
   * refuses an unbounded payload scan).
   */
  coverageObserved: boolean | null;
  recordBatchCount: number;
  summary: LocalDeviceOutboxSummary;
}

function readOutboxInspection(path: string, sourceInstanceId: string | undefined): LocalOutboxInspection {
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
  } finally {
    outbox.close();
  }
}

function emptyOutboxSummary(): LocalDeviceOutboxSummary {
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

function safeQueuePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const exitCode = error instanceof CollectorUsageError ? error.exitCode : 1;
    process.exit(exitCode);
  });
}
