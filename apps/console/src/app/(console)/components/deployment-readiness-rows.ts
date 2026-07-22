// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure row-derivation logic for the deployment readiness panel. Lives in a
 * .ts (not .tsx) sibling so the row computations are importable from
 * node:test without a JSX loader.
 *
 * Spec: openspec/changes/archive/2026-05-28-add-selfhost-onboarding-slvp/design.md
 */
import type { DeploymentDiagnostics } from "../lib/ref-client.ts";

export type ReadinessStatus = "ok" | "warn" | "error" | "info" | "unknown";

export interface ReadinessRow {
  check: string;
  detail: string;
  hint?: string;
  status: ReadinessStatus;
}

export interface DiskHeadroomInputs {
  freeBytesOnDataFs: number | null;
  // Bytes of the largest single relation on this filesystem (from
  // top_relations[0].bytes when available). Used for the workload-aware hint:
  // when free < largestRelationBytes, VACUUM FULL of that table may fail.
  // null when the backend is SQLite or the footprint is unavailable.
  largestRelationBytes: number | null;
  // Display name of the largest relation (e.g. "records"). null when unknown.
  largestRelationName: string | null;
  // Human-readable filesystem label (e.g. "data", "postgres"). null when only
  // one mount is reported (keeps copy terse for single-FS deployments).
  mountLabel: string | null;
  path: string | null;
  totalBytesOnDataFs: number | null;
}

export interface ServerInputs {
  databasePath: string;
  // One entry per distinct probed filesystem. Empty array when no probe ran
  // or all probes failed. Replaces the previous singular `DiskHeadroomInputs|null`.
  diskHeadroom: DiskHeadroomInputs[];
  embeddingBackendAvailable: boolean;
  embeddingBackendConfigured: boolean;
  embeddingDownloadAllowed: boolean | null;
  embeddingModelCachePresent: boolean | null;
  ownerPasswordProvenance: "absent" | "present" | "redacted";
  referenceOriginConfigured: string | null;
  vectorIndexKind: DeploymentDiagnostics["semantic"]["index"]["kind"];
  vectorIndexState: DeploymentDiagnostics["semantic"]["index"]["state"];
}

export type RefreshTokenProbe =
  | { state: "loading" }
  | { state: "unreachable" }
  | { state: "loaded"; refreshTokenSupported: boolean };

export type Verdict = "ready" | "attention" | "blocked" | "unknown";

export function extractReadinessInputs(report: DeploymentDiagnostics): ServerInputs {
  const envByName = new Map(report.environment.map((e) => [e.name, e]));
  const owner = envByName.get("PDPP_OWNER_PASSWORD");
  const origin = envByName.get("PDPP_REFERENCE_ORIGIN");
  // Workload context: the largest relation is the first entry in top_relations
  // (ordered by size descending). Only available when the backend is Postgres
  // and the footprint has been measured. The data dir and PG mount share the
  // same relation sizes because they are both on the Postgres FS.
  const largestRelation = report.database.top_relations?.[0] ?? null;
  const dhEntries = report.disk_headroom ?? [];
  return {
    databasePath: report.database.path,
    diskHeadroom: dhEntries.map((dh) => ({
      freeBytesOnDataFs: dh.free_bytes,
      largestRelationBytes: largestRelation?.bytes ?? null,
      largestRelationName: largestRelation?.name ?? null,
      mountLabel: dh.mount_label ?? null,
      path: dh.path,
      totalBytesOnDataFs: dh.total_bytes,
    })),
    embeddingBackendAvailable: report.semantic.backend.available,
    embeddingBackendConfigured: report.semantic.backend.configured,
    embeddingDownloadAllowed: report.semantic.backend.download_allowed,
    embeddingModelCachePresent: report.semantic.backend.model_cache_present,
    ownerPasswordProvenance: owner?.provenance ?? "absent",
    referenceOriginConfigured: origin?.provenance === "present" ? origin.value : null,
    vectorIndexKind: report.semantic.index.kind,
    vectorIndexState: report.semantic.index.state,
  };
}

export function ownerPasswordRow(inputs: ServerInputs): ReadinessRow {
  if (inputs.ownerPasswordProvenance === "redacted") {
    return {
      check: "Owner password gate",
      detail: "PDPP_OWNER_PASSWORD is set; owner surfaces require sign-in.",
      status: "ok",
    };
  }
  return {
    check: "Owner password gate",
    detail: "PDPP_OWNER_PASSWORD is not set.",
    hint: "Set `PDPP_OWNER_PASSWORD` in your env and restart; otherwise `/owner`, `/device`, `/consent`, and `/` are reachable without auth.",
    status: "error",
  };
}

export function referenceOriginRow(inputs: ServerInputs, browserOrigin: string | null): ReadinessRow {
  if (!inputs.referenceOriginConfigured) {
    return {
      check: "Reference origin alignment",
      detail:
        "PDPP_REFERENCE_ORIGIN is not set. The deployment will infer the origin from request headers, which is brittle behind proxies.",
      hint: "Set `PDPP_REFERENCE_ORIGIN` to the URL you are visiting (e.g. `https://<podid>-3002.proxy.runpod.net`). Mismatches break the MCP and OAuth callback flows.",
      status: "warn",
    };
  }
  if (browserOrigin === null) {
    return {
      check: "Reference origin alignment",
      detail: `PDPP_REFERENCE_ORIGIN=${inputs.referenceOriginConfigured}. Browser origin not yet observed.`,
      status: "unknown",
    };
  }
  const configured = stripTrailingSlash(inputs.referenceOriginConfigured);
  const observed = stripTrailingSlash(browserOrigin);
  if (configured === observed) {
    return {
      check: "Reference origin alignment",
      detail: `Configured origin matches the browser origin (${observed}).`,
      status: "ok",
    };
  }
  return {
    check: "Reference origin alignment",
    detail: `PDPP_REFERENCE_ORIGIN=${configured}; you are viewing this dashboard from ${observed}.`,
    hint: "Set `PDPP_REFERENCE_ORIGIN` to the URL you are visiting (e.g. `https://<podid>-3002.proxy.runpod.net`). Mismatches break the MCP and OAuth callback flows.",
    status: "warn",
  };
}

export function storageBackendRow(inputs: ServerInputs): ReadinessRow {
  if (inputs.vectorIndexKind === null && inputs.vectorIndexState === null) {
    return {
      check: "Storage backend",
      detail: `Database at ${inputs.databasePath}. No vector index configured yet.`,
      status: "info",
    };
  }
  if (inputs.vectorIndexState === "stale") {
    return {
      check: "Storage backend",
      detail: `Database at ${inputs.databasePath}; vector index (${inputs.vectorIndexKind ?? "unknown"}) is stale.`,
      hint: "Storage backend reports unhealthy. See `docs/operator/selfhost-quickstart.md` for storage layout.",
      status: "warn",
    };
  }
  if (inputs.vectorIndexState === "building") {
    return {
      check: "Storage backend",
      detail: `Database at ${inputs.databasePath}; vector index (${inputs.vectorIndexKind ?? "unknown"}) is still building.`,
      status: "info",
    };
  }
  return {
    check: "Storage backend",
    detail: `Database at ${inputs.databasePath}; vector index (${inputs.vectorIndexKind ?? "n/a"}) is built.`,
    status: "ok",
  };
}

export function embeddingCacheRow(inputs: ServerInputs): ReadinessRow {
  if (!inputs.embeddingBackendConfigured) {
    return {
      check: "Embedding cache",
      detail: "No semantic embedding backend configured. Lexical retrieval still works.",
      status: "info",
    };
  }
  if (inputs.embeddingModelCachePresent === true && inputs.embeddingBackendAvailable) {
    return {
      check: "Embedding cache",
      detail: "Embedding model is cached and the backend is available.",
      status: "ok",
    };
  }
  if (inputs.embeddingModelCachePresent === false && inputs.embeddingDownloadAllowed === false) {
    return {
      check: "Embedding cache",
      detail: "Embedding model is not cached and download is disabled.",
      hint: "Embedding cache is still downloading or missing. Wait for first-boot download to finish, or set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` if you do not need semantic search yet.",
      status: "error",
    };
  }
  return {
    check: "Embedding cache",
    detail: "Embedding model cache is still warming up or the backend is not yet ready.",
    hint: "Embedding cache is still downloading or missing. Wait for first-boot download to finish, or set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` if you do not need semantic search yet.",
    status: "warn",
  };
}

export function refreshTokenRow(probe: RefreshTokenProbe): ReadinessRow {
  if (probe.state === "loading") {
    return {
      check: "MCP refresh-token advertisement",
      detail: "Checking the authorization-server metadata…",
      status: "unknown",
    };
  }
  if (probe.state === "unreachable") {
    return {
      check: "MCP refresh-token advertisement",
      detail: "Could not reach `/.well-known/oauth-authorization-server` from this origin.",
      hint: "If your `AS_ISSUER` is not co-located with the dashboard origin, this check may show `warn` even on a healthy deployment. Confirm `grant_types_supported` includes `refresh_token` on your AS metadata directly.",
      status: "warn",
    };
  }
  if (probe.refreshTokenSupported) {
    return {
      check: "MCP refresh-token advertisement",
      detail: "Authorization-server metadata advertises `refresh_token`.",
      status: "ok",
    };
  }
  return {
    check: "MCP refresh-token advertisement",
    detail: "Authorization-server metadata does not advertise `refresh_token`.",
    hint: "Reference image is too old to advertise `refresh_token`. `docker compose pull` to the current image.",
    status: "error",
  };
}

// 2 GiB — below this a Docker build or reference restart is very likely to OOD.
const DISK_ERROR_BYTES = 2 * 1024 * 1024 * 1024;
// 5 GiB — warn so the operator can act before the error threshold.
const DISK_WARN_BYTES = 5 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  }
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

// Build a workload-aware hint suffix.
// When free bytes are below the largest relation's size, a VACUUM FULL or
// index rebuild of that table would need scratch space it cannot get — warn.
// Warning-only per heuristics rule; never a threshold that replaces the absolute ones.
function workloadSuffix(dh: DiskHeadroomInputs, free: number): string {
  const relBytes = dh.largestRelationBytes;
  const relName = dh.largestRelationName;
  if (relBytes === null || typeof relBytes !== "number" || free >= relBytes) {
    return "";
  }
  const name = relName ?? "your largest table";
  return ` Free space is below the size of your largest table (${name}, ${formatBytes(relBytes)}) — maintenance operations like VACUUM FULL may fail.`;
}

// Derive a single readiness row for one DiskHeadroomInputs entry.
function diskHeadroomEntryRow(dh: DiskHeadroomInputs): ReadinessRow {
  const mountSuffix = dh.mountLabel ? ` (${dh.mountLabel})` : "";
  const checkLabel = `Disk headroom${mountSuffix}`;
  if (dh.freeBytesOnDataFs === null) {
    return {
      check: checkLabel,
      detail: `Disk headroom could not be measured${dh.path ? ` on ${dh.path}` : ""}.`,
      status: "info",
    };
  }
  const free = dh.freeBytesOnDataFs;
  const pathLabel = dh.path ? ` on ${dh.path}` : "";
  if (free < DISK_ERROR_BYTES) {
    return {
      check: checkLabel,
      detail: `Only ${formatBytes(free)} free${pathLabel}. A restart or image build will very likely fail with "No space left on device".${workloadSuffix(dh, free)}`,
      hint: "Run `docker builder prune` or `docker system prune` to reclaim build cache and stopped containers. Inspect Docker volumes manually before removing any volume data.",
      status: "error",
    };
  }
  if (free < DISK_WARN_BYTES) {
    return {
      check: checkLabel,
      detail: `${formatBytes(free)} free${pathLabel}. Disk space is running low.${workloadSuffix(dh, free)}`,
      hint: "Consider running `docker system prune` to reclaim build cache before the next restart.",
      status: "warn",
    };
  }
  return {
    check: checkLabel,
    detail: `${formatBytes(free)} free${pathLabel}.`,
    status: "ok",
  };
}

// Returns one ReadinessRow per distinct probed filesystem. Empty array when
// no probes ran (caller decides whether to show a fallback). Use this in the
// deployment readiness panel to support multi-mount deployments.
export function diskHeadroomRows(inputs: ServerInputs): ReadinessRow[] {
  if (inputs.diskHeadroom.length === 0) {
    return [
      {
        check: "Disk headroom",
        detail: "Disk headroom could not be measured on this filesystem.",
        status: "info",
      },
    ];
  }
  return inputs.diskHeadroom.map(diskHeadroomEntryRow);
}

// Backward-compatible single-row accessor. Uses the first entry (data dir)
// when the array has entries; returns the "unmeasured" info row when empty.
// Kept for callers that have not yet migrated to diskHeadroomRows().
export function diskHeadroomRow(inputs: ServerInputs): ReadinessRow {
  if (inputs.diskHeadroom.length === 0) {
    return {
      check: "Disk headroom",
      detail: "Disk headroom could not be measured on this filesystem.",
      status: "info",
    };
  }
  const first = inputs.diskHeadroom[0];
  // Guarded by the length check above; TypeScript sees index access as possibly
  // undefined when noUncheckedIndexedAccess is set.
  if (!first) {
    return {
      check: "Disk headroom",
      detail: "Disk headroom could not be measured on this filesystem.",
      status: "info",
    };
  }
  return diskHeadroomEntryRow(first);
}

export function overallVerdict(rows: ReadinessRow[]): Verdict {
  if (rows.some((r) => r.status === "error")) {
    return "blocked";
  }
  if (rows.some((r) => r.status === "warn")) {
    return "attention";
  }
  if (rows.some((r) => r.status === "unknown")) {
    return "unknown";
  }
  return "ready";
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
