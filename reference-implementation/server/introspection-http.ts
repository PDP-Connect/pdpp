// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { resolveSourceIntrospectionContext, SourceIntrospectionContextError } from "./source-introspection-context.ts";

const BASIC_AUTHORIZATION_PATTERN = /^Basic\s+([^\s]+)$/i;

export interface IntrospectionCallerCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface RemoteIntrospectionConfig extends IntrospectionCallerCredentials {
  readonly endpoint: string;
  readonly expectedAudience: () => string | null;
  readonly expectedIssuer: () => string | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export type RemoteIntrospectionInfo = Record<string, unknown> & {
  active: boolean;
  inactive_reason?: string;
};

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretsEqual(left: string, right: string): boolean {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}

function parseBasicCredentials(authorization: string | undefined): IntrospectionCallerCredentials | null {
  const match = BASIC_AUTHORIZATION_PATTERN.exec(authorization ?? "");
  if (!match?.[1]) {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

export function authenticateIntrospectionCaller(
  authorization: string | undefined,
  expected: IntrospectionCallerCredentials
): boolean {
  const presented = parseBasicCredentials(authorization);
  return !!(
    presented &&
    secretsEqual(presented.clientId, expected.clientId) &&
    secretsEqual(presented.clientSecret, expected.clientSecret)
  );
}

export function basicIntrospectionAuthorization(credentials: IntrospectionCallerCredentials): string {
  return `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`, "utf8").toString("base64")}`;
}

function inactive(reason: string): RemoteIntrospectionInfo {
  return { active: false, inactive_reason: reason };
}

function inactiveWhen(valid: boolean, reason: string): RemoteIntrospectionInfo | null {
  return valid ? null : inactive(reason);
}

function firstInactive(results: readonly (RemoteIntrospectionInfo | null)[]): RemoteIntrospectionInfo | null {
  return results.find((result): result is RemoteIntrospectionInfo => result !== null) ?? null;
}

function audienceMatches(value: unknown, expected: string): boolean {
  return typeof value === "string" && value === expected;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireClientIdentity(info: Record<string, unknown>): RemoteIntrospectionInfo | null {
  return inactiveWhen(
    isNonEmptyString(info.client_id) && isNonEmptyString(info.subject_id) && isNonEmptyString(info.grant_id),
    "context.identity_mismatch"
  );
}

function validateClientAuthorizationContext(info: Record<string, unknown>): RemoteIntrospectionInfo | null {
  const identityFailure = requireClientIdentity(info);
  if (identityFailure) {
    return identityFailure;
  }
  try {
    Object.assign(info, resolveSourceIntrospectionContext(info));
    return null;
  } catch (error: unknown) {
    return inactive(error instanceof SourceIntrospectionContextError ? error.code : "context.rights_missing");
  }
}

function requirePackageIdentity(info: Record<string, unknown>): RemoteIntrospectionInfo | null {
  return inactiveWhen(
    isNonEmptyString(info.client_id) && isNonEmptyString(info.subject_id) && isNonEmptyString(info.grant_package_id),
    "context.identity_mismatch"
  );
}

function grantPackage(info: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(info.package) ? info.package : null;
}

function packageIdentityMatches(value: Record<string, unknown> | null, info: Record<string, unknown>): boolean {
  const client = isRecord(value?.client) ? value.client.client_id : null;
  const subject = isRecord(value?.subject) ? value.subject.id : null;
  return client === info.client_id && subject === info.subject_id;
}

function validatePackageAuthorizationContext(info: Record<string, unknown>): RemoteIntrospectionInfo | null {
  const value = grantPackage(info);
  return firstInactive([
    requirePackageIdentity(info),
    inactiveWhen(value !== null, "context.rights_missing"),
    inactiveWhen(packageIdentityMatches(value, info), "context.identity_mismatch"),
    inactiveWhen(value?.package_id === info.grant_package_id, "context.grant_mismatch"),
  ]);
}

function validateOwnerAuthorizationContext(info: Record<string, unknown>): RemoteIntrospectionInfo | null {
  return isNonEmptyString(info.subject_id) ? null : inactive("context.identity_mismatch");
}

function validateResponseLifetime(info: Record<string, unknown>, nowSeconds: number): RemoteIntrospectionInfo | null {
  const isFutureOrAbsent = (value: unknown) =>
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value > nowSeconds);
  return firstInactive([
    inactiveWhen(isFutureOrAbsent(info.exp), "context.expired"),
    inactiveWhen(isFutureOrAbsent(info.cache_expires_at), "context.cache_stale"),
  ]);
}

function validateIssuer(
  info: Record<string, unknown>,
  config: RemoteIntrospectionConfig
): RemoteIntrospectionInfo | null {
  const expectedIssuer = config.expectedIssuer();
  return inactiveWhen(Boolean(expectedIssuer && info.iss === expectedIssuer), "context.issuer_mismatch");
}

function validateAudience(
  info: Record<string, unknown>,
  config: RemoteIntrospectionConfig
): RemoteIntrospectionInfo | null {
  const expectedAudience = config.expectedAudience();
  return inactiveWhen(
    Boolean(expectedAudience && audienceMatches(info.aud, expectedAudience)),
    "context.audience_mismatch"
  );
}

type AuthorizationContextValidator = (info: Record<string, unknown>) => RemoteIntrospectionInfo | null;

const AUTHORIZATION_CONTEXT_VALIDATORS: Readonly<Record<string, AuthorizationContextValidator>> = {
  client: validateClientAuthorizationContext,
  mcp_package: validatePackageAuthorizationContext,
  owner: validateOwnerAuthorizationContext,
};

function validateAuthorizationContext(info: Record<string, unknown>): RemoteIntrospectionInfo | null {
  return (AUTHORIZATION_CONTEXT_VALIDATORS[String(info.pdpp_token_kind)] ?? (() => inactive("context.kind_mismatch")))(
    info
  );
}

function inactiveResponse(info: Record<string, unknown>): RemoteIntrospectionInfo {
  return {
    ...info,
    active: false,
    inactive_reason: isNonEmptyString(info.inactive_reason) ? info.inactive_reason : "context.active_false",
  };
}

function validateActiveResponse(
  info: Record<string, unknown>,
  config: RemoteIntrospectionConfig
): RemoteIntrospectionInfo {
  if (info.active !== true) {
    return inactiveResponse(info);
  }
  return (
    firstInactive([
      validateIssuer(info, config),
      validateAudience(info, config),
      validateResponseLifetime(info, (config.now?.() ?? Date.now()) / 1000),
      validateAuthorizationContext(info),
    ]) ?? { ...info, active: true }
  );
}

function requireSuccessfulResponse(response: Response): Response {
  if (!response.ok) {
    throw new Error("Introspection request failed");
  }
  return response;
}

function requireIntrospectionPayload(payload: unknown): Record<string, unknown> {
  if (!(payload && typeof payload === "object" && !Array.isArray(payload))) {
    throw new Error("Introspection response must be an object");
  }
  return payload as Record<string, unknown>;
}

function requestIntrospectionPayload({
  authorization,
  endpoint,
  fetchImpl,
  token,
}: {
  authorization: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  token: string;
}): Promise<Record<string, unknown> | null> {
  return Promise.resolve()
    .then(() =>
      fetchImpl(endpoint, {
        body: new URLSearchParams({ token }).toString(),
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      })
    )
    .then(requireSuccessfulResponse)
    .then((response) => response.json())
    .then(requireIntrospectionPayload)
    .catch(() => null);
}

export function createRemoteIntrospector(
  config: RemoteIntrospectionConfig
): (token: string) => Promise<RemoteIntrospectionInfo> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const authorization = basicIntrospectionAuthorization(config);
  return async (token: string) => {
    const payload = await requestIntrospectionPayload({ authorization, endpoint: config.endpoint, fetchImpl, token });
    return payload ? validateActiveResponse(payload, config) : inactive("context.authentication_failed");
  };
}
