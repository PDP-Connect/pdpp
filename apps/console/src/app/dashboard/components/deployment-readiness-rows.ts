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

export interface ServerInputs {
  databasePath: string;
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
  return {
    ownerPasswordProvenance: owner?.provenance ?? "absent",
    referenceOriginConfigured: origin?.provenance === "present" ? origin.value : null,
    embeddingBackendConfigured: report.semantic.backend.configured,
    embeddingBackendAvailable: report.semantic.backend.available,
    embeddingModelCachePresent: report.semantic.backend.model_cache_present,
    embeddingDownloadAllowed: report.semantic.backend.download_allowed,
    vectorIndexKind: report.semantic.index.kind,
    vectorIndexState: report.semantic.index.state,
    databasePath: report.database.path,
  };
}

export function ownerPasswordRow(inputs: ServerInputs): ReadinessRow {
  if (inputs.ownerPasswordProvenance === "redacted") {
    return {
      check: "Owner password gate",
      status: "ok",
      detail: "PDPP_OWNER_PASSWORD is set; owner surfaces require sign-in.",
    };
  }
  return {
    check: "Owner password gate",
    status: "error",
    detail: "PDPP_OWNER_PASSWORD is not set.",
    hint: "Set `PDPP_OWNER_PASSWORD` in your env and restart; otherwise `/owner`, `/device`, `/consent`, and `/dashboard` are reachable without auth.",
  };
}

export function referenceOriginRow(inputs: ServerInputs, browserOrigin: string | null): ReadinessRow {
  if (!inputs.referenceOriginConfigured) {
    return {
      check: "Reference origin alignment",
      status: "warn",
      detail:
        "PDPP_REFERENCE_ORIGIN is not set. The deployment will infer the origin from request headers, which is brittle behind proxies.",
      hint: "Set `PDPP_REFERENCE_ORIGIN` to the URL you are visiting (e.g. `https://<podid>-3002.proxy.runpod.net`). Mismatches break the MCP and OAuth callback flows.",
    };
  }
  if (browserOrigin === null) {
    return {
      check: "Reference origin alignment",
      status: "unknown",
      detail: `PDPP_REFERENCE_ORIGIN=${inputs.referenceOriginConfigured}. Browser origin not yet observed.`,
    };
  }
  const configured = stripTrailingSlash(inputs.referenceOriginConfigured);
  const observed = stripTrailingSlash(browserOrigin);
  if (configured === observed) {
    return {
      check: "Reference origin alignment",
      status: "ok",
      detail: `Configured origin matches the browser origin (${observed}).`,
    };
  }
  return {
    check: "Reference origin alignment",
    status: "warn",
    detail: `PDPP_REFERENCE_ORIGIN=${configured}; you are viewing this dashboard from ${observed}.`,
    hint: "Set `PDPP_REFERENCE_ORIGIN` to the URL you are visiting (e.g. `https://<podid>-3002.proxy.runpod.net`). Mismatches break the MCP and OAuth callback flows.",
  };
}

export function storageBackendRow(inputs: ServerInputs): ReadinessRow {
  if (inputs.vectorIndexKind === null && inputs.vectorIndexState === null) {
    return {
      check: "Storage backend",
      status: "info",
      detail: `Database at ${inputs.databasePath}. No vector index configured yet.`,
    };
  }
  if (inputs.vectorIndexState === "stale") {
    return {
      check: "Storage backend",
      status: "warn",
      detail: `Database at ${inputs.databasePath}; vector index (${inputs.vectorIndexKind ?? "unknown"}) is stale.`,
      hint: "Storage backend reports unhealthy. See `docs/operator/selfhost-quickstart.md` for storage layout.",
    };
  }
  if (inputs.vectorIndexState === "building") {
    return {
      check: "Storage backend",
      status: "info",
      detail: `Database at ${inputs.databasePath}; vector index (${inputs.vectorIndexKind ?? "unknown"}) is still building.`,
    };
  }
  return {
    check: "Storage backend",
    status: "ok",
    detail: `Database at ${inputs.databasePath}; vector index (${inputs.vectorIndexKind ?? "n/a"}) is built.`,
  };
}

export function embeddingCacheRow(inputs: ServerInputs): ReadinessRow {
  if (!inputs.embeddingBackendConfigured) {
    return {
      check: "Embedding cache",
      status: "info",
      detail: "No semantic embedding backend configured. Lexical retrieval still works.",
    };
  }
  if (inputs.embeddingModelCachePresent === true && inputs.embeddingBackendAvailable) {
    return {
      check: "Embedding cache",
      status: "ok",
      detail: "Embedding model is cached and the backend is available.",
    };
  }
  if (inputs.embeddingModelCachePresent === false && inputs.embeddingDownloadAllowed === false) {
    return {
      check: "Embedding cache",
      status: "error",
      detail: "Embedding model is not cached and download is disabled.",
      hint: "Embedding cache is still downloading or missing. Wait for first-boot download to finish, or set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` if you do not need semantic search yet.",
    };
  }
  return {
    check: "Embedding cache",
    status: "warn",
    detail: "Embedding model cache is still warming up or the backend is not yet ready.",
    hint: "Embedding cache is still downloading or missing. Wait for first-boot download to finish, or set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` if you do not need semantic search yet.",
  };
}

export function refreshTokenRow(probe: RefreshTokenProbe): ReadinessRow {
  if (probe.state === "loading") {
    return {
      check: "MCP refresh-token advertisement",
      status: "unknown",
      detail: "Checking the authorization-server metadata…",
    };
  }
  if (probe.state === "unreachable") {
    return {
      check: "MCP refresh-token advertisement",
      status: "warn",
      detail: "Could not reach `/.well-known/oauth-authorization-server` from this origin.",
      hint: "If your `AS_ISSUER` is not co-located with the dashboard origin, this check may show `warn` even on a healthy deployment. Confirm `grant_types_supported` includes `refresh_token` on your AS metadata directly.",
    };
  }
  if (probe.refreshTokenSupported) {
    return {
      check: "MCP refresh-token advertisement",
      status: "ok",
      detail: "Authorization-server metadata advertises `refresh_token`.",
    };
  }
  return {
    check: "MCP refresh-token advertisement",
    status: "error",
    detail: "Authorization-server metadata does not advertise `refresh_token`.",
    hint: "Reference image is too old to advertise `refresh_token`. `docker compose pull` to the current image.",
  };
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
