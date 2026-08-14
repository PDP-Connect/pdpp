// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Introspection and RFC 7592 client-delete revocation for owner-agent
// credentials. These preserve the existing reference behavior so a revoked
// owner-agent credential stops working and an active one can be confirmed
// without printing the bearer.

import { readFile } from "node:fs/promises";

import { OwnerAgentError } from "./errors.ts";

type FetchFn = typeof fetch;
const TRAILING_SLASHES_RE = /\/+$/;

export interface OwnerAgentCredentialRecord {
  access_token?: string;
  client_id?: string;
  credential?: { access_token?: string; expires_at?: string | null; scope?: string | null };
  expires_at?: string | null;
  introspection_endpoint?: string;
  pdpp_token_kind?: string;
  registration_client_uri?: string;
  resource?: string;
  scope?: string | null;
  [key: string]: unknown;
}

export interface IntrospectionResult {
  active: boolean;
  client_id: string | null;
  exp: number | null;
  scope: string | null;
  sub: string | null;
  token_kind: string | null;
}

interface IntrospectOwnerAgentCredentialArgs {
  fetchFn: FetchFn;
  record: OwnerAgentCredentialRecord;
}

/**
 * Introspect a stored owner-agent credential. Returns the non-secret subset of
 * the introspection response (`active`, `token_kind`/`pdpp_token_kind`, `sub`,
 * `client_id`, `exp`, `scope`). Never returns the bearer.
 */
export async function introspectOwnerAgentCredential({
  fetchFn,
  record,
}: IntrospectOwnerAgentCredentialArgs): Promise<IntrospectionResult> {
  if (!record.introspection_endpoint) {
    throw new OwnerAgentError("introspection_unavailable", "Stored credential has no introspection endpoint.");
  }
  const token = getOwnerAgentAccessToken(record);
  if (!token) {
    throw new OwnerAgentError("credential_invalid", "Stored credential is missing an access token.");
  }
  const body = new URLSearchParams();
  body.set("token", token);
  let response: Response;
  try {
    response = await fetchFn(record.introspection_endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: body.toString(),
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError has no cause slot; the original error's message is already folded into this one.
    throw new OwnerAgentError("request_failed", `Introspection request failed: ${(error as Error).message}.`);
  }
  if (!response.ok) {
    // `/introspect` is AS↔RS infrastructure and, after the authorization
    // hardening stack, requires the confidential RS caller credentials. An
    // owner agent must not be given those credentials. When the deployment
    // exposes the owner-agent control surface, use its bearer-authenticated
    // capability document as the owner credential's liveness check instead.
    if ((response.status === 401 || response.status === 403) && record.resource) {
      return await checkOwnerAgentControlSurface({ fetchFn, record });
    }
    throw new OwnerAgentError("introspection_failed", `Introspection failed with HTTP ${response.status}.`);
  }
  let json: {
    active?: boolean;
    pdpp_token_kind?: string;
    token_kind?: string;
    sub?: string;
    client_id?: string;
    exp?: number;
    scope?: string;
  };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError has no cause slot; the parse error carries no owner-facing detail beyond "invalid JSON".
    throw new OwnerAgentError("introspection_failed", "Introspection response was not valid JSON.");
  }
  return {
    active: Boolean(json.active),
    token_kind: json.pdpp_token_kind ?? json.token_kind ?? null,
    sub: json.sub ?? null,
    client_id: json.client_id ?? null,
    exp: json.exp ?? null,
    scope: json.scope ?? null,
  };
}

async function checkOwnerAgentControlSurface({
  fetchFn,
  record,
}: IntrospectOwnerAgentCredentialArgs): Promise<IntrospectionResult> {
  const token = getOwnerAgentAccessToken(record);
  const resource = record.resource?.replace(TRAILING_SLASHES_RE, "");
  if (!(token && resource)) {
    throw new OwnerAgentError("credential_invalid", "Stored credential is missing an owner control resource.");
  }
  let response: Response;
  try {
    response = await fetchFn(`${resource}/v1/owner/control`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError has no cause slot; the original error's message is already folded into this one.
    throw new OwnerAgentError("request_failed", `Owner-agent status request failed: ${(error as Error).message}.`);
  }
  if (response.status === 401 || response.status === 403) {
    return {
      active: false,
      client_id: typeof record.client_id === "string" ? record.client_id : null,
      exp: credentialExpiry(record),
      scope: typeof record.scope === "string" ? record.scope : null,
      sub: null,
      token_kind: typeof record.pdpp_token_kind === "string" ? record.pdpp_token_kind : "owner",
    };
  }
  if (!response.ok) {
    throw new OwnerAgentError("introspection_failed", `Owner-agent status failed with HTTP ${response.status}.`);
  }
  return {
    active: true,
    client_id: typeof record.client_id === "string" ? record.client_id : null,
    exp: credentialExpiry(record),
    scope: typeof record.scope === "string" ? record.scope : null,
    sub: null,
    token_kind: typeof record.pdpp_token_kind === "string" ? record.pdpp_token_kind : "owner",
  };
}

function credentialExpiry(record: OwnerAgentCredentialRecord): number | null {
  const value = record.expires_at ?? record.credential?.expires_at ?? null;
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

interface RevokeOwnerAgentCredentialArgs {
  fetchFn: FetchFn;
  ownerSessionCookie: string | undefined;
  record: OwnerAgentCredentialRecord;
}

export interface RevocationResult {
  already_absent?: boolean;
  revoked: boolean;
}

/**
 * Revoke an owner-agent credential via RFC 7592 client delete. The reference
 * implementation authenticates this route with the owner session for the
 * approving owner, not with a registration access token.
 */
export async function revokeOwnerAgentCredential({
  fetchFn,
  record,
  ownerSessionCookie,
}: RevokeOwnerAgentCredentialArgs): Promise<RevocationResult> {
  const uri = record.registration_client_uri;
  if (!uri) {
    throw new OwnerAgentError(
      "revocation_unavailable",
      "Stored credential has no RFC 7592 registration handle (registration_client_uri). " +
        "Revoke it from the owner dashboard instead."
    );
  }
  if (!ownerSessionCookie) {
    throw new OwnerAgentError(
      "owner_session_required",
      "Revocation requires an owner session. Run `pdpp ref login <authorization-server>` first, or set PDPP_OWNER_SESSION_COOKIE.",
      5
    );
  }
  let response: Response;
  try {
    response = await fetchFn(uri, {
      method: "DELETE",
      headers: { Cookie: normalizeOwnerSessionCookie(ownerSessionCookie), Accept: "application/json" },
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError has no cause slot; the original error's message is already folded into this one.
    throw new OwnerAgentError("request_failed", `Revocation request failed: ${(error as Error).message}.`);
  }
  // RFC 7592 specifies 204 No Content on successful delete.
  if (response.status === 204 || response.status === 200) {
    return { revoked: true };
  }
  if (response.status === 401 || response.status === 403) {
    throw new OwnerAgentError("revocation_unauthorized", `Revocation rejected (HTTP ${response.status}).`, 4);
  }
  if (response.status === 404) {
    // Already gone is an acceptable terminal state for revocation.
    return { revoked: true, already_absent: true };
  }
  throw new OwnerAgentError("revocation_failed", `Revocation failed with HTTP ${response.status}.`);
}

export function getOwnerAgentAccessToken(record: OwnerAgentCredentialRecord | undefined | null): string | null {
  return record?.access_token ?? record?.credential?.access_token ?? null;
}

export async function readCredentialRecord(targetPath: string): Promise<OwnerAgentCredentialRecord> {
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // biome-ignore lint/style/useErrorCause: OwnerAgentError has no cause slot; ENOENT carries no extra detail beyond "file absent", already conveyed by this message.
      throw new OwnerAgentError("not_onboarded", `No owner-agent credential found at ${targetPath}.`, 5);
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError has no cause slot; the JSON.parse error's message is not owner-facing (path context is more useful here).
    throw new OwnerAgentError("credential_invalid", `Owner-agent credential at ${targetPath} is not valid JSON.`);
  }
}

function normalizeOwnerSessionCookie(value: string): string {
  const raw = String(value || "").trim();
  return raw.includes("=") ? raw : `pdpp_owner_session=${raw}`;
}
