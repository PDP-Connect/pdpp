// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A provider-neutral OAuth2 authorization-code exchanger, constructed
 * entirely from a connector manifest's `capabilities.auth` declaration
 * (`authorization_url`, `token_url`, `userinfo_url`, `scopes`,
 * `deployment_config`). This module names no specific provider anywhere in
 * its own source: every URL, scope, and deployment-config key it uses comes
 * from the manifest object passed in at construction time, and every
 * deployment-config *value* is looked up from `env` by the manifest-declared
 * key name — never a literal env var name.
 *
 * Implements the same `ProviderAuthExchangerLike` interface that today's
 * per-provider exchangers implement, so it is a drop-in replacement once a
 * caller decides to route traffic to it. Nothing in this repository routes
 * traffic to this module yet.
 */

export interface Oauth2GenericDeploymentConfigKeyLike {
  readonly key: string;
  readonly label?: string | null;
  readonly secret?: boolean | null;
}

export interface Oauth2GenericManifestAuthLike {
  readonly authorization_url?: string | null;
  readonly deployment_config?: readonly (string | Oauth2GenericDeploymentConfigKeyLike)[] | null;
  readonly exchanger_kind?: string | null;
  readonly scopes?: readonly string[] | null;
  readonly token_url?: string | null;
  readonly userinfo_url?: string | null;
}

export interface Oauth2GenericManifestLike {
  readonly capabilities?: {
    readonly auth?: Oauth2GenericManifestAuthLike | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface Oauth2GenericEnv {
  readonly [key: string]: string | undefined;
}

interface Oauth2GenericProviderAuthOptions {
  readonly credentialStoreFactory: () => {
    capture: (args: {
      connectorInstanceId: string;
      credentialKind: "secret_bundle";
      now: string;
      ownerSubjectId: string;
      secret: string;
    }) => Promise<unknown> | unknown;
  };
  readonly env?: Oauth2GenericEnv;
  readonly fetch?: FetchLike;
  readonly manifest: Oauth2GenericManifestLike;
}

export interface Oauth2GenericProviderAuthTokensLike {
  readonly accessToken: string;
  readonly expiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly tokenKind: string;
}

export interface Oauth2GenericProviderAccountLike {
  readonly accountId: string;
  readonly displayLabel?: string | null;
  readonly sourceBinding?: Record<string, unknown> | null;
}

export interface ProviderAuthExchangerLike {
  exchangeCode: (args: {
    connectorId: string;
    code: string;
    redirectUri: string;
    state: string;
  }) => Promise<Oauth2GenericProviderAuthTokensLike | null> | Oauth2GenericProviderAuthTokensLike | null;
  initiateAuthorization: (args: {
    connectorId: string;
    redirectUri: string;
    state: string;
  }) => Promise<{ authorizationUrl: string }> | { authorizationUrl: string };
  runInventoryOrTest: (args: {
    connectorId: string;
    tokens: Oauth2GenericProviderAuthTokensLike;
  }) => Promise<Oauth2GenericProviderAccountLike[]> | Oauth2GenericProviderAccountLike[];
  storeTokens: (args: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    tokens: Oauth2GenericProviderAuthTokensLike;
    now: string;
  }) => Promise<void> | void;
}

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

function deploymentConfigKeyName(entry: string | Oauth2GenericDeploymentConfigKeyLike): string | null {
  if (typeof entry === "string") {
    return entry.trim() ? entry.trim() : null;
  }
  return typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : null;
}

function deploymentConfigKeyNames(manifest: Oauth2GenericManifestLike): readonly string[] {
  const declared = manifest.capabilities?.auth?.deployment_config;
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared
    .map(deploymentConfigKeyName)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function configuredValue(env: Oauth2GenericEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireManifestUrl(manifest: Oauth2GenericManifestLike, field: "authorization_url" | "token_url"): string {
  const value = manifest.capabilities?.auth?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_manifest_field_missing",
      `Connector manifest capabilities.auth.${field} is missing or empty.`,
      500
    );
  }
  return value.trim();
}

function manifestScopes(manifest: Oauth2GenericManifestLike): readonly string[] {
  const scopes = manifest.capabilities?.auth?.scopes;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
    : [];
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

function manifestConnectorKey(manifest: Oauth2GenericManifestLike): string | null {
  const raw = manifest.connector_key?.trim() || manifest.connector_id?.trim() || "";
  return raw || null;
}

function assertConnector(manifest: Oauth2GenericManifestLike, connectorId: string): void {
  const declaredKey = manifestConnectorKey(manifest);
  if (declaredKey && declaredKey !== connectorId && !connectorId.endsWith(`/${declaredKey}`)) {
    throw new Oauth2GenericProviderAuthError(
      "provider_auth_connector_unsupported",
      `This generic oauth2 exchanger was constructed for connector '${declaredKey}', not '${connectorId}'.`,
      404
    );
  }
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
}): Promise<Oauth2GenericProviderAuthTokensLike | null> {
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

function tokenBundleToSecretBundle(tokens: Oauth2GenericProviderAuthTokensLike): string {
  return JSON.stringify({
    access_token: tokens.accessToken,
    expires_at: tokens.expiresAt ?? "",
    refresh_token: tokens.refreshToken ?? "",
    token_kind: tokens.tokenKind,
  });
}

/**
 * Construct an OAuth2 authorization-code exchanger for exactly one manifest.
 * `manifest.capabilities.auth` supplies authorization_url/token_url/
 * userinfo_url/scopes/deployment_config; `env` supplies the values for
 * whichever deployment-config keys the manifest declares. Neither this
 * function nor anything it calls hardcodes a provider name, URL, scope, or
 * env var name — those all come from the manifest and env arguments.
 */
export function createOauth2GenericProviderAuthExchanger({
  credentialStoreFactory,
  env = process.env,
  fetch: fetchImpl = fetch,
  manifest,
}: Oauth2GenericProviderAuthOptions): ProviderAuthExchangerLike {
  const deploymentKeys = deploymentConfigKeyNames(manifest);
  const [clientIdKey, clientSecretKey] = deploymentKeys;
  if (!(clientIdKey && clientSecretKey)) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_manifest_field_missing",
      "Connector manifest capabilities.auth.deployment_config must declare at least a client id and client secret key.",
      500
    );
  }

  function requireDeploymentValue(key: string): string {
    const value = configuredValue(env, key);
    if (!value) {
      throw new Oauth2GenericProviderAuthError(
        "oauth2_generic_provider_config_missing",
        `Provider app config '${key}' is missing.`,
        503
      );
    }
    return value;
  }

  return {
    exchangeCode({ code, connectorId, redirectUri }) {
      assertConnector(manifest, connectorId);
      return exchangeAuthorizationCode({
        clientId: requireDeploymentValue(clientIdKey),
        clientSecret: requireDeploymentValue(clientSecretKey),
        code,
        fetchImpl,
        redirectUri,
        tokenUrl: requireManifestUrl(manifest, "token_url"),
      });
    },

    initiateAuthorization({ connectorId, redirectUri, state }) {
      assertConnector(manifest, connectorId);
      const clientId = requireDeploymentValue(clientIdKey);
      const scopes = manifestScopes(manifest);
      const url = new URL(requireManifestUrl(manifest, "authorization_url"));
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      return { authorizationUrl: url.toString() };
    },

    async runInventoryOrTest({ connectorId, tokens }): Promise<Oauth2GenericProviderAccountLike[]> {
      assertConnector(manifest, connectorId);
      if (!tokens.refreshToken) {
        throw new Oauth2GenericProviderAuthError(
          "oauth2_generic_refresh_token_missing",
          "Authorization completed, but no refresh_token was returned. " +
            "Re-authorize with prompt=consent (already set) — a refresh_token is only " +
            "issued on the first consent for a given client+account pair.",
          422
        );
      }
      const userinfoUrl = manifest.capabilities?.auth?.userinfo_url;
      if (typeof userinfoUrl !== "string" || !userinfoUrl.trim()) {
        throw new Oauth2GenericProviderAuthError(
          "oauth2_generic_manifest_field_missing",
          "Connector manifest capabilities.auth.userinfo_url is missing or empty.",
          500
        );
      }
      const { email, id } = await fetchUserinfo(userinfoUrl.trim(), tokens.accessToken, fetchImpl);
      const accountId = id ?? email;
      if (!accountId) {
        throw new Oauth2GenericProviderAuthError(
          "oauth2_generic_identity_unavailable",
          "Authorization completed, but no account identity (id or email) was returned.",
          422
        );
      }
      return [
        {
          accountId,
          displayLabel: email ?? accountId,
          sourceBinding: {
            account_email: email,
            account_id_verified: true,
          },
        },
      ];
    },

    async storeTokens({ connectorInstanceId, ownerSubjectId, tokens, now }) {
      await credentialStoreFactory().capture({
        connectorInstanceId,
        credentialKind: "secret_bundle",
        now,
        ownerSubjectId,
        secret: tokenBundleToSecretBundle(tokens),
      });
    },
  };
}
