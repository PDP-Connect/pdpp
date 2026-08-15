// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Maps Data Portability's provider-auth adapter: access-type/
 * resource-group-aware OAuth2 exchange. This is provider-specific logic
 * (checkAccessType(), resource-group scope derivation, fingerprint
 * identity) and lives connector-side for exactly that reason — it is not
 * a shape the provider-neutral oauth2_generic adapter can express.
 *
 * Registers itself under the "oauth2_access_type_resource_groups" kind at
 * module load.
 */

import { createHash } from "node:crypto";

import type {
  DeploymentConfigResolver,
  ProviderAuthAdapter,
  ProviderAuthInventoryResult,
  ProviderAuthManifestLike,
  ProviderAuthPersistenceContext,
  ProviderAuthTokens,
} from "../../src/provider-auth-adapter.ts";
import {
  deploymentConfigEntries,
  findDeploymentEntry,
  identityGroup,
  manifestAuth,
} from "../../src/provider-auth-adapter.ts";
import { GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS, GoogleDataPortabilityClient } from "./api.ts";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface AccessTypeSnapshot {
  readonly deniedResourceGroups: readonly string[];
  readonly oneTimeResourceGroups: readonly string[];
  readonly timeBasedResourceGroups: readonly string[];
}

export class GoogleDataPortabilityProviderAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "GoogleDataPortabilityProviderAuthError";
    this.code = code;
    this.status = status;
  }
}

async function resolveDeploymentValue(
  resolver: DeploymentConfigResolver,
  manifest: ProviderAuthManifestLike,
  entry: { logicalKey: string; envAlias: string | null }
): Promise<string> {
  const value = await resolver({
    envAlias: entry.envAlias,
    identityGroup: identityGroup(manifest),
    logicalKey: entry.logicalKey,
  });
  if (!value) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_provider_config_missing",
      `Google Data Portability provider app config '${entry.logicalKey}' is missing.`,
      503
    );
  }
  return value;
}

function requireManifestUrl(manifest: ProviderAuthManifestLike, field: "authorization_url" | "token_url"): string {
  const value = manifestAuth(manifest)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_manifest_field_missing",
      `Connector manifest capabilities.auth.${field} is missing or empty.`,
      500
    );
  }
  return value.trim();
}

function manifestResourceGroups(manifest: ProviderAuthManifestLike): readonly string[] {
  const declared = manifestAuth(manifest)?.resource_groups;
  const allowed = new Set(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS);
  if (!Array.isArray(declared)) {
    return GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS;
  }
  const unique = [
    ...new Set(declared.filter((item): item is string => typeof item === "string" && item.trim().length > 0)),
  ].map((item) => item.trim());
  const unsupported = unique.filter((item) => !allowed.has(item));
  if (unsupported.length > 0) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_resource_group_unsupported",
      `Unsupported Google Data Portability Maps resource group: ${unsupported.join(", ")}.`,
      500
    );
  }
  return unique.length > 0 ? unique : GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS;
}

function scopesForResourceGroups(resourceGroups: readonly string[]): readonly string[] {
  return resourceGroups.map((resourceGroup) => `https://www.googleapis.com/auth/dataportability.${resourceGroup}`);
}

function tokenAccountFingerprint(tokens: ProviderAuthTokens, resourceGroups: readonly string[]): string {
  return createHash("sha256")
    .update(tokens.refreshToken || tokens.accessToken)
    .update("\n")
    .update([...resourceGroups].sort().join(","))
    .digest("hex")
    .slice(0, 20);
}

function nowPlusSeconds(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(Date.now() + Math.floor(seconds) * 1000).toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function intersectOrdered(values: readonly string[], allowed: ReadonlySet<string>): readonly string[] {
  return values.filter((value) => allowed.has(value));
}

function buildAccessTypeSnapshot(
  resourceGroups: readonly string[],
  result: { readonly oneTimeResources: readonly string[]; readonly timeBasedResources: readonly string[] }
): AccessTypeSnapshot {
  const requested = new Set(resourceGroups);
  const oneTimeResourceGroups = intersectOrdered(result.oneTimeResources, requested);
  const timeBasedResourceGroups = intersectOrdered(result.timeBasedResources, requested);
  const authorized = new Set([...oneTimeResourceGroups, ...timeBasedResourceGroups]);
  const deniedResourceGroups = resourceGroups.filter((resourceGroup) => !authorized.has(resourceGroup));
  return {
    deniedResourceGroups,
    oneTimeResourceGroups,
    timeBasedResourceGroups,
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates the access-type snapshot handed back through the per-flow
 * persistenceContext, fail-closed. storeTokens never trusts this shape
 * implicitly — a caller passing a malformed or missing context (e.g. an
 * abandoned/mismatched flow) is treated the same as no snapshot at all.
 */
function readAccessTypeSnapshot(context: ProviderAuthPersistenceContext | undefined): AccessTypeSnapshot | null {
  if (!context) {
    return null;
  }
  const { deniedResourceGroups, oneTimeResourceGroups, timeBasedResourceGroups } = context;
  if (
    !(
      isStringArray(deniedResourceGroups) &&
      isStringArray(oneTimeResourceGroups) &&
      isStringArray(timeBasedResourceGroups)
    )
  ) {
    return null;
  }
  return { deniedResourceGroups, oneTimeResourceGroups, timeBasedResourceGroups };
}

async function exchangeGoogleCode({
  clientId,
  clientSecret,
  code,
  fetchImpl,
  redirectUri,
  tokenUrl,
}: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly fetchImpl: FetchLike;
  readonly redirectUri: string;
  readonly tokenUrl: string;
}): Promise<ProviderAuthTokens | null> {
  const response = await fetchImpl(tokenUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const text = await response.text();
  const body = text ? asObject(JSON.parse(text)) : {};
  if (!response.ok) {
    return null;
  }
  const accessToken = asString(body.access_token);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    expiresAt: nowPlusSeconds(body.expires_in),
    refreshToken: asString(body.refresh_token),
    tokenKind: asString(body.token_type) ?? "Bearer",
  };
}

const defaultFetchImpl: FetchLike = (url, init) => fetch(url, init);

export const GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND = "oauth2_access_type_resource_groups";

export const googleDataPortabilityAdapter: ProviderAuthAdapter = {
  async exchangeCode({ code, deploymentConfigResolver, manifest, redirectUri }) {
    const entries = deploymentConfigEntries(manifest);
    const clientIdEntry = findDeploymentEntry(entries, "client_id");
    const clientSecretEntry = findDeploymentEntry(entries, "client_secret");
    if (!(clientIdEntry && clientSecretEntry)) {
      throw new GoogleDataPortabilityProviderAuthError(
        "google_dataportability_manifest_field_missing",
        "Connector manifest capabilities.auth.deployment_config must declare 'client_id' and 'client_secret'.",
        500
      );
    }
    const [clientId, clientSecret] = await Promise.all([
      resolveDeploymentValue(deploymentConfigResolver, manifest, clientIdEntry),
      resolveDeploymentValue(deploymentConfigResolver, manifest, clientSecretEntry),
    ]);
    return exchangeGoogleCode({
      clientId,
      clientSecret,
      code,
      fetchImpl: defaultFetchImpl,
      redirectUri,
      tokenUrl: requireManifestUrl(manifest, "token_url"),
    });
  },

  async initiateAuthorization({ deploymentConfigResolver, manifest, redirectUri, state }) {
    const entries = deploymentConfigEntries(manifest);
    const clientIdEntry = findDeploymentEntry(entries, "client_id");
    if (!clientIdEntry) {
      throw new GoogleDataPortabilityProviderAuthError(
        "google_dataportability_manifest_field_missing",
        "Connector manifest capabilities.auth.deployment_config must declare 'client_id'.",
        500
      );
    }
    const clientId = await resolveDeploymentValue(deploymentConfigResolver, manifest, clientIdEntry);
    const resourceGroups = manifestResourceGroups(manifest);
    const url = new URL(requireManifestUrl(manifest, "authorization_url"));
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopesForResourceGroups(resourceGroups).join(" "));
    url.searchParams.set("state", state);
    const authorizationParams = manifestAuth(manifest)?.authorization_params;
    if (authorizationParams && typeof authorizationParams === "object") {
      for (const [key, value] of Object.entries(authorizationParams)) {
        if (typeof value === "string") {
          url.searchParams.set(key, value);
        }
      }
    }
    return { authorizationUrl: url.toString() };
  },

  async runInventoryOrTest({ manifest, tokens }): Promise<ProviderAuthInventoryResult> {
    const resourceGroups = manifestResourceGroups(manifest);
    const client = new GoogleDataPortabilityClient({
      accessToken: tokens.accessToken,
      fetch: defaultFetchImpl,
    });
    const snapshot = buildAccessTypeSnapshot(resourceGroups, await client.checkAccessType());
    const authorizedResourceGroups = [...snapshot.oneTimeResourceGroups, ...snapshot.timeBasedResourceGroups];
    if (authorizedResourceGroups.length === 0) {
      throw new GoogleDataPortabilityProviderAuthError(
        "google_dataportability_no_authorized_resources",
        "Google authorization completed, but no requested Maps Data Portability resource groups were authorized.",
        422
      );
    }
    const fingerprint = tokenAccountFingerprint(tokens, authorizedResourceGroups);
    return {
      accounts: [
        {
          accountId: `google_dataportability_${fingerprint}`,
          displayLabel: `Google Data Portability authorization ${fingerprint.slice(0, 8)}`,
          sourceBinding: {
            account_id_verified: false,
            authorized_resource_groups: authorizedResourceGroups,
            denied_resource_groups: snapshot.deniedResourceGroups,
            one_time_resource_groups: snapshot.oneTimeResourceGroups,
            time_based_resource_groups: snapshot.timeBasedResourceGroups,
          },
        },
      ],
      persistenceContext: {
        deniedResourceGroups: snapshot.deniedResourceGroups,
        oneTimeResourceGroups: snapshot.oneTimeResourceGroups,
        timeBasedResourceGroups: snapshot.timeBasedResourceGroups,
      },
    };
  },

  // biome-ignore lint/suspicious/useAwait: implements ProviderAuthAdapter.storeTokens, whose contract is Promise-returning; this adapter's bundle shaping is purely synchronous.
  async storeTokens({ persistenceContext, tokens }) {
    const snapshot = readAccessTypeSnapshot(persistenceContext);
    if (!snapshot) {
      throw new GoogleDataPortabilityProviderAuthError(
        "google_dataportability_access_type_missing",
        "Google Data Portability token access-type inventory was not available for storage.",
        500
      );
    }
    return {
      access_token: tokens.accessToken,
      authorized_resource_groups: [...snapshot.oneTimeResourceGroups, ...snapshot.timeBasedResourceGroups].join(","),
      denied_resource_groups: snapshot.deniedResourceGroups.join(","),
      expires_at: tokens.expiresAt ?? "",
      one_time_resource_groups: snapshot.oneTimeResourceGroups.join(","),
      time_based_resource_groups: snapshot.timeBasedResourceGroups.join(","),
      token_kind: tokens.tokenKind,
    };
  },
};
