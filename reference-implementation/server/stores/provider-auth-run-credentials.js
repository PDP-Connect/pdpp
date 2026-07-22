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

const GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY = 'google-maps-data-portability';

export class ProviderAuthRunCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderAuthRunCredentialError';
    this.code = code;
  }
}

function parseSecretBundle(connectorId, secret) {
  let parsed;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new ProviderAuthRunCredentialError(
      'provider_auth_secret_bundle_invalid',
      `Connector '${connectorId}' expects a sealed JSON provider-token bundle; recovered secret was not valid JSON.`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderAuthRunCredentialError(
      'provider_auth_secret_bundle_invalid',
      `Connector '${connectorId}' expects a sealed JSON provider-token bundle object.`,
    );
  }
  const fields = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      fields[key] = value.trim();
    }
  }
  return fields;
}

function requireField(connectorId, fields, key) {
  const value = fields[key];
  if (!value) {
    throw new ProviderAuthRunCredentialError(
      'provider_auth_secret_bundle_field_missing',
      `Connector '${connectorId}' provider-token bundle is missing required field '${key}'.`,
    );
  }
  return value;
}

function sourceBindingUsesGoogleDataPortability(sourceBinding) {
  return (
    sourceBinding &&
    typeof sourceBinding === 'object' &&
    !Array.isArray(sourceBinding) &&
    sourceBinding.kind === 'provider_auth_account' &&
    sourceBinding.provider === 'google_data_portability'
  );
}

function googleDataPortabilityEnvFromBundle(fields) {
  return {
    GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: requireField(
      GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
      fields,
      'google_dataportability_access_token',
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
          GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS:
            fields.google_dataportability_authorized_resource_groups,
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

export async function resolveProviderAuthRunEnv({
  connectorId,
  connectorInstanceId,
  ownerSubjectId,
  sourceBinding,
  credentialStore,
}) {
  if (connectorId !== GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY) {
    return null;
  }
  if (!sourceBindingUsesGoogleDataPortability(sourceBinding)) {
    return null;
  }
  if (!credentialStore) {
    throw new ProviderAuthRunCredentialError(
      'credential_store_required',
      'A connector-instance credential store is required to resolve provider-auth run env.',
    );
  }
  const recovered = await credentialStore.recoverSecret({ connectorInstanceId, ownerSubjectId });
  if (recovered.credentialKind !== 'secret_bundle') {
    throw new ProviderAuthRunCredentialError(
      'provider_auth_credential_kind_mismatch',
      `Connector '${connectorId}' expects credential kind 'secret_bundle', but recovered '${recovered.credentialKind}'.`,
    );
  }
  return googleDataPortabilityEnvFromBundle(parseSecretBundle(connectorId, recovered.secret));
}
