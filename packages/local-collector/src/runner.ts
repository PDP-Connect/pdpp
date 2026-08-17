// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Programmatic entrypoint for `@pdpp/local-collector`.
 *
 * Re-exports the runner-side surface (collector loop, device-exporter
 * ingest client, runtime-capabilities profile, JSONL primitives, and
 * protocol message types) from the source-of-truth package,
 * `@pdpp/collector-runtime`.
 *
 * This runtime is connector-AGNOSTIC. It does not know which connectors
 * support local collection or what streams they emit — a connector declares
 * that itself via a {@link LocalCollectorDefinition}, and the collector's
 * composition root (the `bin`) injects those definitions through
 * {@link createBundledConnectorRegistry}. Correct direction of knowledge: the
 * connector defines its collector; the runtime discovers definitions.
 *
 * Boundary: this module MUST NOT import `playwright`, `patchright`, any other
 * browser-bound dependency, OR any specific connector's code. Its only
 * dependency is the generic `@pdpp/collector-runtime` substrate. The
 * `@pdpp/local-collector` publish pipeline asserts the browser-free half with
 * a CI grep gate over the produced tarball.
 *
 * Imports below use RELATIVE paths into `@pdpp/collector-runtime`'s source
 * (not the `@pdpp/collector-runtime` package specifier), matching this
 * package's build: `tsconfig.build.json` compiles collector-runtime's source
 * directly into this package's own `dist/` tree (the same vendoring already
 * used for the bundled polyfill-connectors connectors), so the published
 * tarball ships self-contained and never depends on `@pdpp/collector-runtime`
 * being installed. A bare package-specifier import would emit unresolvable
 * in the compiled output, since this package's `dist/` ships with no
 * `node_modules`.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §1–§3.
 */

import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocalCollectorDefinition } from "../../collector-runtime/src/collector-definition.ts";
import {
  COLLECTOR_RUNTIME_CAPABILITIES as POLYFILL_COLLECTOR_RUNTIME_CAPABILITIES,
  COLLECTOR_PROTOCOL_VERSION as PROTOCOL_VERSION,
  type RuntimeCapabilityProfile,
} from "../../collector-runtime/src/index.ts";

// biome-ignore lint/performance/noBarrelFile: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
export {
  assertPlacementOrThrow,
  type BuildLocalDeviceOutboxIdInput,
  buildCollectorStartMessage,
  buildLocalDeviceOutboxId,
  buildLocalDeviceRecordEnvelope,
  COLLECTION_SCOPE_STATE_KEY,
  COLLECTOR_COVERAGE_STATUSES,
  COLLECTOR_PROTOCOL_VERSION,
  type CollectionScope,
  type CollectorChildContext,
  type CollectorCompletenessSummary,
  type CollectorConnectorSpec,
  type CollectorCoverageStatus,
  type CollectorEnrollmentConfig,
  type CollectorRunConfig,
  type CollectorRunResult,
  CollectorStateReadError,
  type ConnectorPlacementInput,
  type ConnectorRuntimeRequirements,
  canonicalJson,
  classifyDeadLetterError,
  collectorScopeFingerprint,
  deriveLocalCollectorLifecycleState,
  diffRequiredBindings,
  drainCollectorQueue,
  type EmittedMessage,
  type EnrollmentExchangeResponse,
  emitToStdout,
  enrollCollector,
  evaluatePlacement,
  hashCanonicalJson,
  isMainModule,
  LOCAL_COLLECTOR_LIFECYCLE_STATES,
  type LocalCollectorLifecycleInput,
  type LocalCollectorLifecycleState,
  LocalDeviceClient,
  LocalDeviceHttpError,
  LocalDeviceOutbox,
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
  LocalDeviceQueue,
  type LocalDeviceRecordEnvelope,
  LocalDeviceRequestTimeoutError,
  type PlacementDecision,
  PROVIDER_RUNTIME_CAPABILITIES,
  parseJsonlLine,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  type RuntimeBindingName,
  RuntimeCapabilityMismatchError,
  type RuntimeCapabilityProfile,
  readCollectionScopeFromState,
  resolveScopedStreamTimeRanges,
  resourceSet,
  runCollectorConnector,
  type StartMessage,
  type StreamScope,
  stringifyForJsonl,
  summarizeCollectorCompleteness,
  transformRecordsToCollectorEnvelopes,
} from "../../collector-runtime/src/index.ts";

/**
 * Public package capability profile.
 *
 * The monorepo collector runtime may satisfy browser-bound development
 * connectors, but this published package intentionally advertises only the
 * filesystem-class bindings its bundled connectors need. Advertising `browser`
 * here would overstate the package contract and weaken runtime placement.
 * (Which connectors are bundled is the injected registry's business, not this
 * runtime's — see {@link createBundledConnectorRegistry}.)
 */
export const COLLECTOR_RUNTIME_CAPABILITIES: RuntimeCapabilityProfile = {
  id: POLYFILL_COLLECTOR_RUNTIME_CAPABILITIES.id,
  bindings: new Set(["network", "filesystem", "local_device"]),
};

/**
 * Runtime invocation of a bundled connector's child process.
 *
 * This is the resolved, runnable form of a {@link LocalCollectorDefinition}:
 * the `command`/`args` the collector spawns under `runCollectorConnector`,
 * plus the connector's declared bindings and default streams. The published
 * `pdpp-local-collector` resolves entries by `connector_id`; there is no
 * public `--command <bin>` escape hatch.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §3.
 */
export interface BundledConnectorEntry {
  /** Argv to feed `runCollectorConnector` (typically `tsx <entry>`). */
  readonly args: readonly string[];
  /** Bindings the connector requires from the collector runtime profile. */
  readonly bindings: Readonly<Record<string, { required: boolean }>>;
  /** Default executable; `tsx` for the source-only TypeScript entrypoints. */
  readonly command: string;
  /** Stable connector id (matches the manifest + ingest envelope). */
  readonly connector_id: string;
  /** Whether the connector enforces path roots at enumeration time. */
  readonly enforces_source_roots?: boolean;
  /** Streams whose enumeration honors declared source roots. */
  readonly source_root_scopable_streams?: readonly string[];
  /** Default stream set; operators can override with `--streams`. */
  readonly streams: readonly string[];
  /** Streams an owner-declared `since` can be proven against. */
  readonly time_scopable_streams?: readonly string[];
}

/** A frozen, id-keyed registry of runnable bundled connector entries. */
export type BundledConnectorRegistry = Readonly<Record<string, BundledConnectorEntry>>;

/**
 * Resolve a connector's spawnable entry module from its `entry` directory
 * name, preferring the built `.js` (published tarball / repo `dist/`) and
 * falling back to the `.ts` source (monorepo `tsx` dev). Generic over the id:
 * the runtime hardcodes no connector name here.
 *
 * The connector entry lives under the collector's own `dist/` tree, emitted
 * next to this runner module — the collector build compiles the bundled
 * connectors into `dist/polyfill-connectors/connectors/<entry>/`.
 */
export function resolveBundledConnectorEntry(entry: string): string {
  const built = fileURLToPath(new URL(`../../polyfill-connectors/connectors/${entry}/index.js`, import.meta.url));
  if (existsSync(built)) {
    return built;
  }
  return fileURLToPath(new URL(`../../polyfill-connectors/connectors/${entry}/index.ts`, import.meta.url));
}

function commandForEntry(entry: string): "node" | "tsx" {
  return extname(entry) === ".ts" ? "tsx" : "node";
}

/** Turn one injected {@link LocalCollectorDefinition} into a runnable entry. */
function toBundledEntry(definition: LocalCollectorDefinition): BundledConnectorEntry {
  const resolvedEntry = resolveBundledConnectorEntry(definition.entry);
  return Object.freeze({
    connector_id: definition.connector_id,
    command: commandForEntry(resolvedEntry),
    args: Object.freeze([resolvedEntry]) as readonly string[],
    bindings: definition.bindings,
    streams: Object.freeze([...definition.streams]) as readonly string[],
    ...(definition.time_scopable_streams
      ? {
          time_scopable_streams: Object.freeze([...definition.time_scopable_streams]) as readonly string[],
        }
      : {}),
    ...(definition.source_root_scopable_streams
      ? {
          source_root_scopable_streams: Object.freeze([
            ...definition.source_root_scopable_streams,
          ]) as readonly string[],
        }
      : {}),
    ...(definition.enforces_source_roots ? { enforces_source_roots: true } : {}),
  });
}

/**
 * Build the id-keyed bundled-connector registry from injected definitions.
 *
 * This is the runtime's whole knowledge of "which connectors can run": it is
 * empty until a composition root passes definitions in. The published
 * collector's `bin` injects `LOCAL_COLLECTOR_DEFINITIONS` from
 * `@pdpp/polyfill-connectors/collectors`; tests inject their own set.
 */
export function createBundledConnectorRegistry(
  definitions: readonly LocalCollectorDefinition[]
): BundledConnectorRegistry {
  const registry: Record<string, BundledConnectorEntry> = {};
  for (const definition of definitions) {
    if (registry[definition.connector_id]) {
      throw new Error(`duplicate local collector definition for connector_id "${definition.connector_id}"`);
    }
    registry[definition.connector_id] = toBundledEntry(definition);
  }
  return Object.freeze(registry);
}

/** Stable list of connector ids a registry accepts. */
export function bundledConnectorIds(registry: BundledConnectorRegistry): readonly string[] {
  return Object.freeze(Object.keys(registry));
}

/** Lookup helper. Returns null when the id is not in the registry. */
export function getBundledConnectorFrom(
  registry: BundledConnectorRegistry,
  connectorId: string
): BundledConnectorEntry | null {
  return registry[connectorId] ?? null;
}

/**
 * Version each bundled connector reports to the dashboard's
 * `runtime_capabilities` payload.
 *
 * Today every bundled connector tracks the runner package version (single
 * source for the whole bundle, per design §3). Derived from the registry so
 * the map covers exactly the injected ids; the shape stays stable so
 * per-connector versioning can be added later without a payload migration.
 */
export function bundledConnectorVersions(registry: BundledConnectorRegistry): Readonly<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const id of Object.keys(registry)) {
    versions[id] = PROTOCOL_VERSION;
  }
  return Object.freeze(versions);
}
