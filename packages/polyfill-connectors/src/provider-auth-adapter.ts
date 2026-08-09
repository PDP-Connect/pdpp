// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-side provider-auth adapter registry.
 *
 * Mirrors auth.ts's registerAuthStrategy/resolveAuth pattern, but for the
 * provider OAuth exchange lifecycle (authorization URL, code exchange,
 * account inventory, token-bundle shaping) instead of connect-time
 * credential resolution.
 *
 * The reference implementation imports only the `ProviderAuthAdapter` type
 * and `resolveProviderAuthAdapter` — never a concrete adapter file. Concrete
 * adapters (one per `exchanger_kind`) are connector-owned modules that export
 * their adapter object and the kind it implements; provider-auth-adapters.ts
 * owns the list and binds the two. Registration is inverted this way so an
 * adapter's dependency on this module stays type-only and the import graph
 * stays acyclic.
 *
 * Registration is also deterministic rather than import-order-dependent:
 * every module in that list is eagerly loaded (once, memoized) before any
 * resolution, mirroring reference-implementation/server/queries/index.ts's
 * enumerate-then-freeze pattern rather than relying on whichever caller
 * happens to import an adapter file first.
 */

export interface ProviderAuthManifestLike {
  readonly capabilities?: {
    readonly auth?: {
      readonly authorization_params?: Readonly<Record<string, string>> | null;
      readonly authorization_url?: string | null;
      readonly deployment_config?: readonly (string | Readonly<Record<string, unknown>>)[] | null;
      readonly exchanger_kind?: string | null;
      readonly provider_identity_group?: string | null;
      readonly scopes?: readonly string[] | null;
      readonly token_url?: string | null;
      readonly userinfo_url?: string | null;
      readonly [key: string]: unknown;
    } | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
}

export type DeploymentConfigResolver = (args: {
  identityGroup: string;
  logicalKey: string;
  envAlias?: string | null;
}) => Promise<string | null>;

export interface ProviderAuthTokens {
  readonly accessToken: string;
  readonly expiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly tokenKind: string;
}

export interface ProviderAccount {
  readonly accountId: string;
  readonly displayLabel?: string | null;
  readonly sourceBinding?: Record<string, unknown> | null;
}

/**
 * An adapter-defined, non-secret snapshot carried from runInventoryOrTest to
 * the storeTokens call for the same flow. Scoped to a single flow's call
 * pair by the caller (the per-flow object the RI threads through, not this
 * module) — never a global memo keyed by a raw token. An adapter that has
 * nothing to carry (e.g. oauth2_generic) omits it entirely.
 */
export type ProviderAuthPersistenceContext = Readonly<Record<string, unknown>>;

export interface ProviderAuthInventoryResult {
  readonly accounts: readonly ProviderAccount[];
  readonly persistenceContext?: ProviderAuthPersistenceContext;
}

export interface ProviderAuthAdapter {
  exchangeCode: (args: {
    code: string;
    redirectUri: string;
    state: string;
    manifest: ProviderAuthManifestLike;
    deploymentConfigResolver: DeploymentConfigResolver;
  }) => Promise<ProviderAuthTokens | null>;
  initiateAuthorization: (args: {
    redirectUri: string;
    state: string;
    manifest: ProviderAuthManifestLike;
    deploymentConfigResolver: DeploymentConfigResolver;
  }) => Promise<{ authorizationUrl: string }>;
  runInventoryOrTest: (args: {
    tokens: ProviderAuthTokens;
    manifest: ProviderAuthManifestLike;
  }) => Promise<ProviderAuthInventoryResult>;
  storeTokens: (args: {
    tokens: ProviderAuthTokens;
    manifest: ProviderAuthManifestLike;
    persistenceContext?: ProviderAuthPersistenceContext;
  }) => Promise<Record<string, string>>;
}

// ─── Shared manifest readers ───────────────────────────────────────────

export interface DeploymentConfigEntry {
  readonly envAlias: string | null;
  readonly logicalKey: string;
}

export function manifestAuth(manifest: ProviderAuthManifestLike) {
  return manifest.capabilities?.auth ?? null;
}

/**
 * The provider identity group a manifest declares, falling back to its own
 * connector key — two connectors sharing one provider app declare the same
 * group, so their deployment config resolves to one shared entry.
 */
export function identityGroup(manifest: ProviderAuthManifestLike): string {
  const raw = manifestAuth(manifest)?.provider_identity_group;
  const declared = typeof raw === "string" ? raw.trim() : "";
  return declared || manifest.connector_key?.trim() || manifest.connector_id?.trim() || "";
}

function readTrimmed(record: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function deploymentConfigEntry(entry: unknown): DeploymentConfigEntry | null {
  if (typeof entry === "string") {
    return entry.trim() ? { envAlias: null, logicalKey: entry.trim() } : null;
  }
  if (!(entry && typeof entry === "object")) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const logicalKey = readTrimmed(record, "logical_key", "key");
  return logicalKey ? { envAlias: readTrimmed(record, "env_alias"), logicalKey } : null;
}

/**
 * Normalizes a manifest's `capabilities.auth.deployment_config` — which may
 * declare each entry either as a bare logical-key string or as an object
 * with `logical_key`/`key` plus an optional `env_alias` — into one shape.
 */
export function deploymentConfigEntries(manifest: ProviderAuthManifestLike): readonly DeploymentConfigEntry[] {
  const declared = manifestAuth(manifest)?.deployment_config;
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared.map(deploymentConfigEntry).filter((value): value is DeploymentConfigEntry => value !== null);
}

export function findDeploymentEntry(
  entries: readonly DeploymentConfigEntry[],
  logicalKey: string
): DeploymentConfigEntry | null {
  return entries.find((entry) => entry.logicalKey === logicalKey) ?? null;
}

// ─── Deterministic eager registration ──────────────────────────────────

const adapters = new Map<string, ProviderAuthAdapter>();

/**
 * Binds one `exchanger_kind` to its adapter. Called only by
 * provider-auth-adapters.ts, which owns the adapter list — an adapter module
 * never calls this itself, so an adapter's dependency on this module stays
 * type-only and the import graph stays acyclic. A second registration under
 * the same `kind` is a configuration error, not last-writer-wins.
 */
export function registerProviderAuthAdapter(kind: string, adapter: ProviderAuthAdapter): void {
  if (adapters.has(kind)) {
    throw new Error(`provider_auth_adapter_kind_duplicate: ${kind}`);
  }
  adapters.set(kind, adapter);
}

/** Looks up an already-registered adapter. Callers go through
 * provider-auth-adapters.ts's `resolveProviderAuthAdapter`, which guarantees
 * registration has happened first. */
export function getRegisteredProviderAuthAdapter(kind: string): ProviderAuthAdapter | null {
  return adapters.get(kind) ?? null;
}

/**
 * Test-only: drops in-process registration so a harness can re-register
 * without tripping the duplicate guard. Concrete adapter modules never call
 * this.
 */
export function _clearProviderAuthAdapterRegistryForTests(): void {
  adapters.clear();
}
