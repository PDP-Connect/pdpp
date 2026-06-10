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

import { statfs } from "node:fs/promises";

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

// Physical on-disk database footprint (Postgres-only, read-only). Surfaced so
// the operator can reconcile the database's on-disk size against the logical
// retained payload without a `psql` session. Honest about absence: both fields
// are `null` on a SQLite backend or when the size read fails — never a
// fabricated `0`. The relation sizes are an approximate composition; they do
// not sum to `physical_bytes` (shared catalogs, free space, and WAL are not
// attributed per relation).
//
// Spec: openspec/changes/surface-database-physical-footprint/specs/
//       reference-implementation-architecture/spec.md
export interface PhysicalRelationSize {
  readonly bytes: number;
  readonly name: string;
}

export interface PhysicalFootprint {
  // pg_database_size(current_database()); null on SQLite / read failure.
  readonly physical_bytes: number | null;
  // Largest relations by pg_total_relation_size(relid), ordered largest-first
  // and bounded to a small top-N. null/empty on SQLite / read failure.
  readonly top_relations: readonly PhysicalRelationSize[] | null;
}

// Disk headroom for the filesystem that holds the reference data directory.
//
// Measured at startup and on each /_ref/deployment poll. Both fields are
// `null` when the probe fails (e.g. process lacks stat permission, exotic FS)
// — never fabricated. `free_bytes` is the number of bytes available to the
// running process (statvfs f_bavail * f_frsize, not the privileged f_bfree).
//
// Thresholds:
//   < DISK_WARN_BYTES  → warning  (low but probably survivable short-term)
//   < DISK_ERROR_BYTES → error    (restart / build will very likely fail OOD)
//
// Neither threshold triggers automatic data deletion. The operator must act.
export interface DiskHeadroom {
  // Absolute path probed (the filesystem containing the reference data dir).
  readonly path: string;
  // Bytes available to the process on the filesystem hosting `path`.
  readonly free_bytes: number | null;
  // Total bytes on the filesystem (f_blocks * f_frsize). Operator context only.
  readonly total_bytes: number | null;
  // Filesystem identifier from statfs(). Used to deduplicate multi-mount
  // probes that land on the same device. null when statfs() did not expose
  // it (exotic FS, older Node) — falls back to total_bytes heuristic.
  readonly fsid?: number | null;
}

// A single filesystem entry in the disk-headroom report. The shape mirrors
// DiskHeadroom but omits the internal fsid (not meaningful to consumers).
export interface DiskHeadroomEntry {
  readonly path: string;
  readonly free_bytes: number | null;
  readonly total_bytes: number | null;
  // Human-readable label for multi-mount display (e.g. "data", "postgres").
  // Absent when only one filesystem is reported.
  readonly mount_label?: string;
}

// 2 GiB — enough for a full Docker image layer set plus a small WAL burst.
// Below this the reference build/restart will very likely fail OOD.
export const DISK_ERROR_BYTES = 2 * 1024 * 1024 * 1024;

// 5 GiB — comfortable working margin. Warn so the operator can act before
// the error threshold is reached.
export const DISK_WARN_BYTES = 5 * 1024 * 1024 * 1024;

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
  // Physical on-disk database footprint. Optional and pre-computed by the
  // runtime adapter (the pure builder does no I/O). Absent/undefined and an
  // explicit SQLite/failure `{ physical_bytes: null, top_relations: null }`
  // both surface as unmeasured.
  readonly physicalFootprint?: PhysicalFootprint | null;
  readonly runtimeCapabilities?: RuntimeCapabilityPosture | null;
  // Disk headroom for the filesystem hosting the reference data directory.
  // Pre-probed by the runtime adapter. Absent/null = unmeasured.
  readonly diskHeadroom?: DiskHeadroom | null;
  // Disk headroom for the Postgres data mount. Only relevant when the backend
  // is Postgres and the data volume is a different mount from the data dir.
  // Absent/null = unmeasured or not applicable (SQLite, same FS as data dir).
  // The builder deduplicates: if pgDiskHeadroom is on the same filesystem as
  // diskHeadroom (matched by fsid or, as fallback, total_bytes equality), it
  // is silently suppressed.
  readonly pgDiskHeadroom?: DiskHeadroom | null;
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
// Updated: openspec/changes/publish-pdpp-local-collector — collector
// protocol-version surface for `@pdpp/local-collector` compatibility.
export interface CollectorPairing {
  // Bundled connector entrypoint versions advertised by the runner. Today
  // the runner does not yet advertise these per-connector, so this is
  // typically empty. Keyed by connector_id.
  readonly connector_versions: Readonly<Record<string, string>>;
  // True when ANY paired device's protocol version is not in the server's
  // accepted set. Drives the `collector_protocol_outdated` dashboard
  // warning. False when no collector is paired.
  readonly protocol_outdated: boolean;
  // null when no collector has enrolled. "legacy_unknown" when a paired
  // device has no stored protocol version (predates the header). Otherwise
  // the most-recent paired device's protocol version.
  readonly protocol_version: string | "legacy_unknown" | null;
  // The agent/runner version advertised by paired collectors at heartbeat
  // time. Surfaced for visible drift; not enforced by the server.
  readonly runner_version: string | null;
}

export interface RuntimeCapabilityPosture {
  // The server's accepted set of collector protocol versions. Dashboard
  // compares paired-device versions against this list.
  readonly accepted_collector_protocol_versions: readonly string[];
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
  // Per-pairing detail. Null when collector_paired is false.
  readonly collector_pairing: CollectorPairing | null;
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
  | "browser_connectors_need_collector"
  | "collector_protocol_outdated"
  | "low_disk_headroom";

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
    // Read-only physical footprint (Postgres-only). `null` on SQLite or read
    // failure — never a fabricated `0`. Distinct from the logical retained
    // payload (`total_retained_bytes`); never aliased to or summed with it.
    readonly physical_bytes: number | null;
    readonly top_relations: readonly PhysicalRelationSize[] | null;
  };
  // Disk headroom for the filesystems hosting reference data. Ordered:
  // data directory first; Postgres data mount second (when distinct). Empty
  // array when all probes failed. Each entry uses the DiskHeadroomEntry shape
  // (no internal fsid). mount_label is set when more than one distinct FS was
  // measured ("data", "postgres"). free_bytes/total_bytes are null on probe
  // failure for that entry.
  readonly disk_headroom: readonly DiskHeadroomEntry[];
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
    readonly accepted_collector_protocol_versions: readonly string[];
    readonly collector_pairing: CollectorPairing | null;
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

  // Disk headroom: warn when free space is low enough that a restart or
  // Docker build is likely to fail with "No space left on device". Checked
  // for each distinct filesystem entry. Neither threshold triggers automatic
  // deletion — the operator must act.
  //
  // Workload-aware dimension: when free_bytes < largest single relation's
  // on-disk size, a VACUUM FULL or index rebuild of that table would also
  // fail. This is an advisory note appended to the existing threshold copy —
  // not a new standalone threshold — per the heuristics rule (warning-only).
  // Rationale: VACUUM FULL rewrites the entire table to a new heap file before
  // dropping the old one; it needs ~1× the table size as scratch space on the
  // same filesystem. SQLite / absent footprint → silently skip this check.
  const largestRelation =
    Array.isArray(input.physicalFootprint?.top_relations) && input.physicalFootprint!.top_relations!.length > 0
      ? input.physicalFootprint!.top_relations![0]
      : null;

  const diskEntries = normalizeDiskHeadroomEntries(input.diskHeadroom, input.pgDiskHeadroom);
  for (const entry of diskEntries) {
    const freeBytes = entry.free_bytes;
    if (typeof freeBytes !== "number") {
      continue; // probe failed for this mount — no warning
    }
    const pathLabel = entry.path ?? "the data filesystem";
    // Workload-aware suffix: appended when free < largest relation size.
    // Rationale: VACUUM FULL needs ~1× the largest table as scratch space.
    // Degrade silently when footprint is unavailable (SQLite / absent).
    const workloadSuffix =
      largestRelation != null && typeof largestRelation.bytes === "number" && freeBytes < largestRelation.bytes
        ? ` Free space is below the size of your largest table (${largestRelation.name}, ${formatBytes(largestRelation.bytes)}) — maintenance operations like VACUUM FULL may fail.`
        : "";
    if (freeBytes < DISK_ERROR_BYTES) {
      warnings.push({
        code: "low_disk_headroom",
        message:
          `Disk headroom on ${pathLabel} is critically low ` +
          `(${formatBytes(freeBytes)} free). A reference restart or Docker build is very likely to fail ` +
          `with "No space left on device".${workloadSuffix} ` +
          "Run `docker builder prune` or `docker system prune` to reclaim build cache and stopped containers. " +
          "Inspect Docker volumes manually before removing any volume data.",
      });
    } else if (freeBytes < DISK_WARN_BYTES) {
      warnings.push({
        code: "low_disk_headroom",
        message:
          `Disk headroom on ${pathLabel} is low ` +
          `(${formatBytes(freeBytes)} free).${workloadSuffix} Consider running \`docker system prune\` ` +
          "to reclaim build cache before the next restart.",
      });
    }
  }

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
  // A paired collector whose protocol version is outside the server's
  // accepted set will be 409'd at ingest time. This is distinct from the
  // browser_connectors_need_collector warning above: the collector exists
  // but the *protocol* between runner and server is incompatible, not the
  // source data. Phrased to avoid implying captured records are invalid.
  if (posture.collector_pairing?.protocol_outdated) {
    const observed = posture.collector_pairing.protocol_version;
    const observedLabel =
      observed === "legacy_unknown"
        ? "an older version that pre-dates the compatibility header"
        : `version ${observed}`;
    out.push({
      code: "collector_protocol_outdated",
      message:
        `A paired local collector reports ${observedLabel}. ` +
        `This reference server accepts collector protocol version(s) ${posture.accepted_collector_protocol_versions.join(", ") || "(none)"}. ` +
        "Ingest from that collector will be rejected with 409 collector_protocol_mismatch until the collector is upgraded. " +
        "Previously-captured records are unaffected.",
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
      accepted_collector_protocol_versions: [],
      collector_pairing: null,
      in_container: false,
    };
  }
  const accepted = posture.accepted_collector_protocol_versions;
  const pairing = posture.collector_pairing ?? null;
  return {
    bindings: { ...posture.bindings },
    collector_paired: posture.collector_paired,
    accepted_collector_protocol_versions: Array.isArray(accepted) ? [...accepted] : [],
    collector_pairing: pairing
      ? {
          ...pairing,
          connector_versions: { ...(pairing.connector_versions ?? {}) },
        }
      : null,
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

// ─── Physical footprint normalization ──────────────────────────────────────
//
// The runtime adapter pre-computes the footprint (the pure builder does no
// I/O). This collapses the three "unmeasured" inputs — absent/undefined, an
// explicit `{ physical_bytes: null, ... }`, or a non-numeric total — into the
// same honest shape: `physical_bytes: null` with `top_relations: null`. It
// never fabricates a `0`, and it never reports relations against an unknown
// total. When a real total is present, it carries through the bounded
// relation list (defaulting a missing list to `[]`, distinct from the
// unmeasured `null`).

function normalizePhysicalFootprint(footprint: PhysicalFootprint | null | undefined): {
  physical_bytes: number | null;
  top_relations: readonly PhysicalRelationSize[] | null;
} {
  const total = footprint?.physical_bytes;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return { physical_bytes: null, top_relations: null };
  }
  const relations = footprint?.top_relations;
  return {
    physical_bytes: total,
    top_relations: Array.isArray(relations) ? relations : [],
  };
}

// ─── Disk headroom normalization (multi-mount) ─────────────────────────────
//
// Converts one or two raw DiskHeadroom probes into the report's ordered entry
// array. Deduplication: if the data-dir probe and the PG-data probe land on
// the same filesystem (determined by fsid match, or — when fsid is absent —
// by total_bytes equality heuristic), only the data-dir entry is emitted.
// mount_label is added only when two distinct entries are reported ("data"
// for the data dir, "postgres" for the PG volume), so single-FS deployments
// keep the existing terse copy.

function normalizeSingleEntry(h: DiskHeadroom): DiskHeadroomEntry {
  const free = h.free_bytes;
  const total = h.total_bytes;
  return {
    path: h.path,
    free_bytes: typeof free === "number" && Number.isFinite(free) && free >= 0 ? free : null,
    total_bytes: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null,
  };
}

function sameFilesystem(a: DiskHeadroom, b: DiskHeadroom): boolean {
  // Prefer fsid comparison (exact). Fall back to total_bytes equality as a
  // heuristic — two probes returning identical total byte counts are almost
  // certainly on the same device. Both falsy = treat as different (report both
  // rather than silently drop one when we cannot confirm they are the same).
  const aFsid = a.fsid;
  const bFsid = b.fsid;
  if (typeof aFsid === "number" && typeof bFsid === "number") {
    return aFsid === bFsid;
  }
  const aTotal = a.total_bytes;
  const bTotal = b.total_bytes;
  if (typeof aTotal === "number" && aTotal > 0 && typeof bTotal === "number" && bTotal > 0) {
    return aTotal === bTotal;
  }
  return false;
}

function normalizeDiskHeadroomEntries(
  dataDir: DiskHeadroom | null | undefined,
  pgDir: DiskHeadroom | null | undefined
): readonly DiskHeadroomEntry[] {
  const entries: DiskHeadroomEntry[] = [];

  if (!dataDir) {
    // No data-dir probe at all — skip; PG-only is odd but handle it.
    if (pgDir) {
      entries.push({ ...normalizeSingleEntry(pgDir), mount_label: "postgres" });
    }
    return entries;
  }

  const dataNorm = normalizeSingleEntry(dataDir);

  // Decide whether PG is a distinct filesystem.
  const pgDistinct = pgDir != null && !sameFilesystem(dataDir, pgDir);

  if (pgDistinct) {
    // Two distinct filesystems — label both for the UI.
    entries.push({ ...dataNorm, mount_label: "data" });
    entries.push({ ...normalizeSingleEntry(pgDir!), mount_label: "postgres" });
  } else {
    // Single filesystem (or no PG probe) — no label; keeps existing copy terse.
    entries.push(dataNorm);
  }

  return entries;
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

// ─── Disk headroom probe ────────────────────────────────────────────────────
//
// Probes the filesystem hosting `path` using Node's `fs.statfs`. Returns
// `{ free_bytes: null, total_bytes: null }` on any failure rather than
// throwing — the operator page must not fail because of a stat error.
//
// This function does I/O and lives outside the pure builder. The runtime
// adapter calls it and passes the result into `buildDeploymentDiagnostics`
// via `input.diskHeadroom`.

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  }
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

export async function probeDiskHeadroom(dataPath: string): Promise<DiskHeadroom> {
  try {
    const stats = await statfs(dataPath);
    // f_bavail: blocks available to unprivileged processes. More conservative
    // than f_bfree (which includes reserved root blocks) — this is what a
    // running process will actually see when writing.
    const free_bytes = stats.bavail * stats.bsize;
    const total_bytes = stats.blocks * stats.bsize;
    // Node's StatFs object exposes `ffree`/`files` but not `f_fsid` as a
    // single integer (the raw struct has two 32-bit halves). Synthesize a
    // numeric fsid from `stats.type` (OS-assigned FS type magic number) and
    // `total_bytes` — same FS always yields the same pair, which is good
    // enough for deduplication in practice. If `stats.type` is absent
    // (older Node), fall back to null so the heuristic in sameFilesystem()
    // kicks in instead.
    const fsid: number | null =
      typeof (stats as { type?: number }).type === "number"
        ? ((stats as { type: number }).type * 1_000_000_007 + total_bytes) >>> 0
        : null;
    return { path: dataPath, free_bytes, total_bytes, fsid };
  } catch {
    return { path: dataPath, free_bytes: null, total_bytes: null, fsid: null };
  }
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
  readonly computeIndexState: () => SemanticIndexState | Promise<SemanticIndexState>;
  readonly getBackend: () => DiagnosticsBackend | null;
  readonly getBackfillProgress?: () => SemanticBackfillProgress | null;
  readonly getConfiguredNativeManifest: () => DiagnosticsManifest | null;
  readonly getConnectorManifest: (connectorId: string) => Promise<DiagnosticsManifest | null>;
  readonly getDb: () => DiagnosticsDb | null;
  readonly getLexicalBackfillProgress?: () => LexicalBackfillProgress | null;
  // Optional: read-only physical footprint of the database. The adapter calls
  // it and degrades cleanly to unmeasured on absence or rejection — the page
  // never fails because the footprint could not be read.
  readonly getPhysicalFootprint?: () => PhysicalFootprint | Promise<PhysicalFootprint> | null;
  readonly getRuntimeCapabilityPosture?: () => RuntimeCapabilityPosture | Promise<RuntimeCapabilityPosture> | null;
  // Optional: probe disk headroom on the filesystem hosting the data dir. If
  // absent, disk_headroom is null in the report. Typically set to
  // () => probeDiskHeadroom(dbPath) by the server's route handler.
  readonly getDiskHeadroom?: () => DiskHeadroom | Promise<DiskHeadroom> | null;
  // Optional: probe the Postgres data volume's filesystem. Only set when the
  // backend is Postgres and the data volume may be a distinct mount from the
  // data dir (e.g. a dedicated Docker volume). If absent or if it turns out to
  // be the same FS as the data dir, it is silently suppressed in the report.
  // IMPORTANT: inside the reference container the Postgres volume may not be
  // mounted. If the path does not exist, probeDiskHeadroom returns
  // { free_bytes: null, total_bytes: null } — never a false green.
  readonly getPgDiskHeadroom?: () => DiskHeadroom | Promise<DiskHeadroom> | null;
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
  const indexState: SemanticIndexState | null = backend === null ? null : await deps.computeIndexState();

  const runtimeCapabilities = deps.getRuntimeCapabilityPosture
    ? await Promise.resolve(deps.getRuntimeCapabilityPosture())
    : null;

  // Physical footprint is best-effort and read-only. A rejected promise (or a
  // missing dep) degrades to unmeasured rather than failing the whole page;
  // the builder collapses null/undefined to `physical_bytes: null`.
  let physicalFootprint: PhysicalFootprint | null = null;
  if (deps.getPhysicalFootprint) {
    try {
      physicalFootprint = await Promise.resolve(deps.getPhysicalFootprint());
    } catch {
      physicalFootprint = null;
    }
  }

  let diskHeadroom: DiskHeadroom | null = null;
  if (deps.getDiskHeadroom) {
    try {
      diskHeadroom = await Promise.resolve(deps.getDiskHeadroom());
    } catch {
      diskHeadroom = null;
    }
  }

  let pgDiskHeadroom: DiskHeadroom | null = null;
  if (deps.getPgDiskHeadroom) {
    try {
      pgDiskHeadroom = await Promise.resolve(deps.getPgDiskHeadroom());
    } catch {
      pgDiskHeadroom = null;
    }
  }

  return buildDeploymentDiagnostics({
    backend,
    db,
    dbPath: opts.dbPath,
    backfillProgress: deps.getBackfillProgress ? deps.getBackfillProgress() : null,
    lexicalBackfillProgress: deps.getLexicalBackfillProgress ? deps.getLexicalBackfillProgress() : null,
    manifests,
    indexState,
    physicalFootprint,
    runtimeCapabilities,
    diskHeadroom,
    pgDiskHeadroom,
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
      ...normalizePhysicalFootprint(input.physicalFootprint),
    },
    disk_headroom: normalizeDiskHeadroomEntries(input.diskHeadroom, input.pgDiskHeadroom),
    manifests: summarizeManifests(input.manifests),
    environment: buildEnvironmentReport(input.env),
    warnings,
  };
}
