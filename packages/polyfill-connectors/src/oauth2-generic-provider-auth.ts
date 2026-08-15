// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A provider-neutral OAuth2 authorization-code adapter, constructed
 * entirely from a connector manifest's `capabilities.auth` declaration
 * (`authorization_url`, `token_url`, `userinfo_url`, `scopes`,
 * `authorization_params`, `deployment_config`). This module names no
 * specific provider anywhere in its own source: every URL, scope, and
 * deployment-config value it uses comes from the manifest and the injected
 * deployment-config resolver — never a literal env var name, and never an
 * implicit default query parameter.
 *
 * Registers itself under the "oauth2_generic" kind at module load.
 */

import type {
  DeploymentConfigResolver,
  ProviderAuthAdapter,
  ProviderAuthInventoryResult,
  ProviderAuthManifestLike,
  ProviderAuthTokens,
} from "./provider-auth-adapter.ts";
import { deploymentConfigEntries, identityGroup, manifestAuth } from "./provider-auth-adapter.ts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class Oauth2GenericProviderAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "Oauth2GenericProviderAuthError";
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
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_provider_config_missing",
      `Provider app config '${entry.logicalKey}' is missing.`,
      503
    );
  }
  return value;
}

function requireManifestUrl(manifest: ProviderAuthManifestLike, field: "authorization_url" | "token_url"): string {
  const value = manifestAuth(manifest)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_manifest_field_missing",
      `Connector manifest capabilities.auth.${field} is missing or empty.`,
      500
    );
  }
  return value.trim();
}

function manifestScopes(manifest: ProviderAuthManifestLike): readonly string[] {
  const scopes = manifestAuth(manifest)?.scopes;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
    : [];
}

function manifestAuthorizationParams(manifest: ProviderAuthManifestLike): Readonly<Record<string, string>> {
  const params = manifestAuth(manifest)?.authorization_params;
  if (!params || typeof params !== "object") {
    return {};
  }
  const entries = Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
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

async function exchangeAuthorizationCode({
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

async function fetchUserinfo(
  userinfoUrl: string,
  accessToken: string,
  fetchImpl: FetchLike
): Promise<{ email: string | null; id: string | null }> {
  const response = await fetchImpl(userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_userinfo_failed",
      `Provider userinfo request failed with status ${response.status}.`,
      502
    );
  }
  const body = asObject(JSON.parse(await response.text()));
  return { email: asString(body.email), id: asString(body.id) };
}

function tokenBundleToGenericFields(tokens: ProviderAuthTokens): Record<string, string> {
  return {
    access_token: tokens.accessToken,
    expires_at: tokens.expiresAt ?? "",
    refresh_token: tokens.refreshToken ?? "",
    token_kind: tokens.tokenKind,
  };
}

const defaultFetchImpl: FetchLike = (url, init) => fetch(url, init);

export const OAUTH2_GENERIC_EXCHANGER_KIND = "oauth2_generic";

export const oauth2GenericAdapter: ProviderAuthAdapter = {
  async exchangeCode({ code, deploymentConfigResolver, manifest, redirectUri }) {
    const entries = deploymentConfigEntries(manifest);
    const [clientIdEntry, clientSecretEntry] = entries;
    if (!(clientIdEntry && clientSecretEntry)) {
      throw new Oauth2GenericProviderAuthError(
        "oauth2_generic_manifest_field_missing",
        "Connector manifest capabilities.auth.deployment_config must declare at least a client id and client secret key.",
        500
      );
    }
    const [clientId, clientSecret] = await Promise.all([
      resolveDeploymentValue(deploymentConfigResolver, manifest, clientIdEntry),
      resolveDeploymentValue(deploymentConfigResolver, manifest, clientSecretEntry),
    ]);
    return exchangeAuthorizationCode({
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
    const [clientIdEntry] = entries;
    if (!clientIdEntry) {
      throw new Oauth2GenericProviderAuthError(
        "oauth2_generic_manifest_field_missing",
        "Connector manifest capabilities.auth.deployment_config must declare at least a client id key.",
        500
      );
    }
    const clientId = await resolveDeploymentValue(deploymentConfigResolver, manifest, clientIdEntry);
    const scopes = manifestScopes(manifest);
    const url = new URL(requireManifestUrl(manifest, "authorization_url"));
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    // The `scope` param is always a REPLACE of the manifest's declared list,
    // never a union with any prior grant this adapter knows about — this
    // adapter holds no state across authorizations. Whether the provider
    // itself unions this request's scopes with an already-granted set for
    // the same client+account (Google's `include_granted_scopes`) is a
    // manifest-declared `authorization_params` entry, applied verbatim
    // below; a manifest whose connectors share one `provider_identity_group`
    // (multiple separate consent flows against the same app) should
    // generally declare `include_granted_scopes: "true"` so authorizing a
    // second connector does not silently narrow an already-granted first
    // connector's scope on that account — see
    // oauth2-generic-provider-auth.test.ts's include_granted_scopes coverage.
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    for (const [key, value] of Object.entries(manifestAuthorizationParams(manifest))) {
      url.searchParams.set(key, value);
    }
    return { authorizationUrl: url.toString() };
  },

  async runInventoryOrTest({ manifest, tokens }): Promise<ProviderAuthInventoryResult> {
    if (!tokens.refreshToken) {
      throw new Oauth2GenericProviderAuthError(
        "oauth2_generic_refresh_token_missing",
        "Authorization completed, but no refresh_token was returned. " +
          "Re-authorize with the manifest's declared consent parameters — a refresh_token is only " +
          "issued on the first consent for a given client+account pair.",
        422
      );
    }
    const userinfoUrl = manifestAuth(manifest)?.userinfo_url;
    if (typeof userinfoUrl !== "string" || !userinfoUrl.trim()) {
      throw new Oauth2GenericProviderAuthError(
        "oauth2_generic_manifest_field_missing",
        "Connector manifest capabilities.auth.userinfo_url is missing or empty.",
        500
      );
    }
    const { email, id } = await fetchUserinfo(userinfoUrl.trim(), tokens.accessToken, defaultFetchImpl);
    const accountId = id ?? email;
    if (!accountId) {
      throw new Oauth2GenericProviderAuthError(
        "oauth2_generic_identity_unavailable",
        "Authorization completed, but no account identity (id or email) was returned.",
        422
      );
    }
    return {
      accounts: [
        {
          accountId,
          displayLabel: email ?? accountId,
          sourceBinding: {
            account_email: email,
            account_id_verified: true,
          },
        },
      ],
    };
  },

  // biome-ignore lint/suspicious/useAwait: implements ProviderAuthAdapter.storeTokens, whose contract is Promise-returning; this adapter's bundle shaping is purely synchronous.
  async storeTokens({ tokens }) {
    return tokenBundleToGenericFields(tokens);
  },
};
