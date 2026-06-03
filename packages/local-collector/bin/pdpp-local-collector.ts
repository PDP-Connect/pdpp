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

import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  type LocalDeviceOutboxDeadLetterErrorSummary,
  type LocalDeviceOutboxKind,
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
  command: "enroll" | "run" | "advertise" | "status" | "doctor" | "retry-dead-letters";
  connector?: string;
  deadLetterKind?: LocalDeviceOutboxKind;
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  entrypointCommand?: string;
  limit?: number;
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
    throw new CollectorUsageError(
      "run requires --device-id <id>, --device-token <token>, and --connection-id <id>"
    );
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

type CollectorRunResult = Awaited<ReturnType<typeof runCollectorConnector>>;

export interface LocalCollectorRunOutput extends Omit<CollectorRunResult, "flushedState" | "priorState"> {
  flushedState: LocalCollectorStateSummary | null;
  priorState: LocalCollectorStateSummary | null;
}

export interface LocalCollectorStateSummary {
  stream_count: number;
  streams: Record<string, LocalCollectorCursorSummary>;
}

export interface LocalCollectorCursorSummary {
  fetched_at?: string;
  file_mtimes_count?: number;
  keys: string[];
}

export function summarizeRunResultForCli(result: CollectorRunResult): LocalCollectorRunOutput {
  return {
    ...result,
    flushedState: summarizeCollectorState(result.flushedState),
    priorState: summarizeCollectorState(result.priorState),
  };
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
        "Preview with `pdpp-local-collector retry-dead-letters`, then requeue with " +
        "`pdpp-local-collector retry-dead-letters --apply` (backs up the DB first), " +
        "then re-run the collector to drain the requeued rows."
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
        "Re-run with the current `@beta` and the default stream set (no `--streams`): " +
        "`npx -y @pdpp/local-collector@beta run …` (or `pdpp-local-collector run …` if already on the current build). " +
        "Older installs may omit `coverage_diagnostics` from bundled defaults — `npx -y` always fetches the latest published build."
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
        "every real build (a bare or `@latest` global install resolves it)."
    );
  }
  parts.push(
    "Pin a published version before capturing operator-host evidence: " +
      "`npm i -g @pdpp/local-collector@beta` (or an explicit `@0.1.0-beta.<n>`). " +
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
  "there is nothing to requeue. Recovery is to re-run the collector " +
  "(`pdpp-local-collector run …`), which re-reads prior state and clears the block.";

function retryDeadLettersMatchNote(matched: number, dryRun: boolean): string {
  if (matched === 0) {
    return RETRY_DEAD_LETTERS_NO_MATCH_NOTE;
  }
  const requeued = dryRun
    ? `${matched} dead-letter row(s) would be requeued (dry run). Re-run with --apply to requeue (backs up the DB first), `
    : `${matched} dead-letter row(s) matched and were requeued to pending. `;
  return `${requeued}then re-run the collector (\`pdpp-local-collector run …\`) to drain them — requeue moves rows to pending, it does not ingest.`;
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
  } finally {
    outbox.close();
  }
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

function backupSqliteDb(outbox: Pick<LocalDeviceOutbox, "backupTo">, dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-retry-dead-letters-${stamp}.bak`;
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
    command !== "retry-dead-letters"
  ) {
    throw new CollectorUsageError(
      `usage: pdpp-local-collector <enroll|run|advertise|status|doctor|retry-dead-letters> --base-url <url> [options]`
    );
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

function applyFlagOption(options: CliOptions, arg: string): boolean {
  if (arg === "--apply") {
    options.apply = true;
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
