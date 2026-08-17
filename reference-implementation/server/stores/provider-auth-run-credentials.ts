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
 *
 * This module carries zero connector/provider-specific knowledge. Every env
 * var name it writes, every bundle field it reads, and every legacy-field
 * fallback it tries comes from the manifest's `capabilities.auth` declaration
 * (`connection_config`, `env_bundle_kind`, `legacy_bundle_field_aliases`) —
 * never a hardcoded provider literal. A generic secret_bundle field name
 * (`refresh_token`, `access_token`, ...) is provider-neutral by construction;
 * a *legacy* field name (written by a since-retired provider-specific
 * exchanger) is connector-owned migration metadata, declared on the manifest,
 * not embedded in this file.
 */

export interface ConnectionConfigEntry {
  readonly bundleField: string;
  readonly envVar: string;
  /** Defaults to `true`. An entry declared `required: false` is populated
   * only when the bundle field resolves to a non-blank value — e.g. a
   * multi-field bundle whose field legitimately serializes to an empty
   * list on a valid authorization (nothing denied, nothing one-time). This
   * is manifest-declared, not an RI guess at which fields "matter". */
  readonly required?: boolean;
}

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

/**
 * True for any provider-auth-originated source binding, regardless of which
 * provider or exchanger produced it — this module never branches on a
 * `sourceBinding.provider` value.
 */
function sourceBindingIsProviderAuthAccount(sourceBinding: unknown): boolean {
  return isRecord(sourceBinding) && sourceBinding.kind === "provider_auth_account";
}

/**
 * Reads one generic bundle field, falling back to a manifest-declared legacy
 * field name only when the generic field is absent. `legacyAliases` is
 * connector-owned declarative migration metadata (manifest data), never a
 * literal this module hardcodes — a manifest with no aliases declared simply
 * never falls back, which is correct for any connector with no pre-existing
 * legacy-shaped bundles.
 */
function readBundleField(
  fields: Record<string, string>,
  genericField: string,
  legacyAliases: Readonly<Record<string, string>> | null | undefined
): string | undefined {
  if (fields[genericField]) {
    return fields[genericField];
  }
  const legacyName = legacyAliases?.[genericField];
  return legacyName ? fields[legacyName] : undefined;
}

function requireBundleField(
  connectorId: string,
  fields: Record<string, string>,
  genericField: string,
  legacyAliases: Readonly<Record<string, string>> | null | undefined
): string {
  const value = readBundleField(fields, genericField, legacyAliases);
  if (!value) {
    throw new ProviderAuthRunCredentialError(
      "provider_auth_secret_bundle_field_missing",
      `Connector '${connectorId}' provider-token bundle is missing required field '${genericField}'.`
    );
  }
  return value;
}

/**
 * Maps a captured generic secret_bundle to the exact per-run env vars a
 * connector already expects, per the manifest's `connection_config`
 * declaration (`{env_var, bundle_field, required?}` entries). Every declared
 * entry is populated from the same resolved bundle: a `required` (default)
 * entry throws if its field can't be resolved, an entry declared
 * `required: false` is populated only when present — e.g. a multi-field
 * bundle whose field legitimately serializes to nothing on a valid
 * authorization (nothing denied, nothing one-time). Whether a field is
 * required is manifest data, never an RI guess about which fields matter.
 */
function envFromBundle(
  connectorId: string,
  fields: Record<string, string>,
  connectionConfig: readonly ConnectionConfigEntry[],
  legacyAliases: Readonly<Record<string, string>> | null | undefined
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of connectionConfig) {
    if (entry.required === false) {
      const value = readBundleField(fields, entry.bundleField, legacyAliases);
      if (value) {
        env[entry.envVar] = value;
      }
      continue;
    }
    env[entry.envVar] = requireBundleField(connectorId, fields, entry.bundleField, legacyAliases);
  }
  return env;
}

export interface ProviderAuthCredentialStore {
  recoverSecret: (args: { connectorInstanceId: string; ownerSubjectId: string }) => Promise<{
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
  connectionConfig,
  legacyBundleFieldAliases,
}: {
  connectorId: string;
  connectorInstanceId: string;
  credentialStore: ProviderAuthCredentialStore | null | undefined;
  ownerSubjectId: string;
  sourceBinding?: unknown;
  /** From `manifest.capabilities.auth.connection_config`, normalized to
   * `{envVar, bundleField}` pairs by the caller. Absent/empty means this
   * connector has no provider-auth-sourced runtime env to inject. */
  connectionConfig?: readonly ConnectionConfigEntry[];
  /** From `manifest.capabilities.auth.legacy_bundle_field_aliases`. */
  legacyBundleFieldAliases?: Readonly<Record<string, string>> | null;
}): Promise<Record<string, string> | null> {
  if (!(connectionConfig?.length && sourceBindingIsProviderAuthAccount(sourceBinding))) {
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
  const fields = parseSecretBundle(connectorId, recovered.secret);
  return envFromBundle(connectorId, fields, connectionConfig, legacyBundleFieldAliases);
}
