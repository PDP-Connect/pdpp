/**
 * Reference deployment diagnostics.
 *
 * Pure, read-only helper for the operator-facing /dashboard/deployment page.
 * Reports:
 *   - Semantic embedding backend availability, identity, and language bias
 *   - Vector index kind (sqlite-vec vs blob-flat fallback) and index state
 *   - Participating (connector_id, stream, field) tuples computed from
 *     currently-loaded manifests
 *   - Manifest provenance (native vs polyfill-registered)
 *   - DB path (or `:memory:`)
 *   - Redacted view of relevant environment variables
 *   - Explicit warnings for: zero participation, stale index, unavailable
 *     backend, missing model cache, disabled downloads, vector-index fallback
 *
 * This module performs NO writes and does not touch any protocol surface.
 * Spec: openspec/changes/make-semantic-retrieval-operational/specs/
 *       reference-implementation-architecture/spec.md
 */

// Shape of a connector manifest as far as diagnostics care. We do not depend
// on the validator-strict types here — diagnostics must survive partially-
// malformed manifests without crashing the page.
export interface DiagnosticsManifest {
  readonly connector_id?: string;
  readonly display_name?: string;
  readonly streams?: ReadonlyArray<{
    readonly name?: string;
    readonly query?: { readonly search?: { readonly semantic_fields?: readonly string[] } };
  }>;
}

export interface DiagnosticsManifestEntry {
  readonly manifest: DiagnosticsManifest;
  readonly provenance: "native" | "polyfill-registered";
}

// Shape of the configured semantic backend. Mirrors the surface already
// declared in server/search-semantic.js — we only need the identity fields.
export interface DiagnosticsBackend {
  available: () => boolean;
  dimensions: () => number;
  distanceMetric: () => string;
  downloadAllowed?: () => boolean;
  dtype?: () => string;
  languageBias?: () => { primary: string; note?: string } | null;
  model: () => string;
  // Operational backends may optionally report model-cache state.
  modelCachePath?: () => string | null;
  modelCachePresent?: () => boolean;
  profileId?: () => string;
}

export type SemanticIndexState = "built" | "building" | "stale";

export type VectorIndexKind = "sqlite-vec" | "blob-flat";

export interface SemanticBackfillProgress {
  readonly active_jobs: number;
  readonly connector_id: string;
  readonly id: string;
  readonly indexed_vectors: number;
  readonly manifest_streams_checked: number;
  readonly manifest_streams_total: number;
  readonly phase: "planning" | "checking" | "rebuilding" | "cleanup";
  readonly records_scanned: number;
  readonly records_total: number | null;
  readonly started_at: string;
  readonly stream: string | null;
  readonly updated_at: string;
}

export interface LexicalBackfillProgress {
  readonly active_jobs: number;
  readonly connector_id: string;
  readonly id: string;
  readonly indexed_rows: number;
  readonly manifest_streams_checked: number;
  readonly manifest_streams_total: number;
  readonly phase: "planning" | "checking" | "rebuilding" | "cleanup";
  readonly records_scanned: number;
  readonly records_total: number | null;
  readonly started_at: string;
  readonly stream: string | null;
  readonly updated_at: string;
}

// Minimal DB shape used by diagnostics: vectorIndexKind is stamped by
// initDb() in db.js. dbPath is the resolved path passed to initDb().
export interface DiagnosticsDb {
  readonly vectorIndexKind: VectorIndexKind;
}

export interface DiagnosticsEnv {
  readonly [key: string]: string | undefined;
}

export interface DeploymentDiagnosticsInput {
  readonly backend: DiagnosticsBackend | null;
  readonly backfillProgress?: SemanticBackfillProgress | null;
  readonly db: DiagnosticsDb | null;
  readonly dbPath: string;
  readonly env: DiagnosticsEnv;
  readonly indexState: SemanticIndexState | null;
  readonly lexicalBackfillProgress?: LexicalBackfillProgress | null;
  readonly manifests: readonly DiagnosticsManifestEntry[];
  readonly runtimeCapabilities?: RuntimeCapabilityPosture | null;
}

// Runtime capability posture of the provider/control-plane runtime.
//
// This describes which connector runtime bindings (network, browser,
// filesystem, local_device) the provider runtime advertises. Connectors
// declaring required bindings the runtime does not advertise must run in
// a local collector runtime instead. Diagnostics surfaces this so the
// operator can see at a glance whether their deployment is provider-only
// or provider+collector.
//
// Spec: openspec/changes/introduce-local-collector-runner/design.md
export interface RuntimeCapabilityPosture {
  readonly bindings: {
    readonly browser: boolean;
    readonly filesystem: boolean;
    readonly local_device: boolean;
    readonly network: boolean;
  };
  // True iff at least one local collector has heartbeated recently. The
  // runtime adapter resolves this from the device-exporter store; the
  // pure builder treats it as a single boolean.
  readonly collector_paired: boolean;
  // True iff the provider/control-plane runtime is running inside a
  // container (`/.dockerenv` present or PDPP_FORCE_CONTAINER=1).
  readonly in_container: boolean;
}

export interface ParticipationTuple {
  readonly connector_id: string;
  readonly field: string;
  readonly provenance: "native" | "polyfill-registered";
  readonly stream: string;
}

export interface ParticipationSummary {
  readonly connector_count: number;
  readonly field_count: number;
  readonly stream_count: number;
  readonly tuples: readonly ParticipationTuple[];
}

export type DiagnosticsWarningCode =
  | "zero_participation"
  | "lexical_building_index"
  | "building_index"
  | "stale_index"
  | "backend_unavailable"
  | "missing_model_cache"
  | "download_disabled"
  | "vector_index_fallback"
  | "browser_connectors_need_collector";

export interface DiagnosticsWarning {
  readonly code: DiagnosticsWarningCode;
  readonly message: string;
}

export type EnvValueProvenance = "present" | "absent" | "redacted";

export interface EnvValueReport {
  readonly name: string;
  readonly provenance: EnvValueProvenance;
  readonly secret: boolean;
  readonly value: string | null;
}

export interface DeploymentDiagnosticsReport {
  readonly database: {
    readonly path: string;
  };
  readonly environment: readonly EnvValueReport[];
  readonly lexical: {
    readonly index: {
      readonly state: "built" | "building";
      readonly backfill_progress: LexicalBackfillProgress | null;
    };
  };
  readonly manifests: ReadonlyArray<{
    readonly connector_id: string;
    readonly display_name: string | null;
    readonly provenance: "native" | "polyfill-registered";
    readonly semantic_stream_count: number;
  }>;
  readonly runtime_capabilities: {
    readonly bindings: {
      readonly browser: boolean;
      readonly filesystem: boolean;
      readonly local_device: boolean;
      readonly network: boolean;
    };
    readonly collector_paired: boolean;
    readonly in_container: boolean;
  };
  readonly semantic: {
    readonly backend: {
      readonly configured: boolean;
      readonly available: boolean;
      readonly profile_id: string | null;
      readonly model: string | null;
      readonly dtype: string | null;
      readonly dimensions: number | null;
      readonly distance_metric: string | null;
      readonly language_bias: { primary: string; note?: string } | null;
      readonly model_cache_path: string | null;
      readonly model_cache_present: boolean | null;
      readonly download_allowed: boolean | null;
    };
    readonly index: {
      readonly kind: VectorIndexKind | null;
      readonly state: SemanticIndexState | null;
      readonly backfill_progress: SemanticBackfillProgress | null;
    };
    readonly participation: ParticipationSummary;
  };
  readonly warnings: readonly DiagnosticsWarning[];
}

// ─── Env redaction ──────────────────────────────────────────────────────────
//
// The dashboard shows a curated list of env vars that shape reference
// behavior. The list is conservative; anything matching a secret-ish name
// pattern is redacted even if it is also on the allowlist. New vars must
// be added here explicitly — an allowlist is safer than a blocklist for
// a surface that renders to HTML.

const ENV_ALLOWLIST: ReadonlyArray<{ readonly name: string; readonly secret?: boolean }> = [
  { name: "AS_PORT" },
  { name: "RS_PORT" },
  { name: "AS_PUBLIC_URL" },
  { name: "RS_PUBLIC_URL" },
  { name: "AS_ISSUER" },
  { name: "PDPP_DB_PATH" },
  { name: "DB_PATH" },
  { name: "PDPP_PROVIDER_NAME" },
  { name: "PDPP_PROVIDER_CONNECT_VERSION" },
  { name: "PDPP_REFERENCE_MODE" },
  { name: "PDPP_REFERENCE_ORIGIN" },
  { name: "PDPP_REFERENCE_OPERATIONAL_DEFAULTS" },
  { name: "PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION" },
  { name: "PDPP_RECONCILE_POLYFILL_MANIFESTS" },
  { name: "PDPP_OWNER_PASSWORD", secret: true },
  { name: "PDPP_SEMANTIC_EMBEDDING_BACKEND" },
  { name: "PDPP_EMBEDDING_PROFILE_ID" },
  { name: "PDPP_EMBEDDING_MODEL_ID" },
  { name: "PDPP_EMBEDDING_DTYPE" },
  { name: "PDPP_EMBEDDING_DIMENSIONS" },
  { name: "PDPP_EMBEDDING_DISTANCE_METRIC" },
  { name: "PDPP_EMBEDDING_CACHE_DIR" },
  { name: "PDPP_EMBEDDING_DOWNLOAD_ALLOWED" },
  { name: "PDPP_DCR_INITIAL_ACCESS_TOKENS", secret: true },
  { name: "PDPP_FORCE_CONTAINER" },
  { name: "PDPP_ALLOW_HEADED_CONTAINER_BROWSER" },
  { name: "NODE_ENV" },
];

const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|KEY|CRED|COOKIE|PRIVATE)/i;

export function buildEnvironmentReport(env: DiagnosticsEnv): readonly EnvValueReport[] {
  return ENV_ALLOWLIST.map((entry): EnvValueReport => {
    const raw = env[entry.name];
    if (raw === undefined || raw === "") {
      return { name: entry.name, value: null, provenance: "absent", secret: Boolean(entry.secret) };
    }
    const isSecret = Boolean(entry.secret) || SECRET_NAME_RE.test(entry.name);
    if (isSecret) {
      return { name: entry.name, value: null, provenance: "redacted", secret: true };
    }
    return { name: entry.name, value: raw, provenance: "present", secret: false };
  });
}

// ─── Participation computation ─────────────────────────────────────────────

function collectSemanticFields(stream: {
  name?: string;
  query?: { search?: { semantic_fields?: readonly string[] } };
}): readonly string[] {
  const declared = stream?.query?.search?.semantic_fields;
  if (!Array.isArray(declared)) {
    return [];
  }
  // Defensive: accept only non-empty strings. Validator enforces this at
  // registration time, but diagnostics should survive a stale/broken row.
  return declared.filter((f): f is string => typeof f === "string" && f.length > 0);
}

export function computeParticipation(manifests: readonly DiagnosticsManifestEntry[]): ParticipationSummary {
  const tuples: ParticipationTuple[] = [];
  const connectors = new Set<string>();
  const streams = new Set<string>();
  for (const entry of manifests) {
    const connectorId = entry.manifest?.connector_id;
    if (typeof connectorId !== "string" || connectorId.length === 0) {
      continue;
    }
    const manifestStreams = entry.manifest?.streams;
    if (!Array.isArray(manifestStreams)) {
      continue;
    }
    for (const stream of manifestStreams) {
      const streamName = stream?.name;
      if (typeof streamName !== "string" || streamName.length === 0) {
        continue;
      }
      const fields = collectSemanticFields(stream);
      if (fields.length === 0) {
        continue;
      }
      connectors.add(connectorId);
      streams.add(`${connectorId}::${streamName}`);
      for (const field of fields) {
        tuples.push({
          connector_id: connectorId,
          stream: streamName,
          field,
          provenance: entry.provenance,
        });
      }
    }
  }
  // Sort for stable rendering and deterministic tests.
  tuples.sort((a, b) => {
    if (a.connector_id !== b.connector_id) {
      return a.connector_id < b.connector_id ? -1 : 1;
    }
    if (a.stream !== b.stream) {
      return a.stream < b.stream ? -1 : 1;
    }
    if (a.field !== b.field) {
      return a.field < b.field ? -1 : 1;
    }
    return 0;
  });
  return {
    connector_count: connectors.size,
    stream_count: streams.size,
    field_count: tuples.length,
    tuples,
  };
}

// ─── Warnings ──────────────────────────────────────────────────────────────

function buildWarnings(
  input: DeploymentDiagnosticsInput,
  participation: ParticipationSummary,
  backendAvailable: boolean
): readonly DiagnosticsWarning[] {
  const warnings: DiagnosticsWarning[] = [];

  // Backend unavailability is the highest-impact condition: semantic
  // retrieval cannot embed without a working backend. Reported whether or
  // not anything participates, because an operator staring at zero hits
  // needs to know the backend is the reason.
  if (input.backend === null) {
    warnings.push({
      code: "backend_unavailable",
      message:
        "No embedding backend configured. Semantic retrieval is disabled; no semantic advertisement will be published.",
    });
  } else if (!backendAvailable) {
    warnings.push({
      code: "backend_unavailable",
      message:
        "Embedding backend is configured but reports itself unavailable (e.g. model download failed or cache missing). Semantic retrieval will not be advertised.",
    });
  }

  // Zero participation is reported SEPARATELY from backend/index readiness.
  // A ready backend + built index + zero participating streams means
  // operators will see empty semantic results and not understand why.
  if (participation.field_count === 0) {
    warnings.push({
      code: "zero_participation",
      message:
        "No loaded stream declares query.search.semantic_fields. Semantic backend and index may be ready, but the corpus has zero semantic coverage.",
    });
  }

  if (input.lexicalBackfillProgress) {
    warnings.push({
      code: "lexical_building_index",
      message:
        "Lexical index rebuild is running in the background. Text search remains available, but results may be partial until indexing completes.",
    });
  }

  if (input.indexState === "building") {
    warnings.push({
      code: "building_index",
      message:
        "Semantic index rebuild is running in the background. Semantic search remains available, but results may be partial until indexing completes.",
    });
  }

  if (input.indexState === "stale") {
    warnings.push({
      code: "stale_index",
      message:
        "Semantic index is stale. The embedding profile or declared fields changed; rebuild will run at next startup or write.",
    });
  }

  if (input.db && input.db.vectorIndexKind === "blob-flat") {
    warnings.push({
      code: "vector_index_fallback",
      message: "sqlite-vec extension did not load; using the blob-flat fallback. Correct but slower at large N.",
    });
  }

  // Runtime capability posture warnings. We warn when the
  // provider/control-plane runtime is in a container (cannot render a
  // visible browser) AND no local collector is paired — that means
  // browser-backed connectors will fail closed at spawn time.
  warnings.push(...buildRuntimeCapabilityWarnings(input.runtimeCapabilities ?? null));

  // Backend-specific cache/download warnings. Only surfaced when the
  // backend reports these fields — the stub backend does not.
  if (input.backend?.modelCachePresent && input.backend.modelCachePresent() === false) {
    warnings.push({
      code: "missing_model_cache",
      message: "Configured embedding model is not present in the local cache. First use will require a download.",
    });
  }
  if (input.backend?.downloadAllowed && input.backend.downloadAllowed() === false) {
    const cachePresent = input.backend.modelCachePresent ? input.backend.modelCachePresent() : null;
    if (cachePresent === false) {
      warnings.push({
        code: "download_disabled",
        message:
          "Model download is disabled and no cached model is available. Semantic backend will stay unavailable until a model is cached or downloads are re-enabled.",
      });
    }
  }

  return warnings;
}

function buildRuntimeCapabilityWarnings(posture: RuntimeCapabilityPosture | null): readonly DiagnosticsWarning[] {
  if (!posture) {
    return [];
  }
  const out: DiagnosticsWarning[] = [];
  // Warn when the provider runtime cannot render a visible browser AND
  // no collector is paired. A connector requiring a `browser` binding in
  // this state will fail closed at spawn time.
  if (posture.in_container && !posture.bindings.browser && !posture.collector_paired) {
    out.push({
      code: "browser_connectors_need_collector",
      message:
        "Provider/control-plane runtime is containerized and does not advertise a browser binding; " +
        "no local collector is paired. Browser-backed connectors will fail before spawn until a collector is enrolled. " +
        "See `bin/collector-runner.ts` and `openspec/changes/introduce-local-collector-runner`.",
    });
  }
  return out;
}

function buildRuntimeCapabilityReport(
  posture: RuntimeCapabilityPosture | null
): DeploymentDiagnosticsReport["runtime_capabilities"] {
  if (!posture) {
    return {
      bindings: { browser: false, filesystem: false, local_device: false, network: true },
      collector_paired: false,
      in_container: false,
    };
  }
  return {
    bindings: { ...posture.bindings },
    collector_paired: posture.collector_paired,
    in_container: posture.in_container,
  };
}

// ─── Top-level report builder ──────────────────────────────────────────────

function summarizeManifests(manifests: readonly DiagnosticsManifestEntry[]): DeploymentDiagnosticsReport["manifests"] {
  return manifests
    .filter((entry) => typeof entry.manifest?.connector_id === "string")
    .map((entry) => {
      const streams = Array.isArray(entry.manifest.streams) ? entry.manifest.streams : [];
      let semanticStreamCount = 0;
      for (const stream of streams) {
        if (collectSemanticFields(stream).length > 0) {
          semanticStreamCount += 1;
        }
      }
      return {
        connector_id: entry.manifest.connector_id ?? "",
        display_name: entry.manifest.display_name ?? null,
        provenance: entry.provenance,
        semantic_stream_count: semanticStreamCount,
      };
    });
}

// ─── Blended-search gating decision ────────────────────────────────────────
//
// The dashboard's blended search attempts a semantic uplift only when
// the RS advertises semantic retrieval AND at least one (connector, stream,
// field) tuple participates. A ready backend with zero participation yields
// zero hits and looks identical to "semantic retrieval is broken", so we
// skip the call and let /dashboard/deployment surface the reason.
//
// Pure function; lives here (not on the web side) so Node tests that run
// against the reference package can pin this invariant directly.

export interface SemanticUpliftGate {
  readonly advertised: boolean;
  readonly participationFieldCount: number;
}

export function shouldAttemptSemanticUplift(gate: SemanticUpliftGate): boolean {
  return gate.advertised && gate.participationFieldCount > 0;
}

// ─── Runtime adapter ───────────────────────────────────────────────────────
//
// Collects live inputs from the server's module globals (semantic backend,
// DB handle, manifest registry, process.env) and returns the diagnostics
// report. Callers that need reproducible inputs should invoke
// buildDeploymentDiagnostics directly with the fields they control.

export interface CollectDeploymentDiagnosticsOptions {
  readonly dbPath: string;
  readonly env?: DiagnosticsEnv;
}

export interface DeploymentDiagnosticsRuntimeDeps {
  readonly computeIndexState: () => SemanticIndexState;
  readonly getBackend: () => DiagnosticsBackend | null;
  readonly getBackfillProgress?: () => SemanticBackfillProgress | null;
  readonly getConfiguredNativeManifest: () => DiagnosticsManifest | null;
  readonly getConnectorManifest: (connectorId: string) => Promise<DiagnosticsManifest | null>;
  readonly getDb: () => DiagnosticsDb | null;
  readonly getLexicalBackfillProgress?: () => LexicalBackfillProgress | null;
  readonly getRuntimeCapabilityPosture?: () => RuntimeCapabilityPosture | Promise<RuntimeCapabilityPosture> | null;
  readonly listRegisteredConnectorIds: () => Promise<readonly string[]>;
}

export async function collectDeploymentDiagnostics(
  deps: DeploymentDiagnosticsRuntimeDeps,
  opts: CollectDeploymentDiagnosticsOptions
): Promise<DeploymentDiagnosticsReport> {
  const backend = deps.getBackend();
  const db = deps.getDb();
  const env = opts.env ?? (process.env as DiagnosticsEnv);

  const manifests: DiagnosticsManifestEntry[] = [];
  const native = deps.getConfiguredNativeManifest();
  if (native) {
    manifests.push({ manifest: native, provenance: "native" });
  } else {
    const connectorIds = await deps.listRegisteredConnectorIds();
    for (const connectorId of connectorIds) {
      let manifest: DiagnosticsManifest | null = null;
      try {
        manifest = await deps.getConnectorManifest(connectorId);
      } catch {
        // Corrupt persisted manifest — skip rather than blow up the page.
        continue;
      }
      if (manifest) {
        manifests.push({ manifest, provenance: "polyfill-registered" });
      }
    }
  }

  // Index state is only meaningful when a backend is configured.
  const indexState: SemanticIndexState | null = backend === null ? null : deps.computeIndexState();

  const runtimeCapabilities = deps.getRuntimeCapabilityPosture
    ? await Promise.resolve(deps.getRuntimeCapabilityPosture())
    : null;

  return buildDeploymentDiagnostics({
    backend,
    db,
    dbPath: opts.dbPath,
    backfillProgress: deps.getBackfillProgress ? deps.getBackfillProgress() : null,
    lexicalBackfillProgress: deps.getLexicalBackfillProgress ? deps.getLexicalBackfillProgress() : null,
    manifests,
    indexState,
    runtimeCapabilities,
    env,
  });
}

export function buildDeploymentDiagnostics(input: DeploymentDiagnosticsInput): DeploymentDiagnosticsReport {
  // Note: `input.backend?.available() ?? false` would conflate "no backend"
  // with "backend reported unavailable"; keep them distinct because the
  // warnings table distinguishes the two.
  const backendAvailable = input.backend === null ? false : input.backend.available();
  const participation = computeParticipation(input.manifests);
  const warnings = buildWarnings(input, participation, backendAvailable);

  return {
    runtime_capabilities: buildRuntimeCapabilityReport(input.runtimeCapabilities ?? null),
    lexical: {
      index: {
        state: input.lexicalBackfillProgress ? "building" : "built",
        backfill_progress: input.lexicalBackfillProgress ?? null,
      },
    },
    semantic: {
      backend: {
        configured: input.backend !== null,
        available: backendAvailable,
        profile_id: input.backend?.profileId ? input.backend.profileId() : null,
        model: input.backend ? input.backend.model() : null,
        dtype: input.backend?.dtype ? input.backend.dtype() : null,
        dimensions: input.backend ? input.backend.dimensions() : null,
        distance_metric: input.backend ? input.backend.distanceMetric() : null,
        language_bias: input.backend?.languageBias ? input.backend.languageBias() : null,
        model_cache_path: input.backend?.modelCachePath ? input.backend.modelCachePath() : null,
        model_cache_present: input.backend?.modelCachePresent ? input.backend.modelCachePresent() : null,
        download_allowed: input.backend?.downloadAllowed ? input.backend.downloadAllowed() : null,
      },
      index: {
        kind: input.db ? input.db.vectorIndexKind : null,
        state: input.indexState,
        backfill_progress: input.backfillProgress ?? null,
      },
      participation,
    },
    database: {
      path: input.dbPath,
    },
    manifests: summarizeManifests(input.manifests),
    environment: buildEnvironmentReport(input.env),
    warnings,
  };
}
