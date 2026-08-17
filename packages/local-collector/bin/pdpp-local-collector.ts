#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConnectScopeRequest,
  type ConnectScopeChoice,
  ConnectScopeValidationError,
  describeConnectScopeChoice,
  normalizeSourceRoots,
  validateSinceLocally,
} from "../src/connect-scope.ts";
import { resolveCollectorQueuePath } from "../src/durable-state.ts";
import { ALLOW_CUSTOM_COMMAND_ENV, CollectorCustomCommandRefusedError, CollectorUsageError } from "../src/errors.ts";
import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/generated/collector-definitions.generated.ts";
import {
  type BundledConnectorEntry,
  type BundledConnectorRegistry,
  bundledConnectorIds,
  bundledConnectorVersions,
  COLLECTOR_PROTOCOL_VERSION,
  COLLECTOR_RUNTIME_CAPABILITIES,
  type CollectorConnectorSpec,
  collectorScopeFingerprint,
  createBundledConnectorRegistry,
  deriveLocalCollectorLifecycleState,
  type EmittedMessage,
  type EnrollmentExchangeResponse,
  enrollCollector,
  getBundledConnectorFrom,
  isMainModule,
  type LocalCollectorLifecycleState,
  LocalDeviceClient,
  LocalDeviceHttpError,
  LocalDeviceOutbox,
  type LocalDeviceOutboxCompactResult,
  type LocalDeviceOutboxDeadLetterErrorSummary,
  type LocalDeviceOutboxKind,
  type LocalDeviceOutboxPageStats,
  type LocalDeviceOutboxPruneSentInput,
  type LocalDeviceOutboxPruneSentResult,
  type LocalDeviceOutboxSummary,
  LocalDeviceRequestTimeoutError,
  readCollectionScopeFromState,
  runCollectorConnector,
} from "../src/runner.ts";

/**
 * The published local collector's connector registry.
 *
 * Composition root: the generic runtime knows no connectors; here we inject
 * the connector-owned {@link LOCAL_COLLECTOR_DEFINITIONS} to obtain the
 * runnable, id-keyed registry the CLI resolves `--connector <id>` against.
 *
 * `LOCAL_COLLECTOR_DEFINITIONS` is imported from this package's own
 * generated snapshot (`src/generated/collector-definitions.generated.ts`),
 * not from `@pdpp/polyfill-connectors` directly — this package must not
 * carry a source dependency on the content package. The snapshot is
 * regenerated from `@pdpp/polyfill-connectors`'s
 * `LOCAL_COLLECTOR_DEFINITIONS` (see that script's header for the update
 * path) and a drift test keeps it from going stale. Adding a
 * filesystem-class connector to the bundle is a change in
 * `@pdpp/polyfill-connectors/src/collector-registry.ts` followed by
 * regenerating the snapshot — this file and the runtime do not change.
 */
export const BUNDLED_CONNECTORS: BundledConnectorRegistry = createBundledConnectorRegistry(LOCAL_COLLECTOR_DEFINITIONS);

/** Stable list of connector ids the published `pdpp-local-collector` accepts. */
export const BUNDLED_CONNECTOR_IDS: readonly string[] = bundledConnectorIds(BUNDLED_CONNECTORS);

/** Version each bundled connector reports on the runtime-capabilities payload. */
export const BUNDLED_CONNECTOR_VERSIONS: Readonly<Record<string, string>> =
  bundledConnectorVersions(BUNDLED_CONNECTORS);

/**
 * Normalize an operator-typed connector id to the registry's canonical form:
 * lowercase, hyphens folded to underscores. Connector ids are always
 * `snake_case` (`claude_code`), but `--connector claude-code` or
 * `CLAUDE_CODE` is an unambiguous, natural typo — refusing it with an opaque
 * "not bundled" error is a discoverability tax, not a safety boundary.
 */
export function normalizeConnectorId(connectorId: string): string {
  return connectorId.trim().toLowerCase().replaceAll("-", "_");
}

/** Lookup helper. Returns null when the id is not bundled (after normalization). */
export function getBundledConnector(connectorId: string): BundledConnectorEntry | null {
  return getBundledConnectorFrom(BUNDLED_CONNECTORS, normalizeConnectorId(connectorId));
}

/**
 * Stream name the local source inventory emits coverage records on. Kept
 * here (not imported) because the CLI only needs the literal to ask the
 * durable outbox "has this lane ever carried a coverage diagnostic?".
 * Mirrors `COVERAGE_DIAGNOSTICS_STREAM` in the runner.
 */
const COVERAGE_DIAGNOSTICS_STREAM = "coverage_diagnostics";

const LOCAL_COLLECTOR_PACKAGE_NAME = "@pdpp/local-collector";
const LOCAL_COLLECTOR_PACKAGE_VERSION_FALLBACK = "0.0.0";
const LOCAL_COLLECTOR_PROFILE_DIR_ENV = "PDPP_LOCAL_COLLECTOR_PROFILE_DIR";
const REFERENCE_ROUTE_DOCTOR_TIMEOUT_MS = 10_000;
const RECOVER_DEFAULT_MAX_DRAIN_PASSES = 20;
const PROFILE_ENV_LINE_SEPARATOR = /\r?\n/;
const PROFILE_ENV_KEY = /^[A-Z0-9_]+$/;
const PROFILE_FILE_NAME = /^[A-Za-z0-9._-]+$/;
const PROFILE_ENV_QUOTE_ESCAPE = /\\"/g;
const PROFILE_ENV_BACKSLASH_ESCAPE = /\\\\/g;
const PROFILE_ENV_EXTENSION = /\.env$/;
/**
 * Placeholder version published to the `latest` dist-tag and carried by the
 * in-repo `package.json` by design. It is older than every real beta build, so
 * a host reporting it is either an unpinned `latest` install of the placeholder
 * or an in-repo manifest — neither is real published operator-host evidence.
 * See `docs/reference/local-collector.md`§"Deployment Posture".
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
  const startPath = typeof startUrl === "string" && !startUrl.startsWith("file:") ? startUrl : fileURLToPath(startUrl);
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
   * True when the resolved version is the `0.0.0` placeholder. Independent of
   * `kind`: a real pinned beta is good even though the in-repo manifest is
   * `0.0.0`, and an unpinned `latest` install of the placeholder is bad even if
   * it lives under `node_modules`. See `LOCAL_COLLECTOR_PLACEHOLDER_VERSION`.
   */
  is_placeholder_version: boolean;
  /**
   * How the running collector resolves: a published `node_modules` install, a
   * monorepo `dist/` (or source) override, or unknown when neither pattern is
   * conclusive. `unknown` is the conservative default — it never guesses
   * `published_package`.
   */
  kind: LocalCollectorDeploymentKind;
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
 * + version cross-check ritual in `docs/reference/local-collector.md`§"Deployment
 * Posture". Pure on `startUrl` so it is unit-testable against synthesized
 * published-like and repo-dist-like layouts.
 *
 * Spec: openspec/changes/add-local-collector-deployment-posture-surface.
 */
export function classifyLocalCollectorDeploymentPosture(
  startUrl: string | URL = import.meta.url
): LocalCollectorDeploymentPosture {
  const startPath = typeof startUrl === "string" && !startUrl.startsWith("file:") ? startUrl : fileURLToPath(startUrl);
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
  allHistory?: boolean;
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
    | "compact"
    | "setup"
    | "connect"
    | "connectors"
    | "logout";
  connector?: string;
  deadLetterKind?: LocalDeviceOutboxKind;
  deviceId?: string;
  deviceLabel?: string;
  deviceToken?: string;
  entrypointCommand?: string;
  explicitOptions?: ReadonlySet<string>;
  force?: boolean;
  json?: boolean;
  keepCount?: number;
  limit?: number;
  localOnly?: boolean;
  maxDrainPasses?: number;
  olderThanDays?: number;
  profile?: string;
  queuePath: string;
  queuePathExplicit?: boolean;
  quiet?: boolean;
  /** connect's --recent [days]: an explicit day count of 0 is meaningful ("just given, use the default"), so this is a count, not a boolean. */
  recentDays?: number;
  runId?: string;
  sample?: number;
  since?: string;
  sourceInstanceId?: string;
  sourceRoots?: string[];
  streams?: string[];
  streamsToBackfill?: string[];
}

export const HELP_TEXT = `pdpp-local-collector — PDPP local collector runner.

Ownership: the local device/host supervisor decides when filesystem-class
collectors run. The reference server owns enrollment, ingestion, state, health
diagnostics, and optional desired-freshness/request-run signals; it does not
start local processes.

Guided setup (start here):
  setup   --base-url <url>        Exchange a one-time enrollment code for device
          --code <code>             credentials, save them to a local profile file
          --connector <id>          (no manual env vars to copy), and optionally
          [--device-label <label>]  run a bounded proof pass to verify the pairing
          [--sample <n>]            works before collecting the full source.
          [--profile <name>]        Optional profile file name (default: connector id).
          [--json]                  Machine-readable output instead of human text.
  connect --base-url <url>        Same enrollment-code exchange as setup, plus a
          --code <code>             collection-horizon REQUEST: --recent (30 days
          --connector <id>          if no --recent/--all/--since given), --all
          [--recent <days>]         (explicit full history), or --since/
          [--all]                   --source-roots (custom boundary). This is a
          [--since <iso>]           REQUEST, not a guarantee: the server is the
          [--source-roots a,b]      sole authority and narrows-only against
          [--device-label <label>]  whatever it already declared — a request that
          [--sample <n>]            would WIDEN a server boundary is rejected, not
          [--profile <name>]        silently clamped. Exactly one of --recent/
          [--force]                 --all/--since+--source-roots may be given; give
          [--json]                  none to defer entirely to the server (which
                                     itself defaults to recent history, never an
                                     implicit full pass, when nothing is declared).
                                     --since is validated locally before any request
                                     is sent; --source-roots entries that look like
                                     paths are ~-expanded, resolved, and must exist
                                     on this host. If a profile already exists at the
                                     target name, connect refuses to overwrite it
                                     unless --force is given, which revokes the
                                     existing device credential server-side first,
                                     then overwrites the profile with the new one.
  connectors                      List connector ids this build accepts.
  logout  --connector <id>        Revoke this device's own credential on the
          [--profile <name>]        reference server, then delete the local profile
          [--local-only]            for a connector/profile name. Deletion only
                                     happens after the server confirms the
                                     credential is revoked (or was already
                                     revoked) — a network/server failure leaves
                                     local credentials in place so you can retry.
                                     --local-only skips the server call entirely
                                     and deletes local credentials unconditionally;
                                     use it only when the server is unreachable or
                                     decommissioned, since the device token stays
                                     live on the server until revoked some other way.

Everyday commands:
  run     --connection-id <id>    Run a bundled filesystem-class connector. Live
          [--connector <id>]        progress prints to stderr as records are found
          [--sample <n>]            (suppress with --quiet). --sample <n> stops
          [--quiet]                 after n records — a bounded proof pass instead
                                     of collecting the whole source; --device-id/
                                     --device-token/--base-url are read from the
                                     matching local profile when omitted (see
                                     setup/enroll), or from PDPP_LOCAL_DEVICE_ID/
                                     PDPP_LOCAL_DEVICE_TOKEN/PDPP_REFERENCE_BASE_URL.
          [--streams a,b,c]
          [--backfill-streams attachments]
          [--run-id <id>]
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

Advanced / low-level:
  advertise                       Print runtime capabilities and protocol version.
  enroll  --base-url <url>        Exchange a one-time enrollment code for a
          --code <code>             device id + device token; prints raw JSON.
          [--device-label <label>]  Scriptable primitive setup is built on — use
                                     setup for the guided path.
  retry-dead-letters              Requeue local dead-letter outbox rows.
          [--queue <path>]
          [--connection-id <id>]
          [--source-instance-id <id>]
          [--kind record_batch|checkpoint|gap|blob_upload]
          [--limit <n>]
          [--apply]                Dry-run by default; --apply mutates after a DB backup.
  recover                         Resolve the enrolled local profile, recover stalled outbox work,
                                   and drain queued work until clear or bounded.
          --source-instance-id <id>
          [--profile <name>]        Optional profile name under the collector profile dir.
          [--max-drain-passes <n>]  Apply mode runs up to N drain passes (default: ${RECOVER_DEFAULT_MAX_DRAIN_PASSES}).
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

Public connectors: ${BUNDLED_CONNECTOR_IDS.join(", ")}. Connector ids are case-insensitive
and hyphens normalize to underscores (claude-code == claude_code).
Connection id is the stable source identity for one device/account/home binding;
enrollment responses currently return it as source_instance_id.
Browser-bound connectors stay in the monorepo until each has its own
publishability review.

See: openspec/changes/publish-pdpp-local-collector/design.md.
`;

function installStdoutPipeGuard(): void {
  process.stdout.on("error", (error: unknown) => {
    if (isErrnoLike(error) && error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
}

function isErrnoLike(error: unknown): error is { code?: unknown } {
  return typeof error === "object" && error !== null && "code" in error;
}

function writeStdout(value: string): void {
  process.stdout.write(value);
}

/**
 * Minimum interval between record-count progress lines. `run` can stream
 * tens of thousands of RECORD messages per second on a large local archive;
 * printing one line per record would itself become the bottleneck and flood
 * the terminal. PROGRESS/phase-change messages always print immediately —
 * this throttle only applies to the running record tally.
 */
const PROGRESS_MIN_INTERVAL_MS = 500;

/**
 * Build a live, human-readable progress reporter for `run`/`setup`.
 *
 * Writes to stderr so stdout stays a pure JSON result the caller can safely
 * pipe or parse (`--json` automation contract, unchanged). This is the fix
 * for the discriminating friend-UAT failure: `run` on a large local archive
 * produced zero terminal output for minutes while the child scanned files —
 * the connector was already emitting RECORD/PROGRESS/DONE messages over
 * stdout the whole time, but nothing surfaced them to the operator. This
 * reporter is a read-only tap (see {@link EmittedMessage} / `onMessage`) —
 * it cannot change what gets collected or ingested, only what the operator
 * sees while it happens.
 */
function formatProgressLine(message: Extract<EmittedMessage, { type: "PROGRESS" }>): string {
  const countPart = typeof message.count === "number" ? ` ${message.count}` : "";
  const totalPart = typeof message.total === "number" ? `/${message.total}` : "";
  return `${message.message}${countPart}${totalPart}\n`;
}

function formatDoneLine(message: Extract<EmittedMessage, { type: "DONE" }>): string {
  if (message.status === "succeeded") {
    return `Scan complete: ${message.records_emitted} record(s) emitted.\n`;
  }
  const reason = message.error ? message.error.message : "unknown error";
  return `Scan ended with an error: ${reason}.\n`;
}

function createRunProgressReporter(write: (line: string) => void = (line) => process.stderr.write(line)): {
  onMessage: (message: EmittedMessage) => void;
} {
  let recordCount = 0;
  let lastPrintedAt = 0;
  let lastStream: string | null = null;

  const onRecord = (message: Extract<EmittedMessage, { type: "RECORD" }>): void => {
    recordCount += 1;
    if (message.stream !== lastStream) {
      lastStream = message.stream;
      write(`Scanning ${message.stream}… (${recordCount} record(s) found so far)\n`);
      lastPrintedAt = Date.now();
      return;
    }
    const now = Date.now();
    if (now - lastPrintedAt >= PROGRESS_MIN_INTERVAL_MS) {
      write(`  ${recordCount} record(s) found so far (${lastStream})…\n`);
      lastPrintedAt = now;
    }
  };

  const onMessage = (message: EmittedMessage): void => {
    if (message.type === "RECORD") {
      onRecord(message);
      return;
    }
    if (message.type === "PROGRESS") {
      write(formatProgressLine(message));
      return;
    }
    if (message.type === "STATE") {
      write(`Checkpointed progress for ${message.stream}.\n`);
      return;
    }
    if (message.type === "ASSISTANCE") {
      write(`Needs your attention: ${message.message}\n`);
      return;
    }
    if (message.type === "DONE") {
      write(formatDoneLine(message));
    }
  };

  return { onMessage };
}

function writeJson(value: unknown): void {
  writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** Dispatch for the credential-lifecycle commands: enroll, setup, connectors, logout. */
async function runOnboardingCommand(options: CliOptions): Promise<void> {
  if (options.command === "enroll") {
    if (!options.code) {
      throw new CollectorUsageError("enroll requires --code <one-time-code>");
    }
    const response = await enrollCollector({
      baseUrl: options.baseUrl,
      code: options.code,
      ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
    });
    writeJson(response);
    return;
  }

  if (options.command === "setup") {
    await runSetup(options);
    return;
  }

  if (options.command === "connect") {
    await runConnect(options);
    return;
  }

  if (options.command === "connectors") {
    writeJson({ connectors: BUNDLED_CONNECTOR_IDS, object: "local_collector_connector_list" });
    return;
  }

  // options.command === "logout"
  const result = await runLogout(options);
  writeJson(result);
  if (!result.removed) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  installStdoutPipeGuard();
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "advertise") {
    writeJson({
      runtime: COLLECTOR_RUNTIME_CAPABILITIES.id,
      bindings: [...COLLECTOR_RUNTIME_CAPABILITIES.bindings],
      collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
      bundled_connectors: BUNDLED_CONNECTOR_IDS,
    });
    return;
  }

  if (options.command === "status" || options.command === "doctor") {
    const inspectOptions = resolveInspectionOptions(options);
    const status = inspectLocalOutboxStatus(inspectOptions);
    if (options.command === "doctor") {
      const errorSummary = readLocalOutboxDeadLetterErrorSummary(inspectOptions);
      const referenceRoute = await inspectLocalReferenceRoute(inspectOptions);
      writeJson(buildLocalOutboxDoctor(status, errorSummary, referenceRoute));
      return;
    }
    writeJson(status);
    return;
  }

  if (options.command === "retry-dead-letters") {
    const result = retryLocalOutboxDeadLetters(resolveInspectionOptions(options));
    writeJson(result);
    return;
  }

  if (options.command === "recover") {
    const result = await recoverLocalCollector(options);
    writeJson(result);
    return;
  }

  if (options.command === "prune-sent") {
    const result = pruneSentOutboxRows(resolveInspectionOptions(options));
    writeJson(result);
    return;
  }

  if (options.command === "compact") {
    const result = compactOutbox(resolveInspectionOptions(options));
    writeJson(result);
    // A refused apply is an operator error (unsent work present); exit non-zero
    // so a supervising script does not mistake the refusal for a successful
    // reclaim. Dry-run and successful apply exit 0.
    if (result.refused) {
      process.exitCode = 1;
    }
    return;
  }

  if (
    options.command === "enroll" ||
    options.command === "setup" ||
    options.command === "connect" ||
    options.command === "connectors" ||
    options.command === "logout"
  ) {
    await runOnboardingCommand(options);
    return;
  }

  // `run` fills gaps from a matching local collector profile when one
  // exists (explicit flags/env vars always win — see applyProfileEnv), so a
  // profile `setup` wrote covers device-id/device-token/connector without
  // manual env vars. UNLIKE status/doctor/recover's resolveInspectionOptions,
  // this is best-effort and never refuses when no profile matches: today's
  // automation (device-id/token/connector supplied entirely via flags or
  // PDPP_LOCAL_DEVICE_ID/PDPP_LOCAL_DEVICE_TOKEN env vars, no profile file on
  // disk) must keep working exactly as before.
  const resolvedRunOptions = resolveRunProfileOptions(options);

  if (options.command === "run" && resolvedRunOptions.sample) {
    const sampleResult = await runCollectorSample(resolvedRunOptions);
    writeJson(sampleResult);
    return;
  }

  const result = await runCollectorOnce(resolvedRunOptions);
  writeJson(summarizeRunResultForCli(result));
}

type CollectorRunResult = Awaited<ReturnType<typeof runCollectorConnector>>;

/** Sentinel so the sample-abort catch in {@link runCollectorSample} only swallows aborts it triggered itself. */
class SampleLimitReachedAbort extends Error {}

/** Sentinel so {@link runCollectorOnce}'s interrupt-abort catch only swallows aborts it triggered itself. */
export class CollectorInterruptedAbort extends Error {}

/**
 * Install real SIGINT/SIGTERM handling for the duration of a plain `run`,
 * reusing the identical abort/flush mechanism `--sample <n>` already relies
 * on (`abortSignal` into `runCollectorConnector` → `streamConnectorIntoOutbox`
 * flushes already-parsed records to the durable outbox before the abort
 * propagates — see `collector-runner.ts`). Before this, Ctrl+C during plain
 * `run` had no handler at all: the terminal's process-group SIGINT killed
 * the CLI and its connector child with no flush and no recorded gap, purely
 * by accident of process-group membership, not by design.
 *
 * The handler calls `controller.abort(...)` and returns — it does NOT call
 * `process.exit()` itself. That lets the normal `runCollectorConnector`
 * await/catch flow in the caller run to completion (flush happens inside
 * `streamConnectorIntoOutbox`, then the CLI's usual `writeJson`/exit-code
 * path takes over), exactly like `runCollectorSample`'s internal abort.
 * Listeners are removed in `finally` so a `recover` drain loop that calls
 * `runCollectorOnce` many times does not accumulate handlers.
 */
export function installInterruptAbort(controller: AbortController): () => void {
  const onSignal = (): void => {
    controller.abort(new CollectorInterruptedAbort());
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

export async function runCollectorOnce(options: CliOptions): Promise<CollectorRunResult> {
  if (!(options.deviceId && options.deviceToken && options.sourceInstanceId)) {
    throw new CollectorUsageError(
      "run requires --device-id <id>, --device-token <token>, and --connection-id/--source-instance-id <id>"
    );
  }
  if (!options.connector) {
    throw new CollectorUsageError("run requires --connector <connector-id>");
  }

  const spec = buildConnectorSpec(options);
  const reporter = options.quiet ? null : createRunProgressReporter();
  const controller = new AbortController();
  const removeInterruptHandlers = installInterruptAbort(controller);
  try {
    return await runCollectorConnector({
      abortSignal: controller.signal,
      baseUrl: options.baseUrl,
      connector: spec,
      deviceId: options.deviceId,
      deviceToken: options.deviceToken,
      ...(reporter ? { onMessage: reporter.onMessage } : {}),
      queuePath: resolveOutboxPath(options),
      ...(options.runId ? { runId: options.runId } : {}),
      sourceInstanceId: options.sourceInstanceId,
    });
  } finally {
    removeInterruptHandlers();
  }
}

export interface SampleRunOutput {
  connector: string;
  note: string;
  object: "local_collector_sample";
  records_seen: number;
  sample_limit: number;
  status: LocalOutboxStatusOutput;
}

/**
 * Bounded proof/verification mode: run the connector but stop after
 * `options.sample` records have been seen, instead of scanning and queuing
 * the entire local source. Lets an operator confirm a connector works
 * end-to-end (reads real records, reaches the reference server) without
 * ingesting a huge archive on the first try — the exact gap in the
 * friend-UAT discriminator, where `run` scanned a large archive for minutes
 * with no way to stop short of a full pass.
 *
 * Implementation: reuses the SAME abort path `run`'s Ctrl+C interrupt
 * safety already relies on (`CollectorRunConfig.abortSignal` — see
 * `collector-runner.ts`'s `streamConnectorIntoOutbox`, which flushes any
 * already-parsed records to the durable outbox before the abort
 * propagates). Records collected before the sample cap are genuinely
 * durable, not discarded; they are also never marked as a complete,
 * coverage-checkpointed run — the connector's `DONE`/checkpoint state is
 * intentionally never reached, so a sample can never be mistaken for a
 * full collection by `status`/`doctor`.
 */
export async function runCollectorSample(options: CliOptions): Promise<SampleRunOutput> {
  if (!(options.deviceId && options.deviceToken && options.sourceInstanceId)) {
    throw new CollectorUsageError(
      "run requires --device-id <id>, --device-token <token>, and --connection-id/--source-instance-id <id>"
    );
  }
  if (!options.connector) {
    throw new CollectorUsageError("run requires --connector <connector-id>");
  }
  const sampleLimit = options.sample;
  if (!sampleLimit || sampleLimit <= 0) {
    throw new CollectorUsageError("--sample requires a positive integer");
  }

  const spec = buildConnectorSpec(options);
  const reporter = options.quiet ? null : createRunProgressReporter();
  const controller = new AbortController();
  let recordsSeen = 0;
  const onMessage = (message: EmittedMessage): void => {
    reporter?.onMessage(message);
    if (message.type === "RECORD") {
      recordsSeen += 1;
      if (recordsSeen >= sampleLimit) {
        controller.abort(new SampleLimitReachedAbort());
      }
    }
  };

  try {
    await runCollectorConnector({
      abortSignal: controller.signal,
      baseUrl: options.baseUrl,
      connector: spec,
      deviceId: options.deviceId,
      deviceToken: options.deviceToken,
      onMessage,
      queuePath: resolveOutboxPath(options),
      ...(options.runId ? { runId: options.runId } : {}),
      sourceInstanceId: options.sourceInstanceId,
    });
    // The connector finished (or drained a small backlog) before the sample
    // cap was ever reached — an honest full pass, just a small source.
  } catch (error) {
    if (!(controller.signal.aborted && controller.signal.reason instanceof SampleLimitReachedAbort)) {
      throw error;
    }
  }

  const status = inspectLocalOutboxStatus(resolveInspectionOptions(options));
  return {
    connector: spec.connector_id,
    note:
      recordsSeen >= sampleLimit
        ? `Sample stopped after ${recordsSeen} record(s) (limit ${sampleLimit}). These records are durably queued but this is NOT a complete collection — the connector was stopped before finishing its scan, so no coverage checkpoint was recorded. Run \`run\` (without --sample) to collect the full source, or \`recover --apply\` to drain what was already queued.`
        : `The connector finished on its own after ${recordsSeen} record(s), under the ${sampleLimit} sample limit — this was a complete pass, not a truncated one.`,
    object: "local_collector_sample",
    records_seen: recordsSeen,
    sample_limit: sampleLimit,
    status,
  };
}

export interface SetupOutput {
  connector: string;
  device_id: string;
  note: string;
  object: "local_collector_setup";
  profile_path: string;
  sample: SampleRunOutput | null;
  source_instance_id: string;
}

export interface RunSetupDeps {
  enroll?: typeof enrollCollector;
  runSample?: (options: CliOptions) => Promise<SampleRunOutput>;
}

/**
 * The guided, one-command onboarding path: exchange a one-time enrollment
 * code for device credentials, persist them as a profile `.env` file
 * (`0600`, dir `0700`) so `run`/`recover`/`status`/`doctor` resolve them by
 * `--connection-id` without any manual env-var copying, then — unless
 * `--sample` is omitted — run a bounded proof pass so the operator sees real
 * evidence the pairing works before deciding to collect the full source.
 *
 * This directly targets the friend-UAT discriminator: enrollment used to
 * print a JSON blob the operator had to hand-copy into three environment
 * variables before `run` would do anything, and `run` itself gave zero
 * feedback while it silently scanned a large archive. `setup` collapses that
 * into one command with a durable, secure credential home and immediate,
 * bounded, human-legible proof of collection.
 *
 * `enroll` and manual env vars are NOT removed — they remain the scriptable
 * primitive `setup` is built on, and existing automation that already
 * exports `PDPP_LOCAL_DEVICE_ID`/`PDPP_LOCAL_DEVICE_TOKEN`/
 * `PDPP_CONNECTION_ID` keeps working unchanged (profile-file resolution only
 * activates when a matching profile exists; explicit flags/env vars still
 * win — see {@link resolveInspectionOptions}/{@link applyProfileEnv}).
 */
export async function runSetup(options: CliOptions, deps: RunSetupDeps = {}): Promise<SetupOutput> {
  const enroll = deps.enroll ?? enrollCollector;
  const runSample = deps.runSample ?? runCollectorSample;

  if (!options.code) {
    throw new CollectorUsageError("setup requires --code <one-time-code>");
  }
  if (!options.connector) {
    throw new CollectorUsageError(
      `setup requires --connector <connector-id>. Supported: ${BUNDLED_CONNECTOR_IDS.join(", ")}.`
    );
  }
  const normalizedConnector = normalizeConnectorId(options.connector);
  if (!getBundledConnector(normalizedConnector)) {
    throw new CollectorUsageError(
      `connector '${options.connector}' is not bundled with pdpp-local-collector. ` +
        `Supported: ${BUNDLED_CONNECTOR_IDS.join(", ")}.`
    );
  }

  const enrollment = await enroll({
    baseUrl: options.baseUrl,
    code: options.code,
    ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
  });

  const profileName = options.profile ?? normalizedConnector;
  const profilePath = writeLocalCollectorProfile({
    baseUrl: options.baseUrl,
    connectorId: normalizedConnector,
    deviceId: enrollment.device_id,
    deviceToken: enrollment.device_token,
    name: profileName,
    sourceInstanceId: enrollment.source_instance_id,
  });

  let sample: SampleRunOutput | null = null;
  if (options.sample) {
    const sampleOptions: CliOptions = {
      ...options,
      connector: normalizedConnector,
      deviceId: enrollment.device_id,
      deviceToken: enrollment.device_token,
      sourceInstanceId: enrollment.source_instance_id,
    };
    sample = await runSample(sampleOptions);
  }

  const output: SetupOutput = {
    connector: normalizedConnector,
    device_id: enrollment.device_id,
    note: sample
      ? `Enrolled and wrote credentials to ${profilePath} (permissions restricted to your user). Ran a bounded proof pass: ${sample.note} Run \`pdpp-local-collector run --connection-id ${enrollment.source_instance_id}\` to collect the full source.`
      : `Enrolled and wrote credentials to ${profilePath} (permissions restricted to your user). Run \`pdpp-local-collector run --connection-id ${enrollment.source_instance_id}\` to collect, or add --sample <n> next time to verify first with a bounded proof pass.`,
    object: "local_collector_setup",
    profile_path: profilePath,
    sample,
    source_instance_id: enrollment.source_instance_id,
  };

  if (options.json) {
    writeJson(output);
    return output;
  }
  writeStdout(`✓ Enrolled ${normalizedConnector} (device ${enrollment.device_id}).\n`);
  writeStdout(`✓ Credentials saved to ${profilePath} (readable only by you).\n`);
  if (sample) {
    writeStdout(`✓ ${sample.note}\n`);
  }
  writeStdout(
    `\nNext: pdpp-local-collector run --connection-id ${enrollment.source_instance_id}\n` +
      "(the profile above is picked up automatically — no env vars to set by hand)\n"
  );
  return output;
}

/**
 * Read `connect`'s scope flags off parsed options into one
 * {@link ConnectScopeChoice}, refusing to guess when more than one is given.
 * `--recent`/`--all`/`--since`+`--source-roots` are mutually exclusive —
 * combining them would leave it ambiguous which boundary the operator
 * actually meant, and silently picking one would be exactly the kind of
 * fabricated-intent bug this whole feature exists to prevent.
 *
 * `--since`/`--source-roots` are also validated LOCALLY here, before any
 * server request is built: `--since` must parse as a date/time, and each
 * `--source-roots` entry that looks like a filesystem path (has a `/`, is
 * absolute, or starts with `~`) is `~`-expanded, resolved to an absolute
 * path, and checked to exist on this host. The server has no filesystem to
 * check a root against — it only validates request shape — so failing here
 * turns a silently-ignored typo into an immediate, actionable error instead
 * of a round trip that ends in a scoped connection that collects nothing.
 */
export function resolveConnectScopeChoice(options: CliOptions): ConnectScopeChoice {
  const requested = [
    options.recentDays === undefined ? null : "recent",
    options.allHistory ? "all" : null,
    options.since || options.sourceRoots ? "custom" : null,
  ].filter((v): v is string => v !== null);
  if (requested.length > 1) {
    throw new CollectorUsageError(
      `connect accepts only one of --recent, --all, --since/--source-roots, got: ${requested.join(", ")}`
    );
  }
  if (options.recentDays !== undefined) {
    return { kind: "recent", recentDays: options.recentDays };
  }
  if (options.allHistory) {
    return { kind: "all" };
  }
  if (options.since || options.sourceRoots) {
    try {
      return {
        kind: "custom",
        ...(options.since ? { since: validateSinceLocally(options.since) } : {}),
        ...(options.sourceRoots ? { sourceRoots: normalizeSourceRoots(options.sourceRoots) } : {}),
      };
    } catch (error) {
      if (error instanceof ConnectScopeValidationError) {
        throw new CollectorUsageError(error.message, { cause: error });
      }
      throw error;
    }
  }
  return { kind: "unspecified" };
}

export interface ConnectOutput {
  connector: string;
  device_id: string;
  note: string;
  object: "local_collector_connect";
  profile_path: string;
  requested_scope: string;
  sample: SampleRunOutput | null;
  source_instance_id: string;
}

export interface RunConnectDeps {
  enroll?: typeof enrollCollector;
  now?: () => string;
  revokeExistingProfile?: (input: { baseUrl: string; deviceId: string; deviceToken: string }) => Promise<unknown>;
  runSample?: (options: CliOptions) => Promise<SampleRunOutput>;
}

/**
 * `connect`: the same enrollment-code exchange `setup` performs, extended
 * with an optional narrowing-only scope request
 * (`--recent [days]`/`--all`/`--since`+`--source-roots`).
 *
 * This command holds no new credential and mints nothing: it consumes the
 * SAME one-time enrollment code an owner already minted out of band (a
 * dashboard, an owner-agent script — exactly how `setup`/`enroll` obtain one
 * today). The scope flags below are a REQUEST forwarded verbatim to the
 * enroll route; the server is the sole authority on the EFFECTIVE boundary
 * (narrows a server-declared one, or applies the honest recent-history
 * default when neither side declares anything — see
 * `reference-implementation/server/enrollment-scope-narrowing.ts`). A
 * request that would WIDEN a server-declared boundary is rejected by the
 * server with a typed 400, and this command surfaces that rejection as a
 * `CollectorUsageError` rather than silently falling back to any local
 * notion of "complete."
 *
 * Exactly one of `--recent`, `--all`, `--since`/`--source-roots` may be
 * given; passing none at all sends no `collection_scope` field, deferring
 * entirely to the server.
 *
 * A repeated `connect` at the same profile name (default: the connector id)
 * refuses by default when a profile already exists there: overwriting it
 * silently would orphan the OLD device credential live and un-revoked on
 * the server while the local record of it — the only thing that could have
 * revoked it — is gone. `--force` makes the intent explicit and makes it
 * safe: the existing credential is revoked server-side FIRST (same
 * self-revoke `logout` uses), and only after that succeeds does `connect`
 * proceed to consume the new code and overwrite the profile. If the revoke
 * fails, `connect` aborts before enrolling — the one-time code is not
 * consumed and nothing is overwritten, so a failed `--force` leaves the
 * operator able to retry.
 */
type RevokeExistingProfileFn = (input: { baseUrl: string; deviceId: string; deviceToken: string }) => Promise<unknown>;

/**
 * `connect`'s overwrite guard: refuse to clobber an existing profile at
 * `profileName` unless `--force` is given, and when it is, revoke that
 * profile's device credential server-side BEFORE returning — so the caller
 * only proceeds to consume the new one-time code once the old credential is
 * confirmed gone. Extracted out of {@link runConnect} to keep that
 * function's branching within the repo's cognitive-complexity budget; the
 * behavior (and its tests) are unchanged by the extraction.
 */
async function guardConnectProfileOverwrite(
  profileName: string,
  force: boolean | undefined,
  revokeExistingProfile: RevokeExistingProfileFn
): Promise<void> {
  const existingProfilePath = existingCollectorProfilePath(profileName);
  if (!existingProfilePath) {
    return;
  }
  if (!force) {
    throw new CollectorUsageError(
      `connect found an existing profile at ${existingProfilePath}. Connecting again would overwrite it and ` +
        "leave its device credential live and un-revoked on the server, with no local record left to revoke " +
        "it later. Pass --force to revoke the existing credential first, then connect and overwrite the profile."
    );
  }
  const existingEnv = parseCollectorProfileEnv(readFileSync(existingProfilePath, "utf8"));
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record<string, string> does not guarantee a key exists at runtime; matches applyProfileEnv's established idiom.
  const existingBaseUrl = existingEnv.PDPP_REFERENCE_BASE_URL?.trim();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record<string, string> does not guarantee a key exists at runtime; matches applyProfileEnv's established idiom.
  const existingDeviceId = existingEnv.PDPP_LOCAL_DEVICE_ID?.trim();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record<string, string> does not guarantee a key exists at runtime; matches applyProfileEnv's established idiom.
  const existingDeviceToken = existingEnv.PDPP_LOCAL_DEVICE_TOKEN?.trim();
  if (!(existingBaseUrl && existingDeviceId && existingDeviceToken)) {
    return;
  }
  try {
    await revokeExistingProfile({
      baseUrl: existingBaseUrl,
      deviceId: existingDeviceId,
      deviceToken: existingDeviceToken,
    });
  } catch (error) {
    const alreadyGone = error instanceof LocalDeviceHttpError && (error.status === 401 || error.status === 403);
    if (alreadyGone) {
      // Already revoked/invalid server-side: nothing further to revoke, safe to proceed.
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CollectorUsageError(
      `connect --force could not confirm the existing credential at ${existingProfilePath} was revoked ` +
        `server-side (${detail}). Nothing was overwritten and the one-time code was not consumed — retry ` +
        "once the server is reachable.",
      { cause: error }
    );
  }
}

export async function runConnect(options: CliOptions, deps: RunConnectDeps = {}): Promise<ConnectOutput> {
  const enroll = deps.enroll ?? enrollCollector;
  const runSample = deps.runSample ?? runCollectorSample;
  const now = deps.now ?? (() => new Date().toISOString());
  const revokeExistingProfile: RevokeExistingProfileFn =
    deps.revokeExistingProfile ??
    ((input) =>
      new LocalDeviceClient({
        baseUrl: input.baseUrl,
        deviceId: input.deviceId,
        deviceToken: input.deviceToken,
      }).selfRevoke());

  if (!options.code) {
    throw new CollectorUsageError("connect requires --code <one-time-code>");
  }
  if (!options.connector) {
    throw new CollectorUsageError(
      `connect requires --connector <connector-id>. Supported: ${BUNDLED_CONNECTOR_IDS.join(", ")}.`
    );
  }
  const normalizedConnector = normalizeConnectorId(options.connector);
  if (!getBundledConnector(normalizedConnector)) {
    throw new CollectorUsageError(
      `connector '${options.connector}' is not bundled with pdpp-local-collector. ` +
        `Supported: ${BUNDLED_CONNECTOR_IDS.join(", ")}.`
    );
  }

  const profileName = options.profile ?? normalizedConnector;
  await guardConnectProfileOverwrite(profileName, options.force, revokeExistingProfile);

  const scopeChoice = resolveConnectScopeChoice(options);
  const nowIso = now();
  const collectionScope = buildConnectScopeRequest(scopeChoice, nowIso);
  const requestedScopeDescription = describeConnectScopeChoice(scopeChoice, nowIso);

  let enrollment: EnrollmentExchangeResponse;
  try {
    enrollment = await enroll({
      baseUrl: options.baseUrl,
      ...(collectionScope === undefined ? {} : { collectionScope }),
      code: options.code,
      ...(options.deviceLabel ? { deviceLabel: options.deviceLabel } : {}),
    });
  } catch (error) {
    if (error instanceof LocalDeviceHttpError && error.status === 400) {
      throw new CollectorUsageError(
        `connect could not enroll with the requested scope (${requestedScopeDescription}): ` +
          `${error.envelopeMessage ?? error.message}`,
        { cause: error }
      );
    }
    throw error;
  }

  const profilePath = writeLocalCollectorProfile({
    baseUrl: options.baseUrl,
    connectorId: normalizedConnector,
    deviceId: enrollment.device_id,
    deviceToken: enrollment.device_token,
    name: profileName,
    sourceInstanceId: enrollment.source_instance_id,
  });

  let sample: SampleRunOutput | null = null;
  if (options.sample) {
    const sampleOptions: CliOptions = {
      ...options,
      connector: normalizedConnector,
      deviceId: enrollment.device_id,
      deviceToken: enrollment.device_token,
      sourceInstanceId: enrollment.source_instance_id,
    };
    sample = await runSample(sampleOptions);
  }

  const nextCommand = `pdpp-local-collector run --connection-id ${enrollment.source_instance_id}`;
  const output: ConnectOutput = {
    connector: normalizedConnector,
    device_id: enrollment.device_id,
    note: sample
      ? `Enrolled with requested scope: ${requestedScopeDescription}. Credentials saved to ${profilePath} ` +
        `(permissions restricted to your user). Ran a bounded proof pass: ${sample.note} Run \`${nextCommand}\` ` +
        "to collect the rest of the declared boundary."
      : `Enrolled with requested scope: ${requestedScopeDescription}. Credentials saved to ${profilePath} ` +
        `(permissions restricted to your user). Run \`${nextCommand}\` to collect, or add --sample <n> next time ` +
        "to verify first with a bounded proof pass.",
    object: "local_collector_connect",
    profile_path: profilePath,
    requested_scope: requestedScopeDescription,
    sample,
    source_instance_id: enrollment.source_instance_id,
  };

  if (options.json) {
    writeJson(output);
    return output;
  }
  writeStdout(`✓ Requested scope: ${requestedScopeDescription}\n`);
  writeStdout(`✓ Enrolled ${normalizedConnector} (device ${enrollment.device_id}).\n`);
  writeStdout(`✓ Credentials saved to ${profilePath} (readable only by you).\n`);
  if (sample) {
    writeStdout(`✓ ${sample.note}\n`);
  }
  writeStdout(`\nNext: ${nextCommand}\n(the profile above is picked up automatically — no env vars to set by hand)\n`);
  return output;
}

export interface LogoutOutput {
  object: "local_collector_logout";
  path: string;
  removed: boolean;
  revoke_note: string;
  revoked: boolean;
}

export interface RunLogoutDeps {
  /** Injectable seam for tests; defaults to a real {@link LocalDeviceClient}. */
  selfRevoke?: (input: { baseUrl: string; deviceId: string; deviceToken: string }) => Promise<unknown>;
}

/**
 * Revoke this device's own server-side credential, then delete the local
 * profile `.env` file for a connector/profile name (the `logout`/
 * credential-removal half of the `setup` lifecycle). Deletion only happens
 * AFTER the server confirms the credential is gone — either freshly revoked
 * or already revoked from a prior attempt — so a `logout` that fails
 * halfway never leaves an operator believing the server-side lane is closed
 * when it is not. On an ambiguous failure (network error, timeout, or an
 * unexpected server response) this fails closed: local credentials are left
 * in place so the operator can retry, rather than silently deleting the
 * only record of a token that may still be live server-side.
 *
 * `--local-only` skips the server call entirely (see {@link CliOptions.localOnly})
 * for the unreachable/decommissioned-server escape hatch — deliberately not
 * named "logout" in the flag itself, since it does not close the
 * server-side lane and an operator must know that.
 */
export async function runLogout(options: CliOptions, deps: RunLogoutDeps = {}): Promise<LogoutOutput> {
  const name = options.profile ?? (options.connector ? normalizeConnectorId(options.connector) : null);
  if (!name) {
    throw new CollectorUsageError("logout requires --profile <name> or --connector <connector-id>");
  }

  const profileDir = process.env[LOCAL_COLLECTOR_PROFILE_DIR_ENV]?.trim() || defaultCollectorProfileDir();
  const fileName = safeProfileFileName(name);
  const path = join(profileDir, fileName);

  if (!existsSync(path)) {
    return {
      object: "local_collector_logout",
      path,
      removed: false,
      revoke_note: "No local profile found; nothing to revoke or delete.",
      revoked: false,
    };
  }

  if (options.localOnly) {
    const result = removeLocalCollectorProfile({ name });
    return {
      object: "local_collector_logout",
      ...result,
      revoke_note:
        "--local-only skipped the server-side revoke. The device token may still be valid against the " +
        "reference deployment until revoked some other way (server admin, or a future logout once reachable).",
      revoked: false,
    };
  }

  let env: Record<string, string>;
  try {
    env = parseCollectorProfileEnv(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CollectorUsageError(
      `logout could not read the local profile at ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Refusing to delete an unreadable profile; pass --local-only to force local deletion without a server-side revoke.",
      { cause: error }
    );
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record<string, string> does not guarantee a key exists at runtime; matches the established idiom in applyProfileEnv above.
  const baseUrl = env.PDPP_REFERENCE_BASE_URL?.trim();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record<string, string> does not guarantee a key exists at runtime; matches the established idiom in applyProfileEnv above.
  const deviceId = env.PDPP_LOCAL_DEVICE_ID?.trim();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record<string, string> does not guarantee a key exists at runtime; matches the established idiom in applyProfileEnv above.
  const deviceToken = env.PDPP_LOCAL_DEVICE_TOKEN?.trim();
  if (!(baseUrl && deviceId && deviceToken)) {
    throw new CollectorUsageError(
      `logout found a local profile at ${path} that is missing device credentials needed to revoke it server-side. ` +
        "Pass --local-only to delete it locally without a server-side revoke."
    );
  }

  const selfRevoke =
    deps.selfRevoke ??
    ((input: { baseUrl: string; deviceId: string; deviceToken: string }) =>
      new LocalDeviceClient({
        baseUrl: input.baseUrl,
        deviceId: input.deviceId,
        deviceToken: input.deviceToken,
      }).selfRevoke());

  try {
    await selfRevoke({ baseUrl, deviceId, deviceToken });
  } catch (error) {
    if (error instanceof LocalDeviceHttpError && (error.status === 401 || error.status === 403)) {
      // Unambiguous: this credential is already invalid/revoked server-side
      // (or was never valid for this device). There is nothing further a
      // retry could revoke, so proceeding to delete the local copy is safe
      // and keeps logout idempotent across repeated calls.
      const result = removeLocalCollectorProfile({ name });
      return {
        object: "local_collector_logout",
        ...result,
        revoke_note: "Device credential was already revoked (or invalid) server-side; deleted local credentials.",
        revoked: true,
      };
    }
    // Ambiguous failure — network error, timeout, or an unexpected server
    // response. Fail closed: keep local credentials so the operator can
    // retry once the server is reachable, instead of deleting the only
    // local record of a token that may still be live.
    const detail = error instanceof Error ? error.message : String(error);
    throw new CollectorUsageError(
      `logout could not confirm the device credential was revoked server-side (${detail}). Local credentials at ` +
        `${path} were left in place — retry once the server is reachable, or pass --local-only to delete them ` +
        "without a confirmed server-side revoke (the token then remains live until revoked some other way).",
      { cause: error }
    );
  }

  const result = removeLocalCollectorProfile({ name });
  return {
    object: "local_collector_logout",
    ...result,
    revoke_note: "Device credential revoked server-side; deleted local credentials.",
    revoked: true,
  };
}

export interface LocalCollectorRunOutput extends Omit<CollectorRunResult, "flushedState" | "priorState"> {
  /**
   * One honest, operator-facing line stating whether THIS run committed
   * terminal coverage evidence — i.e. whether the connector exhaustively
   * enumerated the declared boundary and the server now holds proof of it —
   * or whether the run was partial (interrupted, sample-limited, or stopped
   * by the per-run scan budget) and therefore recorded no completion claim.
   * Drawn from the exact same gate `collector-runner.ts` uses to decide
   * whether to call `reportTerminalCollection`
   * (`done.status === "succeeded" && !scanBudgetExceeded &&
   * completeness !== null`), so this note can never say "complete" when the
   * server was never told so. Identical logic for every connector — no
   * connector-id branch decides this sentence.
   */
  coverage_note: string;
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
    coverage_note: runCoverageNote(result),
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
  const claimableReady = Math.max(0, summary.ready - summary.retrying);
  if (claimableReady > 0) {
    parts.push(`${claimableReady} ready (drains on the next scheduled run)`);
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

/**
 * One honest line on whether this run's completion is provable, not just
 * "the process exited zero". Mirrors `collector-runner.ts`'s own
 * `reportTerminalCollection` gate exactly, so this text and the server's
 * committed evidence can never disagree: a `--sample`/interrupted/
 * budget-stopped pass never claims exhaustive coverage of the declared
 * boundary, regardless of how many records it happened to collect.
 */
function runCoverageNote(result: CollectorRunResult): string {
  if (result.scanBudgetExceeded) {
    return (
      "Coverage NOT committed: the connector was stopped by the per-run scan budget before it finished " +
      "enumerating the declared boundary. Re-run to continue; only a run that finishes without hitting the " +
      "budget can commit a completion claim."
    );
  }
  if (result.done?.status !== "succeeded") {
    return (
      "Coverage NOT committed: this run did not finish (interrupted or the connector exited without " +
      "reporting success). Records already collected before the stop were still delivered, but no completion " +
      "claim was recorded for the declared boundary — re-run to finish the enumeration."
    );
  }
  if (!result.completeness) {
    return (
      "Coverage NOT committed: the connector finished but reported no coverage diagnostics for this pass, " +
      "so no completion claim was recorded."
    );
  }
  return result.completeness.fullyAccounted
    ? "Coverage committed: the connector exhaustively enumerated the declared boundary and every requested " +
        "stream is fully accounted for."
    : `Coverage committed, but ${result.completeness.unaccountedStores.length} store(s) are unaccounted for ` +
        `(${result.completeness.unaccountedStores.join(", ")}) — see \`doctor\` for detail.`;
}

function pendingOpenWork(summary: LocalDeviceOutboxSummary): number {
  return summary.ready + summary.leased + summary.deadLetter;
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
  /**
   * The owner-declared collection boundary in force for this lane, as the
   * server last delivered it, so an operator can see WHAT a "complete" run on
   * this connection is complete *within*.
   *
   * `active` is the boundary's fingerprint (`unscoped` for a full pass — an
   * absence would be indistinguishable from "we did not look"). `unknown: true`
   * means the lane has no local record of a delivered scope yet, which is the
   * honest answer before the first run rather than a claimed full corpus.
   */
  scope: {
    active: string;
    unknown: boolean;
  };
  source: {
    connection_id: string | null;
    source_instance_id: string | null;
  };
}

export interface LocalCollectorReferenceRouteCheck {
  base_url: string;
  check: "device_source_state";
  error_class?: string;
  http_status?: number;
  missing?: Array<"device_id" | "device_token" | "source_instance_id">;
  /**
   * The owner-declared boundary in force for this connection, read from the
   * same state payload this probe already fetches. `unscoped` is a real value
   * (a full pass); the field is absent only when the probe could not reach the
   * server, so a failed check never implies an unbounded collection.
   */
  scope?: string;
  status: "ok" | "fail" | "unknown";
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
    reference_route?: "ok" | "fail" | "unknown";
  };
  /**
   * Top redacted dead-letter error classes, present only when there are
   * dead-letter rows. This is the "why did these dead-letter?" answer: the
   * `last_error` text already stored on each row, collapsed into stable
   * classes with counts (paths/tokens/ids scrubbed). Omitted on a clean run.
   */
  dead_letter_error_summary?: LocalDeviceOutboxDeadLetterErrorSummary;
  reference_route?: LocalCollectorReferenceRouteCheck;
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
  const { coverageObserved, recordBatchCount, summary } = inspection;
  const lifecycleState = deriveLocalCollectorLifecycleState({
    coverageObserved,
    recordBatchCount,
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
      configured: true,
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
    // `status` reads the durable outbox alone and never calls the server (see
    // `doctor` for the reachability probe), so it cannot observe the declared
    // boundary. Saying so is the honest answer: the alternative — defaulting the
    // display to `unscoped` — would assert a full-corpus pass that nothing here
    // measured. `doctor` fills this in from the live state read.
    scope: { active: "unknown", unknown: true },
    source: {
      connection_id: options.sourceInstanceId ?? null,
      source_instance_id: options.sourceInstanceId ?? null,
    },
  };
}

export interface InspectLocalReferenceRouteDeps {
  client?: Pick<LocalDeviceClient, "getSourceInstanceState">;
}

export async function inspectLocalReferenceRoute(
  options: CliOptions,
  deps: InspectLocalReferenceRouteDeps = {}
): Promise<LocalCollectorReferenceRouteCheck> {
  const { deviceId, deviceToken, sourceInstanceId } = options;
  const missing: LocalCollectorReferenceRouteCheck["missing"] = [];
  if (!deviceId) {
    missing.push("device_id");
  }
  if (!deviceToken) {
    missing.push("device_token");
  }
  if (!sourceInstanceId) {
    missing.push("source_instance_id");
  }
  const baseUrl = redactReferenceBaseUrl(options.baseUrl);
  if (missing.length > 0) {
    return {
      base_url: baseUrl,
      check: "device_source_state",
      missing,
      status: "unknown",
    };
  }
  if (!(deviceId && deviceToken && sourceInstanceId)) {
    throw new Error("reference route config narrowing failed");
  }

  try {
    const client =
      deps.client ??
      new LocalDeviceClient({
        baseUrl: options.baseUrl,
        deviceId,
        deviceToken,
        requestTimeoutMs: REFERENCE_ROUTE_DOCTOR_TIMEOUT_MS,
      });
    const projection = await client.getSourceInstanceState({ sourceInstanceId });
    // The state read the probe already performs is the same one that carries the
    // owner-declared boundary, so `doctor` can state the active scope without an
    // extra round-trip. This is the surface that answers "complete within WHAT?"
    // for an operator looking at a green lane.
    return {
      base_url: baseUrl,
      check: "device_source_state",
      scope: collectorScopeFingerprint(readCollectionScopeFromState(projection.state)),
      status: "ok",
    };
  } catch (error) {
    return {
      base_url: baseUrl,
      check: "device_source_state",
      ...referenceRouteErrorFields(error),
      status: "fail",
    };
  }
}

function referenceRouteErrorFields(
  error: unknown
): Pick<LocalCollectorReferenceRouteCheck, "error_class" | "http_status"> {
  if (error instanceof LocalDeviceHttpError) {
    return {
      error_class: error.code ? `http_${error.status}_${error.code}` : `http_${error.status}`,
      http_status: error.status,
    };
  }
  if (error instanceof LocalDeviceRequestTimeoutError) {
    return { error_class: "timeout" };
  }
  if (error instanceof TypeError) {
    return { error_class: "network_error" };
  }
  if (error instanceof Error) {
    return { error_class: sanitizeErrorClass(error.name || "error") };
  }
  return { error_class: "unknown_error" };
}

function sanitizeErrorClass(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "error";
}

function redactReferenceBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid_url";
  }
}

export function buildLocalOutboxDoctor(
  status: LocalOutboxStatusOutput,
  errorSummary?: LocalDeviceOutboxDeadLetterErrorSummary | null,
  referenceRoute?: LocalCollectorReferenceRouteCheck | null
): LocalOutboxDoctorOutput {
  const posture = status.deployment_posture;
  const postureDisqualifiesEvidence = posture.kind === "repo_dist_override" || posture.is_placeholder_version;
  const checks: LocalOutboxDoctorOutput["checks"] = {
    coverage_diagnostics: status.lifecycle_state === "coverage_missing" ? "warn" : "ok",
    deployment_posture: postureDisqualifiesEvidence ? "warn" : "ok",
    expired_leases: status.outbox.expired_leases > 0 ? "warn" : "ok",
    outbox_db: status.db.exists ? "ok" : "missing",
    outbox_failures: status.outbox.counts.dead_letter > 0 ? "fail" : "ok",
    ...(referenceRoute ? { reference_route: referenceRoute.status } : {}),
  };
  const remediation: string[] = [];
  if (checks.outbox_failures === "fail") {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const topClass = errorSummary?.top_classes?.[0];
    const causeHint = topClass ? ` Most common cause: ${topClass.error_class} (${topClass.count} row(s)).` : "";
    remediation.push(
      `${status.outbox.counts.dead_letter} dead-letter row(s) need recovery.${causeHint} ` +
        "Preview with `pdpp-local-collector recover --source-instance-id <id>`, then apply with " +
        "`pdpp-local-collector recover --source-instance-id <id> --apply`. The apply step backs up the DB, " +
        "prepares failed uploads for retry when present, and drains queued work until clear or bounded."
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
  if (checks.reference_route === "fail" && referenceRoute) {
    remediation.push(referenceRouteRemediation(referenceRoute));
  }
  const includeSummary = Boolean(errorSummary) && status.outbox.counts.dead_letter > 0;
  return {
    ...status,
    checks,
    ...(includeSummary && errorSummary ? { dead_letter_error_summary: errorSummary } : {}),
    ...(referenceRoute ? { reference_route: referenceRoute } : {}),
    ...(remediation.length > 0 ? { remediation } : {}),
    status: doctorSeverityForChecks(checks),
  };
}

function referenceRouteRemediation(route: LocalCollectorReferenceRouteCheck): string {
  const detail = route.http_status ? `HTTP ${route.http_status}` : (route.error_class ?? "route failure");
  return (
    `The configured reference route (${route.base_url}) did not accept the device source-state check (${detail}). ` +
    "Check `PDPP_REFERENCE_BASE_URL`, network/VPN/reverse-proxy routing, and the enrolled device token before re-running. " +
    "Do not edit or recover the local outbox for this condition; saved work should remain queued until the route is fixed."
  );
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
      'See docs/reference/local-collector.md §"Deployment Posture: Published vs Dev".'
  );
  return parts.join(" ");
}

/**
 * Roll the per-check verdicts into the coarse doctor severity. Dead-letter
 * rows and a failed configured reference route are `critical` conditions
 * (they prevent delivery or need operator recovery); expired leases, a missing
 * DB, a coverage gap, and a dev/placeholder deployment posture are `warning`
 * (each self-heals, is informational, or is a supported dev path that merely
 * disqualifies operator-host evidence);
 * everything else is `ok`. A `retryable_backlog`/`draining` lane stays `ok`
 * because it drains itself on the next scheduled run — surfaced via
 * `lifecycle_state`, not as a warning.
 */
function doctorSeverityForChecks(checks: LocalOutboxDoctorOutput["checks"]): "ok" | "warning" | "critical" {
  if (checks.outbox_failures === "fail" || checks.reference_route === "fail") {
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
    const statusBefore = summaryCounts(
      outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {})
    );
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
    const statusAfter = summaryCounts(
      outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {})
    );
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
  drain_attempts?: number;
  drain_stopped_reason?: "drained" | "max_passes" | "no_progress";
  dry_run: boolean;
  fully_drained?: boolean;
  note: string;
  object: "local_collector_recovery";
  profile: {
    name: string | null;
    source: "configured_queue" | "local_profile";
  };
  retry_dead_letters: RetryDeadLettersOutput | null;
  run: LocalCollectorRunOutput | null;
  runs?: LocalCollectorRunOutput[];
  source_instance_id: string;
  status_after: LocalOutboxStatusOutput | null;
  status_before: LocalOutboxStatusOutput;
}

export interface RecoverLocalCollectorDeps {
  inspectStatus?: (options: CliOptions) => LocalOutboxStatusOutput;
  retryDeadLetters?: (options: CliOptions) => RetryDeadLettersOutput;
  runOnce?: (options: CliOptions) => Promise<CollectorRunResult>;
}

function defaultCollectorProfileDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "pdpp", "collectors");
}

export function parseCollectorProfileEnv(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of contents.split(PROFILE_ENV_LINE_SEPARATOR)) {
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
    if (!PROFILE_ENV_KEY.test(key)) {
      continue;
    }
    env[key] = unquoteProfileEnvValue(rawValue);
  }
  return env;
}

function unquoteProfileEnvValue(rawValue: string): string {
  if (rawValue.length >= 2) {
    const [quote] = rawValue;
    if ((quote === '"' || quote === "'") && rawValue.endsWith(quote)) {
      const inner = rawValue.slice(1, -1);
      return quote === '"'
        ? inner.replace(PROFILE_ENV_QUOTE_ESCAPE, '"').replace(PROFILE_ENV_BACKSLASH_ESCAPE, "\\")
        : inner;
    }
  }
  return rawValue;
}

function profileSourceInstanceId(env: Record<string, string>): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  return env.PDPP_SOURCE_INSTANCE_ID?.trim() || env.PDPP_CONNECTION_ID?.trim() || null;
}

function safeProfileFileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_FILE_NAME.test(trimmed)) {
    throw new CollectorUsageError("--profile must be a simple profile file name");
  }
  return PROFILE_ENV_EXTENSION.test(trimmed) ? trimmed : `${trimmed}.env`;
}

/** Absolute path of an existing profile file for `name`, or `null` when none exists. Used by `connect`'s overwrite guard. */
function existingCollectorProfilePath(name: string): string | null {
  const profileDir = process.env[LOCAL_COLLECTOR_PROFILE_DIR_ENV]?.trim() || defaultCollectorProfileDir();
  const path = join(profileDir, safeProfileFileName(name));
  return existsSync(path) ? path : null;
}

/**
 * Serialize a profile `.env` file body. Values are double-quoted so a base
 * URL or label containing spaces/special characters round-trips through
 * {@link parseCollectorProfileEnv} unambiguously. Never includes a trailing
 * comment or metadata field that could be mistaken for a secret value.
 */
function serializeCollectorProfileEnv(env: Readonly<Record<string, string>>): string {
  const lines = Object.entries(env).map(([key, value]) => {
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `${key}="${escaped}"`;
  });
  return `${lines.join("\n")}\n`;
}

export interface WriteLocalCollectorProfileInput {
  baseUrl: string;
  connectorId: string;
  deviceId: string;
  deviceToken: string;
  name: string;
  profileDir?: string;
  sourceInstanceId: string;
}

/**
 * Persist an enrollment result as a profile `.env` file so `run`/`recover`
 * can resolve it by source-instance id without the operator hand-copying
 * `device_id`/`device_token`/`source_instance_id` into shell env vars. This
 * is the write side of {@link findLocalCollectorProfiles}, which already
 * reads this exact file shape for `recover`/`status`/`doctor` — `setup` is
 * the first command to author one.
 *
 * Directory is created `0700` and the file `0600` (owner read/write only),
 * matching the existing secret-adjacent write pattern in
 * `collector-runner.ts`'s connector-protocol debug dump. `mode` on
 * `mkdirSync`/`writeFileSync` only applies at CREATION — POSIX `open()`
 * does not `chmod` an existing path on truncate-and-rewrite — so both are
 * followed by an explicit `chmodSync` to reset the mode even when the
 * directory/file already existed with weaker permissions (e.g. `connect
 * --force` reusing a profile left at `0644` by a manual `chmod`, an older
 * build, or a restored backup). `chmod`/POSIX mode bits are inert on
 * Windows, where NTFS ACLs (not mode bits) govern access; the file still
 * lands under the user's own profile directory there.
 */
export function writeLocalCollectorProfile(input: WriteLocalCollectorProfileInput): string {
  const profileDir =
    input.profileDir?.trim() || process.env[LOCAL_COLLECTOR_PROFILE_DIR_ENV]?.trim() || defaultCollectorProfileDir();
  mkdirSync(profileDir, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    chmodSync(profileDir, 0o700);
  }
  const fileName = safeProfileFileName(input.name);
  const path = join(profileDir, fileName);
  const body = serializeCollectorProfileEnv({
    PDPP_REFERENCE_BASE_URL: input.baseUrl,
    PDPP_COLLECTOR_CONNECTOR: input.connectorId,
    PDPP_LOCAL_DEVICE_ID: input.deviceId,
    PDPP_LOCAL_DEVICE_TOKEN: input.deviceToken,
    PDPP_CONNECTION_ID: input.sourceInstanceId,
  });
  writeFileSync(path, body, { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
  return path;
}

/**
 * Delete a profile `.env` file by name (the `logout`/credential-removal
 * lifecycle). Only removes the local file — it does NOT revoke the device
 * token server-side; a stale token remains valid against the reference
 * deployment until that deployment's own admin revokes it. Returns false
 * (not an error) when the profile was already absent, so `logout` is
 * idempotent.
 */
export function removeLocalCollectorProfile(input: { name: string; profileDir?: string }): {
  path: string;
  removed: boolean;
} {
  const profileDir =
    input.profileDir?.trim() || process.env[LOCAL_COLLECTOR_PROFILE_DIR_ENV]?.trim() || defaultCollectorProfileDir();
  const fileName = safeProfileFileName(input.name);
  const path = join(profileDir, fileName);
  if (!existsSync(path)) {
    return { path, removed: false };
  }
  rmSync(path);
  return { path, removed: true };
}

export function findLocalCollectorProfiles(input: {
  profileDir?: string;
  profileName?: string | null;
  sourceInstanceId?: string | null;
}): LocalCollectorProfileLookupResult {
  const profileDir =
    input.profileDir?.trim() || process.env[LOCAL_COLLECTOR_PROFILE_DIR_ENV]?.trim() || defaultCollectorProfileDir();
  const sourceInstanceId = input.sourceInstanceId?.trim() || null;
  const files = input.profileName
    ? [safeProfileFileName(input.profileName)]
    : (() => {
        try {
          return readdirSync(profileDir)
            .filter((name) => name.endsWith(".env"))
            .sort();
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
      name: file.replace(PROFILE_ENV_EXTENSION, ""),
      path,
      source_instance_id: profileSource,
    });
  }

  return { matches, profile_dir: profileDir };
}

function applyProfileEnv(options: CliOptions, profile: LocalCollectorProfile): CliOptions {
  const { env } = profile;
  const explicit = options.explicitOptions;
  const keep = (flag: string): boolean => explicit?.has(flag) === true;
  const profileQueuePath = Object.hasOwn(env, "PDPP_COLLECTOR_QUEUE") ? env.PDPP_COLLECTOR_QUEUE : undefined;
  const configuredQueuePath = hasExplicitQueuePath(options);
  const next: CliOptions = {
    ...options,
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    baseUrl: keep("--base-url") ? options.baseUrl : env.PDPP_REFERENCE_BASE_URL?.trim() || options.baseUrl,
    queuePath: configuredQueuePath ? options.queuePath : (profileQueuePath ?? options.queuePath),
    queuePathExplicit: configuredQueuePath || profileQueuePath !== undefined,
  };
  const sourceInstanceId = profile.source_instance_id ?? options.sourceInstanceId;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const connector = keep("--connector") ? options.connector : env.PDPP_COLLECTOR_CONNECTOR?.trim() || options.connector;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const deviceId = keep("--device-id") ? options.deviceId : env.PDPP_LOCAL_DEVICE_ID?.trim() || options.deviceId;
  const deviceToken = keep("--device-token")
    ? options.deviceToken
    : // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      env.PDPP_LOCAL_DEVICE_TOKEN?.trim() || options.deviceToken;
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

  const configuredQueue = hasExplicitQueuePath(options);
  if (!configuredQueue) {
    throw new CollectorUsageError(
      `recover could not find a local collector profile for source_instance_id '${sourceInstanceId}'. ` +
        "Run this on the collector host after enrollment, pass --profile <name>, or set PDPP_COLLECTOR_QUEUE/--queue explicitly. " +
        "Refusing to inspect an unscoped default queue because it may be unrelated to the enrolled collector."
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
  if (hasExplicitQueuePath(options)) {
    return options;
  }

  const lookup = findLocalCollectorProfiles({
    profileName: options.profile ?? null,
    sourceInstanceId: sourceInstanceId ?? null,
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

  // An explicit profile is already an identity selector. Requiring the
  // source-instance id as well makes the documented `doctor --profile NAME`
  // path silently fall back to the unrelated default queue, which is unsafe
  // for read-only health diagnosis and also loses the profile's base URL.
  if (options.profile) {
    throw new CollectorUsageError(
      `${options.command} could not find local collector profile '${options.profile}'. ` +
        "Check --profile <name> or pass --queue <path> explicitly."
    );
  }

  if (!sourceInstanceId) {
    return options;
  }

  const configuredQueue = hasExplicitQueuePath(options);
  if (!configuredQueue) {
    throw new CollectorUsageError(
      `${options.command} could not find a local collector profile for source_instance_id '${sourceInstanceId}'. ` +
        "Run this on the collector host after enrollment, pass --profile <name>, or set PDPP_COLLECTOR_QUEUE/--queue explicitly. " +
        "Refusing to inspect an unscoped default queue because it may be unrelated to the enrolled collector."
    );
  }

  return options;
}

/**
 * `run`'s profile-fill: best-effort ONLY. Unlike {@link resolveInspectionOptions}
 * (which refuses when a `--connection-id` has no matching profile and no
 * queue was configured — appropriate for status/doctor/recover, which are
 * pure inspection and would otherwise silently read an unrelated default
 * queue), `run` must keep working exactly as before for automation that
 * supplies device-id/device-token/connector entirely via flags or env vars
 * with no profile file on disk. A missing/ambiguous profile is simply a
 * no-op here — `runCollectorOnce`'s own required-field check is what
 * ultimately reports a genuinely incomplete invocation.
 */
export function resolveRunProfileOptions(options: CliOptions): CliOptions {
  const sourceInstanceId = options.sourceInstanceId?.trim();
  if (!sourceInstanceId || hasExplicitQueuePath(options)) {
    return options;
  }
  const lookup = findLocalCollectorProfiles({
    profileName: options.profile ?? null,
    sourceInstanceId,
  });
  if (lookup.matches.length === 1) {
    return applyProfileEnv(options, lookup.matches[0] as LocalCollectorProfile);
  }
  if (lookup.matches.length > 1) {
    throw new CollectorUsageError(
      `run found ${lookup.matches.length} local collector profiles for source_instance_id '${sourceInstanceId}'. ` +
        "Pass --profile <name> to disambiguate."
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
      `${status.outbox.counts.dead_letter} failed upload row(s) would be prepared for retry, then the collector would drain queued work. ` +
      "Dry run only; re-run with --apply to mutate the local outbox and upload."
    );
  }
  return (
    "No failed upload rows are present for this source. The recovery apply step would run the collector on this host " +
    "to refresh state and drain queued work until clear or bounded."
  );
}

function outboxOpenWork(status: LocalOutboxStatusOutput): number {
  const { counts } = status.outbox;
  return counts.dead_letter + counts.leased + counts.pending;
}

function recoverAppliedNote(input: {
  attempts: number;
  maxPasses: number;
  retry: RetryDeadLettersOutput | null;
  statusAfter: LocalOutboxStatusOutput;
  statusBefore: LocalOutboxStatusOutput;
  stoppedReason: RecoverLocalCollectorOutput["drain_stopped_reason"];
}): string {
  const { attempts, maxPasses, retry, statusAfter, statusBefore, stoppedReason } = input;
  const retried = retry ? `${retry.requeued} failed upload row(s) were prepared for retry. ` : "";
  const remaining = outboxOpenWork(statusAfter);
  if (stoppedReason === "drained") {
    return `${retried}The collector drained queued work in ${attempts} pass(es).`;
  }
  if (hasDeadLetters(statusBefore)) {
    if (stoppedReason === "max_passes") {
      return `${retried}The collector ran ${attempts} drain pass(es) and ${remaining} queued row(s) remain. Re-run this command to continue; it stopped at the ${maxPasses}-pass safety bound.`;
    }
    return `${retried}The collector ran ${attempts} drain pass(es) and ${remaining} queued row(s) remain. It stopped because another pass did not reduce the backlog.`;
  }
  if (stoppedReason === "max_passes") {
    return `The collector ran ${attempts} drain pass(es) and ${remaining} queued row(s) remain. Re-run this command to continue; it stopped at the ${maxPasses}-pass safety bound.`;
  }
  return `The collector ran ${attempts} drain pass(es) and ${remaining} queued row(s) remain. It stopped because another pass did not reduce the backlog.`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
export async function recoverLocalCollector(
  options: CliOptions,
  deps: RecoverLocalCollectorDeps = {}
): Promise<RecoverLocalCollectorOutput> {
  const inspectStatus = deps.inspectStatus ?? inspectLocalOutboxStatus;
  const retryDeadLetters = deps.retryDeadLetters ?? retryLocalOutboxDeadLetters;
  const runOnce = deps.runOnce ?? runCollectorOnce;
  const resolved = resolveRecoveryOptions(options);
  const { options: resolvedOptions } = resolved;
  const { sourceInstanceId } = resolvedOptions;
  if (!sourceInstanceId) {
    throw new CollectorUsageError("recover requires --source-instance-id <id>");
  }

  const statusBefore = inspectStatus(resolvedOptions);
  const retryPreview = hasDeadLetters(statusBefore) ? retryDeadLetters({ ...resolvedOptions, apply: false }) : null;

  if (!options.apply) {
    return {
      applied: false,
      db: statusBefore.db.path
        ? { exists: statusBefore.db.exists, path: statusBefore.db.path }
        : { exists: false, path: "" },
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

  const retryApply = hasDeadLetters(statusBefore) ? retryDeadLetters({ ...resolvedOptions, apply: true }) : null;
  const maxPasses = options.maxDrainPasses ?? RECOVER_DEFAULT_MAX_DRAIN_PASSES;
  const runs: LocalCollectorRunOutput[] = [];
  let statusAfter = inspectStatus(resolvedOptions);
  let stoppedReason: RecoverLocalCollectorOutput["drain_stopped_reason"] = "drained";
  let previousOpenAfterRun: number | null = null;

  for (let attempt = 0; attempt < maxPasses; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const run = summarizeRunResultForCli(await runOnce(resolvedOptions));
    runs.push(run);
    statusAfter = inspectStatus(resolvedOptions);
    const openWork = outboxOpenWork(statusAfter);
    const discoveredNewWork = run.recordsQueued > 0 || run.enqueuedBatches > 0;
    if (openWork === 0) {
      stoppedReason = "drained";
      break;
    }
    if (previousOpenAfterRun !== null && openWork >= previousOpenAfterRun && !discoveredNewWork) {
      stoppedReason = "no_progress";
      break;
    }
    previousOpenAfterRun = openWork;
    if (attempt === maxPasses - 1) {
      stoppedReason = "max_passes";
    }
  }
  const latestRun = runs.at(-1) ?? null;
  return {
    applied: true,
    db: statusAfter.db.path
      ? { exists: statusAfter.db.exists, path: statusAfter.db.path }
      : { exists: false, path: "" },
    drain_attempts: runs.length,
    drain_stopped_reason: stoppedReason,
    dry_run: false,
    fully_drained: outboxOpenWork(statusAfter) === 0,
    note: recoverAppliedNote({
      attempts: runs.length,
      maxPasses,
      retry: retryApply,
      statusAfter,
      statusBefore,
      stoppedReason,
    }),
    object: "local_collector_recovery",
    profile: { name: resolved.profileName, source: resolved.profileSource },
    retry_dead_letters: retryApply,
    run: latestRun,
    ...(runs.length > 1 ? { runs } : {}),
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
  const olderThanIso = olderThanDays === undefined ? undefined : daysAgoIso(olderThanDays);
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
    const statusBefore = summaryCounts(
      outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {})
    );
    const dryRun = !options.apply;

    const pruneInput: LocalDeviceOutboxPruneSentInput = {
      dryRun,
      ...(olderThanIso === undefined ? {} : { olderThanIso }),
      ...(options.keepCount === undefined ? {} : { keepCount: options.keepCount }),
      ...(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {}),
    };

    // For dry-run, preview the match count without acquiring a write lock.
    // For apply, back up first then delete.
    const backupPath = dryRun ? null : backupSqliteDb(outbox, dbPath, "prune-sent");
    const result = outbox.pruneSent(pruneInput);
    const statusAfter = summaryCounts(
      outbox.summary(options.sourceInstanceId ? { sourceInstanceId: options.sourceInstanceId } : {})
    );

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
      "Re-run with --apply to delete (backs up the DB first). " +
      "This only removes sent rows — pending, leased, retrying, and dead-letter rows are never touched."
    );
  }
  return (
    `${result.pruned} sent row(s) pruned. ` +
    "Pending, leased, retrying, and dead-letter rows were not touched. " +
    "Run `pdpp-local-collector status` to confirm the new outbox size."
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
  /**
   * Count of rows that are NOT `succeeded` (ready/leased/dead-letter) across
   * the whole file. A non-zero value blocks an apply unless `--force` is set.
   */
  non_succeeded_rows: number;
  note: string;
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

function compactAppliedNote(result: LocalDeviceOutboxCompactResult, nonSucceeded: number, force: boolean): string {
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

  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
  const command = options.entrypointCommand ?? bundled?.command ?? "tsx";
  const args = options.args ?? [...(bundled?.args ?? [`connectors/${options.connector}/index.ts`])];
  const streams = options.streams ?? [...(bundled?.streams ?? [])];
  if (streams.length === 0) {
    throw new CollectorUsageError(`run requires --streams <a,b,c> for connector ${options.connector}`);
  }
  return {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: bundled is null on the custom-command path (customAllowed); options.connector is the fallback connector_id there.
    connector_id: bundled?.connector_id ?? options.connector,
    streams,
    ...(options.streamsToBackfill ? { streamsToBackfill: options.streamsToBackfill } : {}),
    command,
    args,
    // Which streams a declared `since` can be proven against. Carried from the
    // connector's own definition so the runtime enforces a boundary without
    // knowing any connector; absent for a custom-command dev entry, which then
    // simply runs unscoped rather than guessing.
    ...(bundled?.time_scopable_streams ? { timeScopableStreams: bundled.time_scopable_streams } : {}),
    ...(bundled?.source_root_scopable_streams
      ? { sourceRootScopableStreams: bundled.source_root_scopable_streams }
      : {}),
    // Only a connector that declared it prunes by root may have a roots
    // boundary honoured; otherwise it is declassified, never falsely claimed.
    ...(bundled?.enforces_source_roots ? { enforcesSourceRoots: true } : {}),
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
    runtime_requirements: { bindings: bundled?.bindings ?? {} },
  };
}

export function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help" || !command) {
    writeStdout(HELP_TEXT);
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
    command !== "compact" &&
    command !== "setup" &&
    command !== "connect" &&
    command !== "connectors" &&
    command !== "logout"
  ) {
    throw new CollectorUsageError(
      "usage: pdpp-local-collector <setup|connect|run|status|doctor|logout|connectors|advertise|enroll|recover|retry-dead-letters|prune-sent|compact> --base-url <url> [options]"
    );
  }
  const configuredQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
  const options: CliOptions = {
    baseUrl: process.env.PDPP_REFERENCE_BASE_URL ?? "http://127.0.0.1:7662",
    command,
    queuePath: configuredQueuePath ?? "",
    queuePathExplicit: configuredQueuePath !== undefined,
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

  for (let index = 0; index < rest.length; index += 1) {
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
    index += 1;
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
  if (arg === "--quiet") {
    options.quiet = true;
    return true;
  }
  if (arg === "--json") {
    options.json = true;
    return true;
  }
  if (arg === "--local-only") {
    options.localOnly = true;
    return true;
  }
  if (arg === "--all") {
    options.allHistory = true;
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
      options.queuePathExplicit = true;
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
    "--max-drain-passes": (next) => {
      options.maxDrainPasses = parsePositiveInteger("--max-drain-passes", next);
    },
    "--sample": (next) => {
      options.sample = parsePositiveInteger("--sample", next);
    },
    "--label": (next) => {
      options.deviceLabel = next;
    },
    "--recent": (next) => {
      options.recentDays = parsePositiveInteger("--recent", next);
    },
    "--since": (next) => {
      options.since = next;
    },
    "--source-roots": (next) => {
      options.sourceRoots = parseCsv(next);
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

function resolveOutboxPath(options: CliOptions): string {
  return resolveCollectorQueuePath({
    configuredPath: options.queuePath,
    configuredPathIsExplicit: hasExplicitQueuePath(options),
    connectorId: options.connector ? normalizeConnectorId(options.connector) : null,
    sourceInstanceId: options.sourceInstanceId,
  });
}

function hasExplicitQueuePath(options: CliOptions): boolean {
  // Direct programmatic callers historically passed a nonempty queuePath
  // without the parser's provenance bit. Treat that shape as explicit while
  // parser/profile defaults use the explicit false/undefined empty sentinel.
  return (
    options.queuePathExplicit === true || (options.queuePathExplicit === undefined && options.queuePath.trim() !== "")
  );
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
    oldestRetryingAt: null,
    ready: 0,
    retrying: 0,
    staleLeases: 0,
    succeeded: 0,
    total: 0,
  };
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const exitCode = error instanceof CollectorUsageError ? error.exitCode : 1;
    process.exit(exitCode);
  });
}
