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

import { fileURLToPath } from "node:url";

export {
  buildCollectorStartMessage,
  COLLECTOR_PROTOCOL_VERSION,
  COLLECTOR_RUNTIME_CAPABILITIES,
  CollectorStateReadError,
  drainCollectorQueue,
  emitToStdout,
  enrollCollector,
  evaluatePlacement,
  isMainModule,
  LocalDeviceClient,
  LocalDeviceHttpError,
  LocalDeviceQueue,
  PROVIDER_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  RuntimeCapabilityMismatchError,
  assertPlacementOrThrow,
  buildLocalDeviceRecordEnvelope,
  canonicalJson,
  diffRequiredBindings,
  hashCanonicalJson,
  parseJsonlLine,
  resourceSet,
  runCollectorConnector,
  stringifyForJsonl,
  transformRecordsToCollectorEnvelopes,
  type CollectorChildContext,
  type CollectorConnectorSpec,
  type CollectorEnrollmentConfig,
  type CollectorRunConfig,
  type CollectorRunResult,
  type ConnectorPlacementInput,
  type ConnectorRuntimeRequirements,
  type EmittedMessage,
  type EnrollmentExchangeResponse,
  type LocalDeviceRecordEnvelope,
  type PlacementDecision,
  type RuntimeBindingName,
  type RuntimeCapabilityProfile,
  type StartMessage,
  type StreamScope,
} from "@pdpp/polyfill-connectors/runner";

import { COLLECTOR_PROTOCOL_VERSION as PROTOCOL_VERSION } from "@pdpp/polyfill-connectors/runner";

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

const POLYFILL_CLAUDE_CODE_ENTRY = fileURLToPath(
  new URL("../../polyfill-connectors/connectors/claude_code/index.ts", import.meta.url)
);

const POLYFILL_CODEX_ENTRY = fileURLToPath(
  new URL("../../polyfill-connectors/connectors/codex/index.ts", import.meta.url)
);

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
    command: "tsx",
    args: Object.freeze([POLYFILL_CLAUDE_CODE_ENTRY]) as readonly string[],
    bindings: Object.freeze({ filesystem: Object.freeze({ required: true }) }),
    streams: Object.freeze([
      "sessions",
      "messages",
      "attachments",
      "memory_notes",
      "skills",
      "slash_commands",
    ]) as readonly string[],
  }),
  codex: Object.freeze({
    connector_id: "codex",
    command: "tsx",
    args: Object.freeze([POLYFILL_CODEX_ENTRY]) as readonly string[],
    bindings: Object.freeze({ filesystem: Object.freeze({ required: true }) }),
    streams: Object.freeze([
      "sessions",
      "messages",
      "function_calls",
      "rules",
      "prompts",
      "skills",
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
