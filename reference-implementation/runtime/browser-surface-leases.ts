export {
  BROWSER_SURFACE_BACKEND_NEKO,
  BROWSER_SURFACE_LEASE_STATUSES,
  BROWSER_SURFACE_PRIORITY_CLASSES,
  BROWSER_SURFACE_WAIT_REASONS,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_IDLE_TTL_MS,
  DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS,
  DEFAULT_NEKO_PRIORITY_CLASS,
  DEFAULT_NEKO_PRIORITY_RANKS,
  TERMINAL_BROWSER_SURFACE_LEASE_STATUSES,
  isTerminalBrowserSurfaceLeaseStatus,
  projectBrowserSurfaceLease,
} from "@pdpp/remote-surface/leases";
export type {
  AcquireBrowserSurfaceLeaseRequest,
  BrowserSurface,
  BrowserSurfaceAllocator,
  BrowserSurfaceBackend,
  BrowserSurfaceHealth,
  BrowserSurfaceLease,
  BrowserSurfaceLeaseConfig,
  BrowserSurfaceLeaseManagerOptions,
  BrowserSurfaceLeaseResult,
  BrowserSurfaceLeaseStatus,
  BrowserSurfaceMode,
  BrowserSurfacePriorityClass,
  BrowserSurfaceProjection,
  BrowserSurfaceWaitReason,
  EnsureBrowserSurfaceRequest,
  ReconcileBrowserSurfaceLeasesAfterRestartRequest,
  ReconcileBrowserSurfaceLeasesAfterRestartResult,
  ReleaseBrowserSurfaceLeaseRequest,
  ReleaseBrowserSurfaceLeaseResult,
  StopBrowserSurfaceRequest,
  TerminalBrowserSurfaceLeaseResult,
} from "@pdpp/remote-surface/leases";

import {
  BROWSER_SURFACE_PRIORITY_CLASSES,
  DEFAULT_NEKO_IDLE_TTL_MS,
  DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS,
  DEFAULT_NEKO_PRIORITY_CLASS,
  DEFAULT_NEKO_PRIORITY_RANKS,
  type BrowserSurface,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseConfig,
  type BrowserSurfacePriorityClass,
  type BrowserSurfaceMode,
} from "@pdpp/remote-surface/leases";

export function browserSurfaceLeaseEnv(lease: BrowserSurfaceLease, surface: BrowserSurface): Record<string, string> {
  return {
    PDPP_BROWSER_SURFACE_REQUIRED: "neko",
    PDPP_BROWSER_SURFACE_LEASE_ID: lease.lease_id,
    PDPP_BROWSER_SURFACE_PROFILE_KEY: lease.profile_key,
    PDPP_BROWSER_SURFACE_ID: surface.surface_id,
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: surface.cdp_url,
    PDPP_BROWSER_SURFACE_STREAM_BASE_URL: surface.stream_base_url,
  };
}

export function parseNekoBrowserSurfaceLeaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserSurfaceLeaseConfig {
  const managedConnectorIds = splitCsv(env.PDPP_NEKO_MANAGED_CONNECTORS);
  const managedConnectors = new Set(managedConnectorIds);
  const surfaceCap = parseIntegerEnv(env.PDPP_NEKO_SURFACE_CAP, "PDPP_NEKO_SURFACE_CAP", managedConnectors.size === 0 ? 0 : undefined);
  if (managedConnectors.size > 0 && surfaceCap < 1) {
    throw new Error("PDPP_NEKO_SURFACE_CAP must be an integer >= 1 when PDPP_NEKO_MANAGED_CONNECTORS is configured");
  }

  const staticProfileKey = emptyToUndefined(env.PDPP_NEKO_STATIC_PROFILE_KEY) ?? defaultStaticProfileKey(managedConnectorIds);
  if (managedConnectors.size > 1 && !staticProfileKey) {
    throw new Error("PDPP_NEKO_STATIC_PROFILE_KEY is required when multiple managed n.eko connectors are configured");
  }

  const surfaceMode: BrowserSurfaceMode = staticProfileKey ? "static" : "dynamic";
  const staticCdpHttpUrl = emptyToUndefined(env.PDPP_NEKO_CDP_HTTP_URL);
  const staticStreamBaseUrl = emptyToUndefined(env.PDPP_NEKO_BASE_URL);
  if (surfaceMode === "static" && managedConnectors.size > 0) {
    if (surfaceCap !== 1) {
      throw new Error("PDPP_NEKO_SURFACE_CAP must be exactly 1 in static n.eko surface mode");
    }
    if (!staticCdpHttpUrl) {
      throw new Error("PDPP_NEKO_CDP_HTTP_URL is required in static n.eko surface mode");
    }
    if (!staticStreamBaseUrl) {
      throw new Error("PDPP_NEKO_BASE_URL is required in static n.eko surface mode");
    }
  }
  return {
    managedConnectors,
    surfaceCap,
    leaseWaitTimeoutMs: parseIntegerEnv(
      env.PDPP_NEKO_LEASE_WAIT_TIMEOUT_MS,
      "PDPP_NEKO_LEASE_WAIT_TIMEOUT_MS",
      DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS,
    ),
    idleTtlMs: parseIntegerEnv(env.PDPP_NEKO_IDLE_TTL_MS, "PDPP_NEKO_IDLE_TTL_MS", DEFAULT_NEKO_IDLE_TTL_MS),
    defaultPriorityClass: parsePriorityClass(env.PDPP_NEKO_DEFAULT_PRIORITY_CLASS),
    priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
    surfaceMode,
    ...(staticProfileKey ? { staticProfileKey } : {}),
    ...(staticCdpHttpUrl ? { staticCdpHttpUrl } : {}),
    ...(staticStreamBaseUrl ? { staticStreamBaseUrl } : {}),
  };
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultStaticProfileKey(managedConnectorIds: readonly string[]): string | undefined {
  return managedConnectorIds.length === 1 ? managedConnectorIds[0] : undefined;
}

function parsePriorityClass(value: string | undefined): BrowserSurfacePriorityClass {
  if (!value) {
    return DEFAULT_NEKO_PRIORITY_CLASS;
  }
  if (BROWSER_SURFACE_PRIORITY_CLASSES.includes(value as BrowserSurfacePriorityClass)) {
    return value as BrowserSurfacePriorityClass;
  }
  throw new Error(`PDPP_NEKO_DEFAULT_PRIORITY_CLASS must be one of: ${BROWSER_SURFACE_PRIORITY_CLASSES.join(", ")}`);
}

function parseIntegerEnv(value: string | undefined, name: string, defaultValue: number | undefined): number {
  if (!value) {
    if (defaultValue === undefined) {
      throw new Error(`${name} is required`);
    }
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
