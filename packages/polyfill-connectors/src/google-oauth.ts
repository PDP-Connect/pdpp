// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Google OAuth2 credential/provider-settings primitive.
 *
 * Extracted only now that TWO concrete consumers exist — Google Calendar and
 * Google Contacts (both People/Calendar API, both needing a refreshed access
 * token, both sharing the same token endpoint) — per the reconciliation
 * report's rule (§14): "Build one shared Google-OAuth credential resolver
 * when Calendar and Contacts are both underway — not before either exists."
 *
 * This does NOT generalize `google_maps_data_portability` or `strava`: those
 * consume a pre-resolved access token from the deployment/runtime
 * (`GOOGLE_DATAPORTABILITY_ACCESS_TOKEN`, `STRAVA_ACCESS_TOKEN`) and never
 * refresh it themselves. Calendar and Contacts are long-lived incremental
 * syncs (syncToken-based) that can run far apart in time, so this module adds
 * the one genuinely new piece: exchanging a durable refresh_token for a
 * short-lived access_token via Google's token endpoint, with the connector
 * caching the token in-run.
 *
 * Deployment-level app registration (GOOGLE_OAUTH_CLIENT_ID/SECRET) is shared
 * infra, mirroring the existing Gmail credential-resolution pattern (a single
 * Google app registration, connector-specific scopes and refresh tokens).
 */

const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type GoogleOAuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface GoogleAccessToken {
  readonly accessToken: string;
  /** Epoch ms this token expires at, per Google's `expires_in` (seconds). */
  readonly expiresAt: number;
}

export class GoogleOAuthError extends Error {
  readonly bodySnippet: string;
  readonly status: number;
  constructor(status: number, bodySnippet: string) {
    super(`google_oauth_token_error: ${status}`);
    this.name = "GoogleOAuthError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

function assertNonEmpty(value: string | undefined, code: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    throw new Error(code);
  }
  return trimmed;
}

/**
 * Resolve the shared Google OAuth app credentials + this connector's refresh
 * token from the environment. `refreshTokenEnvVar` lets each connector own a
 * distinct refresh token (Calendar and Contacts are typically separate
 * consent grants even against the same app registration) while sharing the
 * client id/secret.
 */
export function resolveGoogleOAuthCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  refreshTokenEnvVar: string
): GoogleOAuthCredentials {
  return {
    clientId: assertNonEmpty(env.GOOGLE_OAUTH_CLIENT_ID, "google_oauth_client_id_missing"),
    clientSecret: assertNonEmpty(env.GOOGLE_OAUTH_CLIENT_SECRET, "google_oauth_client_secret_missing"),
    refreshToken: assertNonEmpty(env[refreshTokenEnvVar], `google_oauth_refresh_token_missing:${refreshTokenEnvVar}`),
  };
}

/**
 * Exchange a refresh_token for a fresh access_token via Google's token
 * endpoint (RFC 6749 §6). Callers cache the result for the run's duration;
 * this function performs no caching itself — it is a single, pure network
 * call so it stays testable with an injected `fetch`.
 */
export async function refreshGoogleAccessToken(
  credentials: GoogleOAuthCredentials,
  options: { fetch?: GoogleOAuthFetch; now?: () => number; tokenUrl?: string } = {}
): Promise<GoogleAccessToken> {
  const fetchImpl = options.fetch ?? fetch;
  const tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new GoogleOAuthError(response.status, text.slice(0, 500));
  }
  const parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
  if (!accessToken) {
    throw new Error("google_oauth_access_token_missing");
  }
  const expiresInSeconds =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
  return { accessToken, expiresAt: now() + expiresInSeconds * 1000 };
}

/**
 * True when a Google API response's error body indicates the grant itself is
 * dead (revoked consent, expired/invalid refresh token) rather than a
 * transient failure. Both Calendar and Contacts connectors use this to
 * distinguish "ask the owner to reconnect" from "retry next run" — matching
 * the reconciliation report's requirement to detect expired-token full-resync
 * conditions explicitly rather than treating every 401 as retryable.
 */
export function isGoogleOAuthGrantInvalid(error: unknown): boolean {
  if (error instanceof GoogleOAuthError) {
    // invalid_grant (400) is Google's documented response for a revoked or
    // expired refresh token. 401 from the token endpoint indicates bad client
    // credentials, which is a deployment-config problem, not owner-fixable —
    // still surfaced as non-retryable so it does not loop forever.
    return error.status === 400 || error.status === 401;
  }
  return false;
}
