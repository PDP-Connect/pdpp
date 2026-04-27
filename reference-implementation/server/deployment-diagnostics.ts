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
  readonly hostBrowserBridge?: HostBrowserBridgePostureInput | null;
  readonly indexState: SemanticIndexState | null;
  readonly lexicalBackfillProgress?: LexicalBackfillProgress | null;
  readonly manifests: readonly DiagnosticsManifestEntry[];
}

// Container-side host-browser bridge posture, derived from env and an
// optional cheap reachability probe. The runtime adapter resolves these
// inputs; the pure builder only formats and warns.
//
// We intentionally do NOT take the raw token here. Diagnostics receives
// only "token configured yes/no" so the redacted token can never be
// re-assembled out of this report.
//
// Spec: openspec/changes/design-host-browser-bridge-for-docker/design.md
export interface HostBrowserBridgePostureInput {
  // Operator opted into "drive my real Chrome" by setting
  // PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME=1.
  readonly dailyChromeAcknowledged: boolean;
  // Reason from the bridge config resolver when `mode === "misconfigured"`.
  readonly misconfiguredReason: string | null;
  // From resolveHostBrowserBridgeConfig() — three-state; `disabled` means
  // PDPP_HOST_BROWSER_BRIDGE_URL is unset.
  readonly mode: "disabled" | "configured" | "misconfigured";
  // Optional cheap reachability probe. The probe is HTTP GET against
  // the bridge URL's host:port — the bridge serves a small status string
  // for plain HTTP requests (see bin/host-browser-bridge.ts), which is
  // exactly the cheap probe path the spec calls out.
  // `not_checked` is the honest answer when probing is disabled or the
  // mode is `disabled`/`misconfigured` (no point probing a URL we know
  // is wrong).
  readonly reachability:
    | { readonly status: "not_checked"; readonly reason: string }
    | { readonly status: "ok" }
    | { readonly status: "unreachable"; readonly reason: string };
  // True iff PDPP_HOST_BROWSER_BRIDGE_TOKEN was non-empty after trim.
  // The raw token MUST NOT cross this boundary.
  readonly tokenConfigured: boolean;
  // The configured WS URL when the operator set it. Even in the
  // `misconfigured` case we surface the value the operator typed so they
  // can see what's wrong. Never includes the token.
  readonly url: string | null;
}

export interface HostBrowserBridgePostureReport {
  readonly daily_chrome_acknowledged: boolean;
  readonly misconfigured_reason: string | null;
  readonly mode: HostBrowserBridgePostureInput["mode"];
  readonly reachability:
    | { readonly status: "not_checked"; readonly reason: string }
    | { readonly status: "ok" }
    | { readonly status: "unreachable"; readonly reason: string };
  readonly token_configured: boolean;
  readonly url: string | null;
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
  | "host_browser_bridge_misconfigured"
  | "host_browser_bridge_unreachable"
  | "host_browser_bridge_daily_chrome";

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
  readonly host_browser_bridge: HostBrowserBridgePostureReport;
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
  { name: "PDPP_HOST_BROWSER_BRIDGE_URL" },
  { name: "PDPP_HOST_BROWSER_BRIDGE_TOKEN", secret: true },
  { name: "PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME" },
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

  // Host-browser bridge posture warnings. The bridge is opt-in, so an
  // unconfigured bridge is not itself a warning — operators who do not
  // run browser-backed connectors in Docker should see no noise.
  warnings.push(...buildBridgeWarnings(input.hostBrowserBridge ?? null));

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

function buildBridgeWarnings(bridge: HostBrowserBridgePostureInput | null): readonly DiagnosticsWarning[] {
  if (!bridge) {
    return [];
  }
  const out: DiagnosticsWarning[] = [];
  if (bridge.mode === "misconfigured") {
    out.push({
      code: "host_browser_bridge_misconfigured",
      message: bridge.misconfiguredReason
        ? `Host browser bridge is misconfigured: ${bridge.misconfiguredReason}`
        : "Host browser bridge is misconfigured.",
    });
  }
  if (bridge.mode === "configured" && bridge.reachability.status === "unreachable") {
    out.push({
      code: "host_browser_bridge_unreachable",
      message:
        `Host browser bridge configured but unreachable at ${bridge.url ?? "(unknown)"}: ${bridge.reachability.reason}. ` +
        "Browser-backed connector runs will fail with host_browser_bridge_unavailable until the bridge is started on the host.",
    });
  }
  if (bridge.mode === "configured" && bridge.dailyChromeAcknowledged) {
    out.push({
      code: "host_browser_bridge_daily_chrome",
      message:
        "PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME is set. The bridge is allowed to drive the operator's daily Chrome profile, " +
        "which broadens the trust boundary. Disable it unless you are debugging a one-off bootstrap.",
    });
  }
  return out;
}

// ─── Host-browser bridge posture ───────────────────────────────────────────
//
// Pure formatter: takes the resolved input (env-derived plus optional
// reachability probe) and returns the report shape the dashboard renders.
// The token never crosses this boundary in raw form.

function buildHostBrowserBridgeReport(input: HostBrowserBridgePostureInput | null): HostBrowserBridgePostureReport {
  if (!input) {
    return {
      mode: "disabled",
      url: null,
      token_configured: false,
      daily_chrome_acknowledged: false,
      misconfigured_reason: null,
      reachability: {
        status: "not_checked",
        reason: "host browser bridge posture not collected",
      },
    };
  }
  return {
    mode: input.mode,
    url: input.url,
    token_configured: input.tokenConfigured,
    daily_chrome_acknowledged: input.dailyChromeAcknowledged,
    misconfigured_reason: input.misconfiguredReason,
    reachability: input.reachability,
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
  // Per-probe timeout. Defaults to ~750ms — short enough that a stalled
  // probe cannot block the operator-facing page.
  readonly hostBrowserBridgeProbeTimeoutMs?: number;
  // When false, skip the cheap reachability probe and report
  // `not_checked`. Useful in tests so we never reach a real socket.
  // Defaults to true.
  readonly probeHostBrowserBridge?: boolean;
}

export interface DeploymentDiagnosticsRuntimeDeps {
  readonly computeIndexState: () => SemanticIndexState;
  readonly getBackend: () => DiagnosticsBackend | null;
  readonly getBackfillProgress?: () => SemanticBackfillProgress | null;
  readonly getConfiguredNativeManifest: () => DiagnosticsManifest | null;
  readonly getConnectorManifest: (connectorId: string) => Promise<DiagnosticsManifest | null>;
  readonly getDb: () => DiagnosticsDb | null;
  readonly getLexicalBackfillProgress?: () => LexicalBackfillProgress | null;
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

  const hostBrowserBridge = await collectHostBrowserBridgePosture(env, {
    probe: opts.probeHostBrowserBridge !== false,
    timeoutMs: opts.hostBrowserBridgeProbeTimeoutMs ?? 750,
  });

  return buildDeploymentDiagnostics({
    backend,
    db,
    dbPath: opts.dbPath,
    backfillProgress: deps.getBackfillProgress ? deps.getBackfillProgress() : null,
    lexicalBackfillProgress: deps.getLexicalBackfillProgress ? deps.getLexicalBackfillProgress() : null,
    manifests,
    indexState,
    hostBrowserBridge,
    env,
  });
}

// ─── Host browser bridge runtime collector ────────────────────────────────
//
// Mirrors the parsing rules in
// packages/polyfill-connectors/src/host-browser-bridge-config.ts. The
// runtime contract belongs to that file; we re-parse here so this module
// stays inside the reference-implementation tsconfig graph and does not
// require a workspace dependency on @pdpp/polyfill-connectors. The two
// readers MUST stay in sync.

const BRIDGE_URL_RE = /^wss?:\/\/[^\s]+$/i;
const URL_VAR = "PDPP_HOST_BROWSER_BRIDGE_URL";
const TOKEN_VAR = "PDPP_HOST_BROWSER_BRIDGE_TOKEN";
const DAILY_CHROME_VAR = "PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME";

function readNonEmpty(env: DiagnosticsEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function collectHostBrowserBridgePosture(
  env: DiagnosticsEnv,
  options: { probe: boolean; timeoutMs: number }
): Promise<HostBrowserBridgePostureInput> {
  const url = readNonEmpty(env, URL_VAR) ?? null;
  const token = readNonEmpty(env, TOKEN_VAR);
  const tokenConfigured = token !== undefined;
  const dailyChromeAcknowledged = readNonEmpty(env, DAILY_CHROME_VAR) === "1";

  if (!url) {
    if (tokenConfigured || readNonEmpty(env, DAILY_CHROME_VAR) !== undefined) {
      return {
        mode: "misconfigured",
        url: null,
        tokenConfigured,
        dailyChromeAcknowledged,
        misconfiguredReason: `${TOKEN_VAR} or ${DAILY_CHROME_VAR} is set but ${URL_VAR} is empty; either set ${URL_VAR} or unset the others.`,
        reachability: {
          status: "not_checked",
          reason: "Skipped because the bridge config is invalid.",
        },
      };
    }
    return {
      mode: "disabled",
      url: null,
      tokenConfigured: false,
      dailyChromeAcknowledged,
      misconfiguredReason: null,
      reachability: {
        status: "not_checked",
        reason: `${URL_VAR} is not set; bridge is opt-in.`,
      },
    };
  }

  if (!BRIDGE_URL_RE.test(url)) {
    return {
      mode: "misconfigured",
      url,
      tokenConfigured,
      dailyChromeAcknowledged,
      misconfiguredReason: `${URL_VAR}=${url} must be a ws:// or wss:// URL.`,
      reachability: {
        status: "not_checked",
        reason: "Skipped because the bridge URL is invalid.",
      },
    };
  }

  if (!tokenConfigured) {
    return {
      mode: "misconfigured",
      url,
      tokenConfigured: false,
      dailyChromeAcknowledged,
      misconfiguredReason: `${URL_VAR} is set but ${TOKEN_VAR} is empty; refusing to connect unauthenticated.`,
      reachability: {
        status: "not_checked",
        reason: "Skipped because no token is configured.",
      },
    };
  }

  const reachability = options.probe
    ? await probeHostBrowserBridge(url, options.timeoutMs)
    : {
        status: "not_checked" as const,
        reason: "Reachability probe disabled by caller.",
      };

  return {
    mode: "configured",
    url,
    tokenConfigured: true,
    dailyChromeAcknowledged,
    misconfiguredReason: null,
    reachability,
  };
}

// Cheap probe: HTTP GET against the WS URL's host:port. The bridge's
// HTTP layer responds with a small status string for non-upgrade
// requests (see bin/host-browser-bridge.ts). Returns `unreachable` on
// connect/timeout/HTTP error, otherwise `ok`. Never sends the token.
async function probeHostBrowserBridge(
  wsUrl: string,
  timeoutMs: number
): Promise<HostBrowserBridgePostureInput["reachability"]> {
  let httpUrl: URL;
  try {
    httpUrl = new URL(wsUrl);
  } catch (err) {
    return { status: "unreachable", reason: `invalid URL: ${describeError(err)}` };
  }
  // ws → http, wss → https. Anything else has already been rejected by
  // resolveHostBrowserBridgeConfig, but be defensive.
  if (httpUrl.protocol === "ws:") {
    httpUrl.protocol = "http:";
  } else if (httpUrl.protocol === "wss:") {
    httpUrl.protocol = "https:";
  } else {
    return { status: "unreachable", reason: `unsupported protocol ${httpUrl.protocol}` };
  }
  // Discard any path/query — we only probe the bridge's root.
  httpUrl.pathname = "/";
  httpUrl.search = "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(httpUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      // The bridge does not require auth on the plain HTTP path — it is
      // the WS upgrade that requires the token. We send no headers.
    });
    if (!resp.ok) {
      return { status: "unreachable", reason: `HTTP ${resp.status}` };
    }
    return { status: "ok" };
  } catch (err) {
    return { status: "unreachable", reason: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "probe timed out";
    }
    return err.message || err.name;
  }
  return String(err);
}

export function buildDeploymentDiagnostics(input: DeploymentDiagnosticsInput): DeploymentDiagnosticsReport {
  // Note: `input.backend?.available() ?? false` would conflate "no backend"
  // with "backend reported unavailable"; keep them distinct because the
  // warnings table distinguishes the two.
  const backendAvailable = input.backend === null ? false : input.backend.available();
  const participation = computeParticipation(input.manifests);
  const warnings = buildWarnings(input, participation, backendAvailable);

  return {
    host_browser_bridge: buildHostBrowserBridgeReport(input.hostBrowserBridge ?? null),
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
