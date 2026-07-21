import { createHash } from "node:crypto";

import {
  GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES,
  GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS,
  GoogleDataPortabilityClient,
} from "../../../packages/polyfill-connectors/connectors/google_maps_data_portability/api.ts";
import type { ProviderAccount, ProviderAuthExchanger, ProviderAuthTokens } from "../routes/ref-provider-auth.ts";

export const GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY = "google-maps-data-portability";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUIRED_ENV_KEYS = Object.freeze([
  "GOOGLE_DATAPORTABILITY_CLIENT_ID",
  "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
  "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
]);

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface GoogleDataPortabilityEnv {
  readonly [key: string]: string | undefined;
}

interface AccessTypeSnapshot {
  readonly deniedResourceGroups: readonly string[];
  readonly oneTimeResourceGroups: readonly string[];
  readonly timeBasedResourceGroups: readonly string[];
}

interface GoogleDataPortabilityProviderAuthOptions {
  readonly credentialStoreFactory: () => {
    capture(args: {
      connectorInstanceId: string;
      credentialKind: "secret_bundle";
      now: string;
      ownerSubjectId: string;
      secret: string;
    }): Promise<unknown> | unknown;
  };
  readonly env?: GoogleDataPortabilityEnv;
  readonly fetch?: FetchLike;
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

function configuredValue(env: GoogleDataPortabilityEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireConfiguredValue(env: GoogleDataPortabilityEnv, key: string): string {
  const value = configuredValue(env, key);
  if (!value) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_provider_config_missing",
      `Google Data Portability provider app config '${key}' is missing.`,
      503
    );
  }
  return value;
}

export function hasGoogleDataPortabilityProviderAuthConfig(env: GoogleDataPortabilityEnv = process.env): boolean {
  return REQUIRED_ENV_KEYS.every((key) => configuredValue(env, key) !== null);
}

export function configuredGoogleDataPortabilityProviderAuthConnectorKeys(
  env: GoogleDataPortabilityEnv = process.env
): readonly string[] {
  return hasGoogleDataPortabilityProviderAuthConfig(env) ? [GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY] : [];
}

function parseResourceGroups(value: string | null): readonly string[] {
  if (!value) {
    return GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS;
  }
  const parsed = value.trim().startsWith("[")
    ? JSON.parse(value)
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  if (!Array.isArray(parsed)) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_resource_groups_invalid",
      "GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS must be a JSON array or comma-separated list.",
      500
    );
  }
  const allowed = new Set(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS);
  const unique = [
    ...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)),
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

function resourceGroupsFromEnv(env: GoogleDataPortabilityEnv): readonly string[] {
  return parseResourceGroups(configuredValue(env, "GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS"));
}

function scopesForResourceGroups(resourceGroups: readonly string[]): readonly string[] {
  return resourceGroups.map((resourceGroup) => `https://www.googleapis.com/auth/dataportability.${resourceGroup}`);
}

function assertConnector(connectorId: string): void {
  if (connectorId !== GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY) {
    throw new GoogleDataPortabilityProviderAuthError(
      "provider_auth_connector_unsupported",
      `Google Data Portability provider auth does not handle connector '${connectorId}'.`,
      404
    );
  }
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

function accessTypeSnapshotToSecretBundle(tokens: ProviderAuthTokens, snapshot: AccessTypeSnapshot): string {
  return JSON.stringify({
    google_dataportability_access_token: tokens.accessToken,
    google_dataportability_refresh_token: tokens.refreshToken ?? "",
    google_dataportability_token_kind: tokens.tokenKind,
    google_dataportability_expires_at: tokens.expiresAt ?? "",
    google_dataportability_authorized_resource_groups: [
      ...snapshot.oneTimeResourceGroups,
      ...snapshot.timeBasedResourceGroups,
    ].join(","),
    google_dataportability_one_time_resource_groups: snapshot.oneTimeResourceGroups.join(","),
    google_dataportability_time_based_resource_groups: snapshot.timeBasedResourceGroups.join(","),
    google_dataportability_denied_resource_groups: snapshot.deniedResourceGroups.join(","),
  });
}

async function exchangeGoogleCode({
  clientId,
  clientSecret,
  code,
  fetchImpl,
  redirectUri,
}: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly fetchImpl: FetchLike;
  readonly redirectUri: string;
}): Promise<ProviderAuthTokens | null> {
  const response = await fetchImpl(TOKEN_URL, {
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
    refreshToken: asString(body.refresh_token),
    tokenKind: asString(body.token_type) ?? "Bearer",
    expiresAt: nowPlusSeconds(body.expires_in),
  };
}

export function createGoogleDataPortabilityProviderAuthExchanger({
  credentialStoreFactory,
  env = process.env,
  fetch: fetchImpl = fetch,
}: GoogleDataPortabilityProviderAuthOptions): ProviderAuthExchanger {
  const accessByToken = new Map<string, AccessTypeSnapshot>();

  return {
    initiateAuthorization({ connectorId, redirectUri, state }) {
      assertConnector(connectorId);
      const clientId = requireConfiguredValue(env, "GOOGLE_DATAPORTABILITY_CLIENT_ID");
      const configuredRedirectUri = requireConfiguredValue(env, "GOOGLE_DATAPORTABILITY_REDIRECT_URI");
      if (redirectUri !== configuredRedirectUri) {
        throw new GoogleDataPortabilityProviderAuthError(
          "google_dataportability_redirect_uri_mismatch",
          "Google Data Portability redirect URI does not match GOOGLE_DATAPORTABILITY_REDIRECT_URI.",
          500
        );
      }
      const resourceGroups = resourceGroupsFromEnv(env);
      const url = new URL(AUTHORIZATION_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopesForResourceGroups(resourceGroups).join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      return { authorizationUrl: url.toString() };
    },

    exchangeCode({ code, connectorId, redirectUri }) {
      assertConnector(connectorId);
      const configuredRedirectUri = requireConfiguredValue(env, "GOOGLE_DATAPORTABILITY_REDIRECT_URI");
      if (redirectUri !== configuredRedirectUri) {
        throw new GoogleDataPortabilityProviderAuthError(
          "google_dataportability_redirect_uri_mismatch",
          "Google Data Portability redirect URI does not match GOOGLE_DATAPORTABILITY_REDIRECT_URI.",
          500
        );
      }
      return exchangeGoogleCode({
        clientId: requireConfiguredValue(env, "GOOGLE_DATAPORTABILITY_CLIENT_ID"),
        clientSecret: requireConfiguredValue(env, "GOOGLE_DATAPORTABILITY_CLIENT_SECRET"),
        code,
        fetchImpl,
        redirectUri,
      });
    },

    async runInventoryOrTest({ connectorId, tokens }): Promise<ProviderAccount[]> {
      assertConnector(connectorId);
      const resourceGroups = resourceGroupsFromEnv(env);
      const client = new GoogleDataPortabilityClient({
        accessToken: tokens.accessToken,
        fetch: fetchImpl,
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
      accessByToken.set(tokens.accessToken, snapshot);
      const fingerprint = tokenAccountFingerprint(tokens, authorizedResourceGroups);
      return [
        {
          accountId: `google_dataportability_${fingerprint}`,
          displayLabel: `Google Data Portability authorization ${fingerprint.slice(0, 8)}`,
          sourceBinding: {
            provider: "google_data_portability",
            account_id_verified: false,
            authorized_resource_groups: authorizedResourceGroups,
            denied_resource_groups: snapshot.deniedResourceGroups,
            one_time_resource_groups: snapshot.oneTimeResourceGroups,
            time_based_resource_groups: snapshot.timeBasedResourceGroups,
          },
        },
      ];
    },

    async storeTokens({ connectorInstanceId, ownerSubjectId, tokens, now }) {
      const snapshot = accessByToken.get(tokens.accessToken);
      if (!snapshot) {
        throw new GoogleDataPortabilityProviderAuthError(
          "google_dataportability_access_type_missing",
          "Google Data Portability token access-type inventory was not available for storage.",
          500
        );
      }
      await credentialStoreFactory().capture({
        connectorInstanceId,
        ownerSubjectId,
        credentialKind: "secret_bundle",
        secret: accessTypeSnapshotToSecretBundle(tokens, snapshot),
        now,
      });
    },
  };
}

export function googleDataPortabilityScopesForConfiguredEnv(
  env: GoogleDataPortabilityEnv = process.env
): readonly string[] {
  const resourceGroups = resourceGroupsFromEnv(env);
  const allScopes = new Set(GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES);
  return scopesForResourceGroups(resourceGroups).filter((scope) => allScopes.has(scope));
}
