// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Google OAuth owner-account provider-auth adapter for Google Calendar
 * and Google Contacts.
 *
 * A sibling `ProviderAuthExchanger` implementation, deliberately independent
 * of `google-data-portability.ts` (no shared imports, no shared env-var
 * namespace). Both hit the same Google `/o/oauth2/v2/auth` and
 * `https://oauth2.googleapis.com/token` endpoints because that is Google's one
 * authorization/token endpoint pair, not because the two adapters are
 * coupled. Do not import from `google-data-portability.ts`, and do not add
 * `google-calendar`/`google-contacts` to that file's connector allowlist.
 *
 * Captures a durable refresh_token per connection (Calendar and Contacts are
 * long-lived incremental syncs, unlike Data Portability's one-shot access
 * token), and hands it off at run time through
 * `provider-auth-run-credentials.ts` into the exact env var
 * (`GOOGLE_CALENDAR_REFRESH_TOKEN` / `GOOGLE_CONTACTS_REFRESH_TOKEN`) each
 * connector already reads via `packages/polyfill-connectors/src/google-oauth.ts`
 * — that refresh-leg module is untouched; this file only replaces "operator
 * pastes a refresh token into deployment env" with a real owner-consent flow.
 */

export const GOOGLE_OWNER_ACCOUNT_CONNECTOR_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "google-calendar": ["https://www.googleapis.com/auth/calendar.readonly"],
  "google-contacts": ["https://www.googleapis.com/auth/contacts.readonly"],
});

export const GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS: readonly string[] = Object.freeze(
  Object.keys(GOOGLE_OWNER_ACCOUNT_CONNECTOR_SCOPES)
);

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const REQUIRED_ENV_KEYS = Object.freeze(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface GoogleOwnerAccountEnv {
  readonly [key: string]: string | undefined;
}

interface GoogleOwnerAccountProviderAuthOptions {
  readonly credentialStoreFactory: () => {
    capture: (args: {
      connectorInstanceId: string;
      credentialKind: "secret_bundle";
      now: string;
      ownerSubjectId: string;
      secret: string;
    }) => Promise<unknown> | unknown;
  };
  readonly env?: GoogleOwnerAccountEnv;
  readonly fetch?: FetchLike;
}

export interface ProviderAuthTokensLike {
  readonly accessToken: string;
  readonly expiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly tokenKind: string;
}

export interface ProviderAccountLike {
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
  }) => Promise<ProviderAuthTokensLike | null> | ProviderAuthTokensLike | null;
  initiateAuthorization: (args: {
    connectorId: string;
    redirectUri: string;
    state: string;
  }) => Promise<{ authorizationUrl: string }> | { authorizationUrl: string };
  runInventoryOrTest: (args: {
    connectorId: string;
    tokens: ProviderAuthTokensLike;
  }) => Promise<ProviderAccountLike[]> | ProviderAccountLike[];
  storeTokens: (args: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    tokens: ProviderAuthTokensLike;
    now: string;
  }) => Promise<void> | void;
}

export class GoogleOwnerAccountProviderAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "GoogleOwnerAccountProviderAuthError";
    this.code = code;
    this.status = status;
  }
}

function configuredValue(env: GoogleOwnerAccountEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireConfiguredValue(env: GoogleOwnerAccountEnv, key: string): string {
  const value = configuredValue(env, key);
  if (!value) {
    throw new GoogleOwnerAccountProviderAuthError(
      "google_owner_account_provider_config_missing",
      `Google owner-account provider app config '${key}' is missing.`,
      503
    );
  }
  return value;
}

export function hasGoogleOwnerAccountProviderAuthConfig(env: GoogleOwnerAccountEnv = process.env): boolean {
  return REQUIRED_ENV_KEYS.every((key) => configuredValue(env, key) !== null);
}

export function configuredGoogleOwnerAccountProviderAuthConnectorKeys(
  env: GoogleOwnerAccountEnv = process.env
): readonly string[] {
  return hasGoogleOwnerAccountProviderAuthConfig(env) ? GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS : [];
}

function assertConnector(connectorId: string): void {
  if (!GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS.includes(connectorId)) {
    throw new GoogleOwnerAccountProviderAuthError(
      "provider_auth_connector_unsupported",
      `Google owner-account provider auth does not handle connector '${connectorId}'.`,
      404
    );
  }
}

function scopesForConnector(connectorId: string): readonly string[] {
  const scopes = GOOGLE_OWNER_ACCOUNT_CONNECTOR_SCOPES[connectorId];
  if (!scopes) {
    throw new GoogleOwnerAccountProviderAuthError(
      "provider_auth_connector_unsupported",
      `Google owner-account provider auth does not handle connector '${connectorId}'.`,
      404
    );
  }
  return scopes;
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

/**
 * Duplicated (not imported) from google-data-portability.ts's equivalent
 * ~15-line POST — same Google token endpoint by construction, kept decoupled
 * per this file's own no-coupling requirement.
 */
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
}): Promise<ProviderAuthTokensLike | null> {
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
    expiresAt: nowPlusSeconds(body.expires_in),
    refreshToken: asString(body.refresh_token),
    tokenKind: asString(body.token_type) ?? "Bearer",
  };
}

/**
 * Resolve the authorizing Google account's stable id/email via Google's
 * userinfo endpoint — a real account identity, unlike Data Portability's
 * token-fingerprint-as-identity pattern (which has no per-account concept).
 */
async function fetchGoogleUserinfo(
  accessToken: string,
  fetchImpl: FetchLike
): Promise<{ email: string | null; id: string | null }> {
  const response = await fetchImpl(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new GoogleOwnerAccountProviderAuthError(
      "google_owner_account_userinfo_failed",
      `Google userinfo request failed with status ${response.status}.`,
      502
    );
  }
  const body = asObject(JSON.parse(await response.text()));
  return { email: asString(body.email), id: asString(body.id) };
}

function tokenBundleToSecretBundle(tokens: ProviderAuthTokensLike): string {
  return JSON.stringify({
    google_owner_account_access_token: tokens.accessToken,
    google_owner_account_expires_at: tokens.expiresAt ?? "",
    google_owner_account_refresh_token: tokens.refreshToken ?? "",
    google_owner_account_token_kind: tokens.tokenKind,
  });
}

/**
 * `redirectUri` is not validated against a separately-configured value (unlike
 * Data Portability's GOOGLE_DATAPORTABILITY_REDIRECT_URI check) — the route
 * layer (`ref-provider-auth.ts`'s `buildCallbackRedirectUri`) is this
 * exchanger's only caller and always constructs the one canonical
 * `/_ref/provider-auth/callback` URL for both `initiateAuthorization` and
 * `exchangeCode`, so the two calls are structurally guaranteed to agree
 * without a second source of truth to keep in sync.
 */
export function createGoogleOwnerAccountProviderAuthExchanger({
  credentialStoreFactory,
  env = process.env,
  fetch: fetchImpl = fetch,
}: GoogleOwnerAccountProviderAuthOptions): ProviderAuthExchangerLike {
  return {
    exchangeCode({ code, connectorId, redirectUri }) {
      assertConnector(connectorId);
      return exchangeGoogleCode({
        clientId: requireConfiguredValue(env, "GOOGLE_OAUTH_CLIENT_ID"),
        clientSecret: requireConfiguredValue(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
        code,
        fetchImpl,
        redirectUri,
      });
    },

    initiateAuthorization({ connectorId, redirectUri, state }) {
      assertConnector(connectorId);
      const clientId = requireConfiguredValue(env, "GOOGLE_OAUTH_CLIENT_ID");
      const scopes = scopesForConnector(connectorId);
      const url = new URL(AUTHORIZATION_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      // access_type=offline + client_secret is Google's documented pattern for
      // a confidential/server-side client requesting a durable refresh_token;
      // PKCE is not required for this client type and is omitted here for
      // parity with the proven Data Portability adapter.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      return { authorizationUrl: url.toString() };
    },

    async runInventoryOrTest({ connectorId, tokens }): Promise<ProviderAccountLike[]> {
      assertConnector(connectorId);
      if (!tokens.refreshToken) {
        throw new GoogleOwnerAccountProviderAuthError(
          "google_owner_account_refresh_token_missing",
          "Google authorization completed, but no refresh_token was returned. " +
            "Re-authorize with prompt=consent (already set) — a refresh_token is only " +
            "issued on the first consent for a given client+account pair.",
          422
        );
      }
      const { email, id } = await fetchGoogleUserinfo(tokens.accessToken, fetchImpl);
      const accountId = id ?? email;
      if (!accountId) {
        throw new GoogleOwnerAccountProviderAuthError(
          "google_owner_account_identity_unavailable",
          "Google authorization completed, but no account identity (id or email) was returned.",
          422
        );
      }
      return [
        {
          accountId: `google_owner_account_${accountId}`,
          displayLabel: email ?? accountId,
          sourceBinding: {
            account_email: email,
            account_id_verified: true,
            provider: "google_owner_account",
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
