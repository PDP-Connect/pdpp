// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connection-scoped provider-authorization token injection.
 *
 * Static-secret capture and provider OAuth both use the same encrypted
 * per-connection credential table, but they are different setup semantics. This
 * adapter deliberately keeps provider-token mapping out of the static-secret
 * registry while still returning the same per-run env fragment consumed by the
 * runtime spawn seam.
 */

const GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY = "google-maps-data-portability";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ProviderAuthRunCredentialError extends Error {
  code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderAuthRunCredentialError";
    this.code = code;
  }
}

function parseSecretBundle(connectorId: string, secret: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch (cause) {
    const error = new ProviderAuthRunCredentialError(
      "provider_auth_secret_bundle_invalid",
      `Connector '${connectorId}' expects a sealed JSON provider-token bundle; recovered secret was not valid JSON.`
    );
    error.cause = cause;
    throw error;
  }
  if (!isRecord(parsed)) {
    throw new ProviderAuthRunCredentialError(
      "provider_auth_secret_bundle_invalid",
      `Connector '${connectorId}' expects a sealed JSON provider-token bundle object.`
    );
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim().length > 0) {
      fields[key] = value.trim();
    }
  }
  return fields;
}

function requireField(connectorId: string, fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (!value) {
    throw new ProviderAuthRunCredentialError(
      "provider_auth_secret_bundle_field_missing",
      `Connector '${connectorId}' provider-token bundle is missing required field '${key}'.`
    );
  }
  return value;
}

function sourceBindingUsesGoogleDataPortability(sourceBinding: unknown): boolean {
  return (
    isRecord(sourceBinding) &&
    sourceBinding.kind === "provider_auth_account" &&
    sourceBinding.provider === "google_data_portability"
  );
}

function googleDataPortabilityEnvFromBundle(fields: Record<string, string>): Record<string, string> {
  return {
    GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: requireField(
      GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
      fields,
      "google_dataportability_access_token"
    ),
    ...(fields.google_dataportability_refresh_token
      ? { GOOGLE_DATAPORTABILITY_REFRESH_TOKEN: fields.google_dataportability_refresh_token }
      : {}),
    ...(fields.google_dataportability_token_kind
      ? { GOOGLE_DATAPORTABILITY_TOKEN_KIND: fields.google_dataportability_token_kind }
      : {}),
    ...(fields.google_dataportability_expires_at
      ? { GOOGLE_DATAPORTABILITY_TOKEN_EXPIRES_AT: fields.google_dataportability_expires_at }
      : {}),
    ...(fields.google_dataportability_authorized_resource_groups
      ? {
          GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS: fields.google_dataportability_authorized_resource_groups,
        }
      : {}),
    ...(fields.google_dataportability_one_time_resource_groups
      ? { GOOGLE_DATAPORTABILITY_ONE_TIME_RESOURCE_GROUPS: fields.google_dataportability_one_time_resource_groups }
      : {}),
    ...(fields.google_dataportability_time_based_resource_groups
      ? { GOOGLE_DATAPORTABILITY_TIME_BASED_RESOURCE_GROUPS: fields.google_dataportability_time_based_resource_groups }
      : {}),
    ...(fields.google_dataportability_denied_resource_groups
      ? { GOOGLE_DATAPORTABILITY_DENIED_RESOURCE_GROUPS: fields.google_dataportability_denied_resource_groups }
      : {}),
  };
}

export interface ProviderAuthCredentialStore {
  recoverSecret: (args: { connectorInstanceId: string; ownerSubjectId?: string | undefined }) => Promise<{
    credentialKind: string;
    secret: string;
  }>;
}

export async function resolveProviderAuthRunEnv({
  connectorId,
  connectorInstanceId,
  ownerSubjectId,
  sourceBinding,
  credentialStore,
}: {
  connectorId: string;
  connectorInstanceId: string;
  credentialStore: ProviderAuthCredentialStore | null | undefined;
  ownerSubjectId?: string;
  sourceBinding?: unknown;
}): Promise<Record<string, string> | null> {
  if (connectorId !== GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY) {
    return null;
  }
  if (!sourceBindingUsesGoogleDataPortability(sourceBinding)) {
    return null;
  }
  if (!credentialStore) {
    throw new ProviderAuthRunCredentialError(
      "credential_store_required",
      "A connector-instance credential store is required to resolve provider-auth run env."
    );
  }
  const recovered = await credentialStore.recoverSecret({ connectorInstanceId, ownerSubjectId });
  if (recovered.credentialKind !== "secret_bundle") {
    throw new ProviderAuthRunCredentialError(
      "provider_auth_credential_kind_mismatch",
      `Connector '${connectorId}' expects credential kind 'secret_bundle', but recovered '${recovered.credentialKind}'.`
    );
  }
  return googleDataPortabilityEnvFromBundle(parseSecretBundle(connectorId, recovered.secret));
}
