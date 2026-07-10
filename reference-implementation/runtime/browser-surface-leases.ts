import {
  BROWSER_SURFACE_PRIORITY_CLASSES,
  type BrowserSurface,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseConfig,
  type BrowserSurfaceMode,
  type BrowserSurfacePriorityClass,
  DEFAULT_NEKO_IDLE_TTL_MS,
  DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS,
  DEFAULT_NEKO_PRIORITY_CLASS,
  DEFAULT_NEKO_PRIORITY_RANKS,
} from "@opendatalabs/remote-surface/leases";

import { canonicalConnectorKey } from "../server/connector-key.js";
import { connectorRetainsSurfaceProcess } from "./browser-surface/retained-surface-connectors.ts";

export const DEFAULT_NEKO_READINESS_TIMEOUT_MS = 120_000;

export type NekoProfileStoragePolicy = "persistent";

export interface NekoDynamicBrowserSurfaceRuntimeConfig {
  readonly allocatorUrl: string;
  readonly profileStoragePolicy: NekoProfileStoragePolicy;
  readonly profileStorageRoot: string;
  readonly readinessTimeoutMs: number;
}

export interface NekoBrowserSurfaceRuntimeConfig {
  readonly dynamic?: NekoDynamicBrowserSurfaceRuntimeConfig;
  readonly leaseConfig: BrowserSurfaceLeaseConfig;
}

/** Durable cross-run profile identity, drawn from the lease. */
export interface DurableProfileBinding {
  readonly leaseId: string;
  readonly profileKey: string;
}

/** Transport/page runtime coordinates, drawn from the surface. */
export interface SurfaceTransport {
  readonly remoteCdpUrl: string;
  readonly surfaceId: string;
}

/** Owner viewer/stream channel, drawn from the surface. */
export interface OwnerInteractionChannel {
  readonly streamBaseUrl: string;
}

export function toDurableProfileBinding(lease: BrowserSurfaceLease): DurableProfileBinding {
  return { leaseId: lease.lease_id, profileKey: lease.profile_key };
}

export function toSurfaceTransport(surface: BrowserSurface): SurfaceTransport {
  return { surfaceId: surface.surface_id, remoteCdpUrl: surface.cdp_url };
}

export function toOwnerInteractionChannel(surface: BrowserSurface): OwnerInteractionChannel {
  return { streamBaseUrl: surface.stream_base_url };
}

export function browserSurfaceLeaseEnv(lease: BrowserSurfaceLease, surface: BrowserSurface): Record<string, string> {
  const profile = toDurableProfileBinding(lease);
  const transport = toSurfaceTransport(surface);
  const channel = toOwnerInteractionChannel(surface);
  return {
    PDPP_BROWSER_SURFACE_REQUIRED: "neko",
    PDPP_BROWSER_SURFACE_LEASE_ID: profile.leaseId,
    PDPP_BROWSER_SURFACE_PROFILE_KEY: profile.profileKey,
    PDPP_BROWSER_SURFACE_ID: transport.surfaceId,
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: transport.remoteCdpUrl,
    PDPP_BROWSER_SURFACE_STREAM_BASE_URL: channel.streamBaseUrl,
  };
}

export function parseNekoBrowserSurfaceLeaseConfig(env: NodeJS.ProcessEnv = process.env): BrowserSurfaceLeaseConfig {
  return parseNekoBrowserSurfaceRuntimeConfig(env).leaseConfig;
}
interface ParsedNekoEnvShape {
  readonly configuredStaticProfileKey: string | undefined;
  readonly managedConnectorIds: readonly string[];
  readonly managedConnectors: Set<string>;
  readonly requestedSurfaceMode: BrowserSurfaceMode | undefined;
  readonly staticCdpHttpUrl: string | undefined;
  readonly staticProfileKey: string | undefined;
  readonly staticStreamBaseUrl: string | undefined;
  readonly surfaceCap: number;
  readonly surfaceMode: BrowserSurfaceMode;
}

function readNekoEnvShape(env: NodeJS.ProcessEnv): ParsedNekoEnvShape {
  const managedConnectorIds = splitCsv(env.PDPP_NEKO_MANAGED_CONNECTORS);
  const managedConnectors = new Set(managedConnectorIds.flatMap(managedConnectorAliases));
  const requestedSurfaceMode = parseSurfaceMode(env.PDPP_NEKO_SURFACE_MODE);
  const surfaceCap = parseIntegerEnv(
    env.PDPP_NEKO_SURFACE_CAP,
    "PDPP_NEKO_SURFACE_CAP",
    managedConnectors.size === 0 ? 0 : undefined
  );
  if (managedConnectors.size > 0 && surfaceCap < 1) {
    throw new Error("PDPP_NEKO_SURFACE_CAP must be an integer >= 1 when PDPP_NEKO_MANAGED_CONNECTORS is configured");
  }

  const configuredStaticProfileKey = emptyToUndefined(env.PDPP_NEKO_STATIC_PROFILE_KEY);
  const staticProfileKey =
    requestedSurfaceMode === "dynamic"
      ? configuredStaticProfileKey
      : (configuredStaticProfileKey ?? defaultStaticProfileKey(managedConnectorIds));
  if (requestedSurfaceMode !== "dynamic" && managedConnectors.size > 1 && !staticProfileKey) {
    throw new Error("PDPP_NEKO_STATIC_PROFILE_KEY is required when multiple managed n.eko connectors are configured");
  }

  const surfaceMode: BrowserSurfaceMode = requestedSurfaceMode ?? (staticProfileKey ? "static" : "dynamic");
  return {
    managedConnectorIds,
    managedConnectors,
    requestedSurfaceMode,
    surfaceCap,
    configuredStaticProfileKey,
    staticProfileKey,
    surfaceMode,
    staticCdpHttpUrl: emptyToUndefined(env.PDPP_NEKO_CDP_HTTP_URL),
    staticStreamBaseUrl: emptyToUndefined(env.PDPP_NEKO_BASE_URL),
  };
}

function enforceStaticModeInvariants(shape: ParsedNekoEnvShape): void {
  if (shape.surfaceMode !== "static" || shape.managedConnectors.size === 0) {
    return;
  }
  if (shape.surfaceCap !== 1) {
    throw new Error("PDPP_NEKO_SURFACE_CAP must be exactly 1 in static n.eko surface mode");
  }
  if (!shape.staticCdpHttpUrl) {
    throw new Error("PDPP_NEKO_CDP_HTTP_URL is required in static n.eko surface mode");
  }
  if (!shape.staticStreamBaseUrl) {
    throw new Error("PDPP_NEKO_BASE_URL is required in static n.eko surface mode");
  }
}

function enforceDynamicModeInvariants(shape: ParsedNekoEnvShape): void {
  if (shape.staticCdpHttpUrl) {
    throw new Error("PDPP_NEKO_CDP_HTTP_URL is static-only and must not be configured in dynamic n.eko surface mode");
  }
  if (shape.staticStreamBaseUrl) {
    throw new Error("PDPP_NEKO_BASE_URL is static-only and must not be configured in dynamic n.eko surface mode");
  }
  if (shape.configuredStaticProfileKey) {
    throw new Error(
      "PDPP_NEKO_STATIC_PROFILE_KEY is static-only and must not be configured in dynamic n.eko surface mode"
    );
  }
}

function buildLeaseConfig(shape: ParsedNekoEnvShape, env: NodeJS.ProcessEnv): BrowserSurfaceLeaseConfig {
  return {
    managedConnectors: shape.managedConnectors,
    surfaceCap: shape.surfaceCap,
    leaseWaitTimeoutMs: parseIntegerEnv(
      env.PDPP_NEKO_LEASE_WAIT_TIMEOUT_MS,
      "PDPP_NEKO_LEASE_WAIT_TIMEOUT_MS",
      DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS
    ),
    idleTtlMs: parseIntegerEnv(env.PDPP_NEKO_IDLE_TTL_MS, "PDPP_NEKO_IDLE_TTL_MS", DEFAULT_NEKO_IDLE_TTL_MS),
    defaultPriorityClass: parsePriorityClass(env.PDPP_NEKO_DEFAULT_PRIORITY_CLASS),
    priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
    surfaceMode: shape.surfaceMode,
    ...(shape.staticProfileKey ? { staticProfileKey: shape.staticProfileKey } : {}),
    ...(shape.staticCdpHttpUrl ? { staticCdpHttpUrl: shape.staticCdpHttpUrl } : {}),
    ...(shape.staticStreamBaseUrl ? { staticStreamBaseUrl: shape.staticStreamBaseUrl } : {}),
  };
}

export function parseNekoBrowserSurfaceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): NekoBrowserSurfaceRuntimeConfig {
  const shape = readNekoEnvShape(env);
  enforceStaticModeInvariants(shape);
  const leaseConfig = buildLeaseConfig(shape, env);
  if (shape.surfaceMode === "static" || shape.managedConnectors.size === 0) {
    return { leaseConfig };
  }
  enforceDynamicModeInvariants(shape);
  const dynamic = parseDynamicRuntimeConfig(env);
  assertRetainedManagedConnectorReserve(shape.surfaceCap, shape.managedConnectorIds);
  return {
    leaseConfig,
    dynamic,
  };
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ];
}

function assertRetainedManagedConnectorReserve(
  surfaceCap: number,
  managedConnectorIds: readonly string[]
): void {
  const retainedManagedConnectorCount = countRetainedManagedConnectors(managedConnectorIds);
  if (retainedManagedConnectorCount === 0 || surfaceCap > retainedManagedConnectorCount) {
    return;
  }
  // Fair-slot invariant. Credential-boundary connectors (ChatGPT) retain their
  // surface process across routine idle/capacity reap, so each retained managed
  // connector permanently holds at least one slot. The cap MUST leave at least
  // one transient slot for non-retained scheduled work, or the other connectors
  // could never acquire a surface. This is an explicit operating invariant, not
  // an operator tuning suggestion: fail config closed rather than deadlock at
  // runtime. Per-connection retained demand is enforced by the lease manager
  // against live surfaces and queued requests, including restart reconciliation.
  throw new Error(
    `PDPP_NEKO_SURFACE_CAP (${surfaceCap}) must exceed the number of retained credential-boundary managed connectors ` +
      `(${retainedManagedConnectorCount}) so at least one transient surface slot remains for non-retained scheduled work`
  );
}

function countRetainedManagedConnectors(managedConnectorIds: readonly string[]): number {
  const retained = new Set<string>();
  for (const connectorId of managedConnectorIds) {
    if (connectorRetainsSurfaceProcess(connectorId)) {
      retained.add(canonicalConnectorKey(connectorId) ?? connectorId);
    }
  }
  return retained.size;
}

function managedConnectorAliases(connectorId: string): string[] {
  const aliases = new Set<string>([connectorId]);
  const normalizedUrl = normalizeConnectorUrl(connectorId);
  if (normalizedUrl) {
    aliases.add(normalizedUrl);
  }
  const canonicalKey = canonicalConnectorKey(connectorId);
  if (canonicalKey) {
    aliases.add(canonicalKey);
  }
  return [...aliases];
}

function normalizeConnectorUrl(connectorId: string): string | undefined {
  try {
    const parsed = new URL(connectorId);
    return parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
  } catch {
    return;
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultStaticProfileKey(managedConnectorIds: readonly string[]): string | undefined {
  const [connectorId] = managedConnectorIds;
  return connectorId && managedConnectorIds.length === 1
    ? defaultProfileKeyForManagedConnectorId(connectorId)
    : undefined;
}

function defaultProfileKeyForManagedConnectorId(connectorId: string): string {
  return canonicalConnectorKey(connectorId) ?? connectorId;
}

function parseSurfaceMode(value: string | undefined): BrowserSurfaceMode | undefined {
  const mode = emptyToUndefined(value);
  if (!mode) {
    return;
  }
  if (mode === "static" || mode === "dynamic") {
    return mode;
  }
  throw new Error("PDPP_NEKO_SURFACE_MODE must be one of: static, dynamic");
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

function parseDynamicRuntimeConfig(env: NodeJS.ProcessEnv): NekoDynamicBrowserSurfaceRuntimeConfig {
  const allocatorUrl = parseUrlEnv(env.PDPP_NEKO_ALLOCATOR_URL, "PDPP_NEKO_ALLOCATOR_URL");
  const profileStoragePolicy = parseProfileStoragePolicy(env.PDPP_NEKO_PROFILE_STORAGE_POLICY);
  const profileStorageRoot = emptyToUndefined(env.PDPP_NEKO_PROFILE_STORAGE_ROOT);
  if (!profileStorageRoot) {
    throw new Error("PDPP_NEKO_PROFILE_STORAGE_ROOT is required in dynamic n.eko surface mode");
  }
  return {
    allocatorUrl,
    profileStoragePolicy,
    profileStorageRoot,
    readinessTimeoutMs: parsePositiveIntegerEnv(
      env.PDPP_NEKO_READINESS_TIMEOUT_MS,
      "PDPP_NEKO_READINESS_TIMEOUT_MS",
      DEFAULT_NEKO_READINESS_TIMEOUT_MS
    ),
  };
}

function parseProfileStoragePolicy(value: string | undefined): NekoProfileStoragePolicy {
  const policy = emptyToUndefined(value);
  if (!policy) {
    throw new Error("PDPP_NEKO_PROFILE_STORAGE_POLICY is required in dynamic n.eko surface mode");
  }
  if (policy === "persistent") {
    return policy;
  }
  throw new Error("PDPP_NEKO_PROFILE_STORAGE_POLICY must be one of: persistent");
}

function parseUrlEnv(value: string | undefined, name: string): string {
  const trimmed = emptyToUndefined(value);
  if (!trimmed) {
    throw new Error(`${name} is required in dynamic n.eko surface mode`);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Fall through to the consistent validation error below.
  }
  throw new Error(`${name} must be a valid http(s) URL`);
}

function parsePositiveIntegerEnv(value: string | undefined, name: string, defaultValue: number): number {
  const parsed = parseIntegerEnv(value, name, defaultValue);
  if (parsed < 1) {
    throw new Error(`${name} must be an integer >= 1`);
  }
  return parsed;
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
