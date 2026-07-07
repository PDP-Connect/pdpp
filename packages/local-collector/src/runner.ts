/**
 * Programmatic entrypoint for `@pdpp/local-collector`.
 *
 * Re-exports the runner-side surface (collector loop, device-exporter
 * ingest client, runtime-capabilities profile, JSONL primitives, and
 * protocol message types) from the source-of-truth slice in
 * `@pdpp/polyfill-connectors/runner`.
 *
 * Filesystem-class connector entrypoints (Claude Code, Codex) are
 * registered in `BUNDLED_CONNECTORS` so `pdpp-local-collector` can
 * resolve `--connector claude_code` and `--connector codex` without an
 * arbitrary `--command <bin>` escape hatch.
 *
 * Boundary: this module MUST NOT import `playwright`, `patchright`, or any
 * other browser-bound dependency. The `@pdpp/local-collector` publish
 * pipeline asserts that with a CI grep gate over the produced tarball.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §1–§3.
 */

import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COLLECTOR_PROTOCOL_VERSION as PROTOCOL_VERSION,
  COLLECTOR_RUNTIME_CAPABILITIES as POLYFILL_COLLECTOR_RUNTIME_CAPABILITIES,
  type RuntimeCapabilityProfile,
} from "../../polyfill-connectors/src/runner/index.ts";

export {
  buildCollectorStartMessage,
  COLLECTOR_COVERAGE_STATUSES,
  COLLECTOR_PROTOCOL_VERSION,
  CollectorStateReadError,
  drainCollectorQueue,
  emitToStdout,
  enrollCollector,
  evaluatePlacement,
  isMainModule,
  LocalDeviceClient,
  LocalDeviceHttpError,
  LocalDeviceRequestTimeoutError,
  LocalDeviceOutbox,
  LocalDeviceQueue,
  PROVIDER_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  RuntimeCapabilityMismatchError,
  assertPlacementOrThrow,
  buildLocalDeviceRecordEnvelope,
  buildLocalDeviceOutboxId,
  canonicalJson,
  classifyDeadLetterError,
  deriveLocalCollectorLifecycleState,
  diffRequiredBindings,
  hashCanonicalJson,
  LOCAL_COLLECTOR_LIFECYCLE_STATES,
  parseJsonlLine,
  resourceSet,
  runCollectorConnector,
  stringifyForJsonl,
  summarizeCollectorCompleteness,
  transformRecordsToCollectorEnvelopes,
  type CollectorChildContext,
  type CollectorCompletenessSummary,
  type CollectorConnectorSpec,
  type CollectorCoverageStatus,
  type CollectorEnrollmentConfig,
  type CollectorRunConfig,
  type CollectorRunResult,
  type ConnectorPlacementInput,
  type ConnectorRuntimeRequirements,
  type EmittedMessage,
  type EnrollmentExchangeResponse,
  type LocalCollectorLifecycleInput,
  type LocalCollectorLifecycleState,
  type LocalDeviceRecordEnvelope,
  type BuildLocalDeviceOutboxIdInput,
  type LocalDeviceOutboxClaimInput,
  type LocalDeviceOutboxCompactResult,
  type LocalDeviceOutboxDeadLetterErrorClass,
  type LocalDeviceOutboxDeadLetterErrorSummary,
  type LocalDeviceOutboxDeadLetterErrorSummaryInput,
  type LocalDeviceOutboxDeadLetterInput,
  type LocalDeviceOutboxEnqueueInput,
  type LocalDeviceOutboxFailInput,
  type LocalDeviceOutboxItem,
  type LocalDeviceOutboxKind,
  type LocalDeviceOutboxLeaseInput,
  type LocalDeviceOutboxOptions,
  type LocalDeviceOutboxPageStats,
  type LocalDeviceOutboxPruneSentInput,
  type LocalDeviceOutboxPruneSentResult,
  type LocalDeviceOutboxRequeueDeadLettersInput,
  type LocalDeviceOutboxRequeueDeadLettersResult,
  type LocalDeviceOutboxStatus,
  type LocalDeviceOutboxSummary,
  type PlacementDecision,
  type RuntimeBindingName,
  type RuntimeCapabilityProfile,
  type StartMessage,
  type StreamScope,
} from "../../polyfill-connectors/src/runner/index.ts";

/**
 * Public package capability profile.
 *
 * The monorepo collector runtime may satisfy browser-bound development
 * connectors, but this published package intentionally bundles only
 * filesystem-class Claude Code and Codex entrypoints. Advertising `browser`
 * here would overstate the package contract and weaken runtime placement.
 */
export const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  id: POLYFILL_COLLECTOR_RUNTIME_CAPABILITIES.id,
  bindings: new Set(["network", "filesystem", "local_device"]),
};

/**
 * Default arguments for each bundled filesystem-class connector.
 *
 * These describe the *runtime invocation* of the connector child process
 * the collector spawns under `runCollectorConnector`. The published
 * `pdpp-local-collector` resolves entries here by `connector_id`; there is
 * no public `--command <bin>` escape hatch.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §3.
 */
export interface BundledConnectorEntry {
  /** Stable connector id (matches the manifest + ingest envelope). */
  readonly connector_id: string;
  /** Argv to feed `runCollectorConnector` (typically `tsx <entry>`). */
  readonly args: readonly string[];
  /** Default executable; `tsx` for the source-only TypeScript entrypoints. */
  readonly command: string;
  /** Bindings the connector requires from the collector runtime profile. */
  readonly bindings: Readonly<Record<string, { required: boolean }>>;
  /** Default stream set; operators can override with `--streams`. */
  readonly streams: readonly string[];
}

function bundledEntry(connectorPath: string): string {
  const built = fileURLToPath(new URL(`../../polyfill-connectors/connectors/${connectorPath}/index.js`, import.meta.url));
  if (existsSync(built)) {
    return built;
  }
  return fileURLToPath(new URL(`../../polyfill-connectors/connectors/${connectorPath}/index.ts`, import.meta.url));
}

function commandForEntry(entry: string): "node" | "tsx" {
  return extname(entry) === ".ts" ? "tsx" : "node";
}

const POLYFILL_CLAUDE_CODE_ENTRY = bundledEntry("claude_code");
const POLYFILL_CODEX_ENTRY = bundledEntry("codex");

/**
 * Registry of filesystem-class connectors bundled with `@pdpp/local-collector`.
 *
 * Order matches the supported public path on a fresh host: Claude Code and
 * Codex transcripts. Browser-bound connectors are intentionally absent —
 * each will get its own publishability review before being added.
 */
export const BUNDLED_CONNECTORS: Readonly<Record<string, BundledConnectorEntry>> = Object.freeze({
  claude_code: Object.freeze({
    connector_id: "claude_code",
    command: commandForEntry(POLYFILL_CLAUDE_CODE_ENTRY),
    args: Object.freeze([POLYFILL_CLAUDE_CODE_ENTRY]) as readonly string[],
    bindings: Object.freeze({ filesystem: Object.freeze({ required: true }) }),
    // Default stream set mirrors the full manifest-declared safe surface so
    // an unscoped `run` exercises everything the connector knows how to
    // account for — including `coverage_diagnostics`. Without the coverage
    // stream, a healthy drained collector emits zero durable coverage
    // evidence and the connection-health rollup can only ever project
    // `coverage_unknown` (the run path writes no spine run). The inventory
    // streams emit metadata only (path hash, size, mtime); deferred/excluded
    // stores never read payload. See
    // `docs/operator/local-collector-runbook.md`§"Coverage and excluded
    // stores" and `openspec/changes/derive-local-collector-coverage-from-diagnostics`.
    streams: Object.freeze([
      "sessions",
      "messages",
      "attachments",
      "memory_notes",
      "skills",
      "slash_commands",
      "file_history",
      "cache_inventory",
      "coverage_diagnostics",
      "debug_artifacts",
      "downloads",
      "backup_inventory",
      "config_inventory",
    ]) as readonly string[],
  }),
  codex: Object.freeze({
    connector_id: "codex",
    command: commandForEntry(POLYFILL_CODEX_ENTRY),
    args: Object.freeze([POLYFILL_CODEX_ENTRY]) as readonly string[],
    bindings: Object.freeze({ filesystem: Object.freeze({ required: true }) }),
    // Mirrors the full manifest-declared safe surface (see the claude_code
    // note above): `coverage_diagnostics` is what promotes a drained local
    // collector off `coverage_unknown`, and the inventory streams emit
    // metadata only.
    streams: Object.freeze([
      "sessions",
      "messages",
      "function_calls",
      "rules",
      "prompts",
      "skills",
      "history",
      "session_index",
      "logs",
      "shell_snapshots",
      "config_inventory",
      "cache_inventory",
      "coverage_diagnostics",
    ]) as readonly string[],
  }),
});

/** Stable list of connector ids the published `pdpp-local-collector` accepts. */
export const BUNDLED_CONNECTOR_IDS: readonly string[] = Object.freeze(
  Object.keys(BUNDLED_CONNECTORS)
);

/** Lookup helper. Returns null when the id is not bundled. */
export function getBundledConnector(connectorId: string): BundledConnectorEntry | null {
  return BUNDLED_CONNECTORS[connectorId] ?? null;
}

/**
 * Map of bundled connector versions reported to the dashboard's
 * `runtime_capabilities` payload.
 *
 * Today these track the runner package version (single source for the
 * whole bundle, per design §3). The map keeps the API shape stable for
 * the dashboard so per-connector versioning can be added later without
 * a payload-shape migration.
 */
export const BUNDLED_CONNECTOR_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  claude_code: PROTOCOL_VERSION,
  codex: PROTOCOL_VERSION,
});
