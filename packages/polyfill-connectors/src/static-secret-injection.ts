// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connection-scoped static-secret injection.
 *
 * Static-secret connectors read their connector-declared provider secret from
 * named environment variables. Historically that secret could only live in the
 * process-global environment, which structurally limits the reference to ONE
 * account per connector type — two Gmail mailboxes would collide on one
 * `GOOGLE_APP_PASSWORD_PDPP`.
 *
 * This module is the construction that escapes that limit. Given a connector id
 * and a credential recovered from the per-connection encrypted store, it returns
 * an env fragment carrying ONLY that one connection's secret. The orchestrator
 * sets this fragment on the per-run child environment — so each run receives
 * exactly its own connection's secret, scoped to that one subprocess, never the
 * shared process environment. Two connections for the same connector therefore
 * run as two addressable `connection_id`s with two distinct secrets.
 *
 * This file is pure string mapping with no provider, network, or native
 * dependency, so it is safe inside the publishable runner slice. See
 * `add-static-secret-owner-connect-primitive` design Decision 5.
 *
 * The injection mapping (which env var(s) each connector's secret/setup
 * fields land on) is manifest-derived, generated data — see
 * `./generated/static-secret-registry.generated.ts` and
 * `scripts/generate-static-secret-registry.ts`. That generator and setup's
 * `connection-setup-plan.ts` both call the same
 * `normalizeStaticSecretCredentialCapture`
 * (`./static-secret-credential-capture.ts`) to decide which fields are
 * secret — one shared predicate, not two independently-hand-maintained ones
 * that could (and did, for venmo) drift. Only `LEGACY_CREDENTIAL_KIND_MIGRATIONS`
 * below remains hand-maintained: it captures STORED credential shapes that
 * predate a connector's current manifest and so cannot be regenerated from
 * it.
 */

import {
  GENERATED_STATIC_SECRET_REGISTRY,
  type GeneratedStaticSecretDescriptor,
} from "./generated/static-secret-registry.generated.ts";

/** Credential kinds the per-connection store can hold. Mirrors the store. */
export type StaticSecretCredentialKind =
  | "access_token"
  | "api_key"
  | "app_password"
  | "personal_access_token"
  | "secret_bundle"
  | "username_password";

export interface RecoveredStaticSecret {
  /** The kind of secret, used to validate it matches the connector's expectation. */
  readonly credentialKind: StaticSecretCredentialKind;
  /** The recovered plaintext provider secret. Ephemeral — inject, never persist. */
  readonly secret: string;
}

type StaticSecretSetupFields = Readonly<Record<string, string>>;

interface StaticSecretInjectionMapping {
  /** Credential kind this connector authenticates with. */
  readonly credentialKind: StaticSecretCredentialKind;
  /**
   * Names from `secretFieldEnvVars` that may be absent from the recovered
   * bundle without failing injection. Every other `secretFieldEnvVars` name
   * remains required. Used when one connector accepts more than one
   * credential shape sealed into the SAME bundle (e.g. jellyfin's
   * username+password OR a bare api_key) rather than two mutually exclusive
   * `acceptedCredentialVariants`, because the manifest's `credential_kind` is
   * one fixed string and cannot switch between variants at capture time.
   */
  readonly optionalSecretBundleFields?: ReadonlySet<string>;
  /**
   * Env var name(s) the connector reads the secret from. The connector resolves
   * the first non-empty; the injection sets all of them to the same recovered
   * value so the connector finds it regardless of which alias it prefers.
   */
  readonly secretEnvVars?: readonly string[];
  /**
   * Secret fields inside an opaque sealed JSON credential bundle. Used when a
   * connector needs more than one bearer-equivalent value for one connection
   * (for example a token plus cookie, or OAuth password-flow credentials).
   */
  readonly secretFieldEnvVars?: Readonly<Record<string, readonly string[]>>;
  /** Non-secret setup fields to inject for connector runtime configuration. */
  readonly setupFieldEnvVars?: Readonly<Record<string, readonly string[]>>;
}

interface StaticSecretConnectorDescriptor extends StaticSecretInjectionMapping {
  /**
   * Backward-compatible credential shapes that can still authenticate the
   * connector. The primary `credentialKind` is the shape new captures should
   * use; variants keep older stored rows runnable during migrations.
   */
  readonly acceptedCredentialVariants?: readonly StaticSecretInjectionMapping[];
  /**
   * `false` only when the manifest's block-level `credential_capture.required`
   * is explicitly `false` (e.g. Venmo — the connector always falls back to a
   * browser-driven sign-in that works with zero saved credentials); `true`
   * for every connector that omits the fact. See `injectSecretBundle`'s use
   * of this: it is what lets an entirely EMPTY recovered bundle inject
   * nothing (valid "sign in by hand" choice) instead of throwing
   * `recovered_secret_bundle_field_missing` on the first field a required
   * capture (e.g. Jellyfin) would still correctly fail closed on.
   */
  readonly captureRequired: boolean;
}

function freezeStaticSecretDescriptor(descriptor: StaticSecretConnectorDescriptor): StaticSecretConnectorDescriptor {
  const freezeMapping = (mapping: StaticSecretInjectionMapping) => {
    if (mapping.secretEnvVars) {
      Object.freeze(mapping.secretEnvVars);
    }
    if (mapping.secretFieldEnvVars) {
      for (const value of Object.values(mapping.secretFieldEnvVars)) {
        Object.freeze(value);
      }
      Object.freeze(mapping.secretFieldEnvVars);
    }
    if (mapping.setupFieldEnvVars) {
      for (const value of Object.values(mapping.setupFieldEnvVars)) {
        Object.freeze(value);
      }
      Object.freeze(mapping.setupFieldEnvVars);
    }
    return Object.freeze(mapping);
  };
  if (descriptor.secretEnvVars) {
    Object.freeze(descriptor.secretEnvVars);
  }
  if (descriptor.secretFieldEnvVars) {
    for (const value of Object.values(descriptor.secretFieldEnvVars)) {
      Object.freeze(value);
    }
    Object.freeze(descriptor.secretFieldEnvVars);
  }
  if (descriptor.setupFieldEnvVars) {
    for (const value of Object.values(descriptor.setupFieldEnvVars)) {
      Object.freeze(value);
    }
    Object.freeze(descriptor.setupFieldEnvVars);
  }
  if (descriptor.optionalSecretBundleFields) {
    Object.freeze(descriptor.optionalSecretBundleFields);
  }
  if (descriptor.acceptedCredentialVariants) {
    for (const variant of descriptor.acceptedCredentialVariants) {
      freezeMapping(variant);
    }
    Object.freeze(descriptor.acceptedCredentialVariants);
  }
  return Object.freeze(descriptor);
}

function mappingFromGenerated(generated: GeneratedStaticSecretDescriptor): StaticSecretInjectionMapping {
  return {
    credentialKind: generated.credentialKind as StaticSecretCredentialKind,
    ...(generated.optionalSecretBundleFields
      ? { optionalSecretBundleFields: new Set(generated.optionalSecretBundleFields) }
      : {}),
    ...(generated.secretEnvVars ? { secretEnvVars: generated.secretEnvVars } : {}),
    ...(generated.secretFieldEnvVars ? { secretFieldEnvVars: generated.secretFieldEnvVars } : {}),
    ...(generated.setupFieldEnvVars ? { setupFieldEnvVars: generated.setupFieldEnvVars } : {}),
  };
}

/**
 * Stored credential shapes that predate a connector's CURRENT manifest and so
 * cannot be regenerated from it — the one place this module still hardcodes
 * connector-specific knowledge, deliberately kept minimal and separate from
 * the generated, manifest-derived baseline above.
 *
 * Each entry is keyed by connector, but the transformation it describes is
 * scoped by CREDENTIAL KIND (a stored `credentialKind` distinct from the
 * connector's current manifest kind), not by connector identity: a
 * newly-onboarded connector never needs an entry here unless it also ships a
 * genuine legacy-capture migration. Adding a connector to a manifest never
 * requires touching this table — only retiring an old capture shape does.
 *
 *   - reddit: before the connector switched to username_password, a sealed
 *     OAuth bundle (credentialKind "secret_bundle") was captured with
 *     provider-specific field names.
 *   - jellyfin: before the connector switched to a username/password-or-
 *     api_key bundle, a bare api_key string (credentialKind "api_key") was
 *     captured directly, with no bundle at all.
 */
const LEGACY_CREDENTIAL_KIND_MIGRATIONS: Readonly<Record<string, readonly StaticSecretInjectionMapping[]>> =
  Object.freeze({
    jellyfin: [
      {
        credentialKind: "api_key",
        secretEnvVars: ["JELLYFIN_API_KEY"],
        setupFieldEnvVars: {
          base_url: ["JELLYFIN_BASE_URL"],
          jellyfin_user_id: ["JELLYFIN_USER_ID"],
        },
      },
    ],
    reddit: [
      {
        credentialKind: "secret_bundle",
        secretFieldEnvVars: {
          reddit_password: ["REDDIT_PASSWORD"],
          reddit_username: ["REDDIT_USERNAME"],
        },
      },
    ],
  });

/**
 * Registry of static-secret connectors and the env vars each reads its secret
 * from, generated from every shipped manifest's `setup.credential_capture`
 * (see `./generated/static-secret-registry.generated.ts`) plus the minimal,
 * explicit `LEGACY_CREDENTIAL_KIND_MIGRATIONS` table above for stored
 * credential shapes a current manifest cannot express.
 *
 * A connector absent from this registry is NOT a static-secret connector for
 * the purposes of injection; callers must not invent env var names for it.
 */
export const STATIC_SECRET_CONNECTOR_REGISTRY: Readonly<Record<string, StaticSecretConnectorDescriptor>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(GENERATED_STATIC_SECRET_REGISTRY).map(([connectorId, generated]) => {
        const acceptedCredentialVariants = LEGACY_CREDENTIAL_KIND_MIGRATIONS[connectorId];
        return [
          connectorId,
          freezeStaticSecretDescriptor({
            ...mappingFromGenerated(generated),
            captureRequired: generated.captureRequired !== false,
            ...(acceptedCredentialVariants ? { acceptedCredentialVariants } : {}),
          }),
        ];
      })
    )
  );

export class StaticSecretInjectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StaticSecretInjectionError";
    this.code = code;
  }
}

/** True when the connector authenticates with an injectable static secret. */
export function isStaticSecretConnector(connectorId: string): boolean {
  return Object.hasOwn(STATIC_SECRET_CONNECTOR_REGISTRY, connectorId);
}

/**
 * True when THIS connector's manifest declares `credential_capture.required:
 * false` — the same block-level, provider-neutral fact `captureRequired`
 * already carries for injection (see `StaticSecretConnectorDescriptor`'s
 * doc). Exposed as its own predicate so a run-orchestration seam that has no
 * business reading manifests directly (e.g. `resolveStaticSecretRunEnv`) can
 * still ask "does a missing credential here mean the owner chose manual
 * sign-in, or is it a genuine fail-closed gap" without re-deriving the fact
 * or introducing a second, connector-name-keyed source of truth. Returns
 * `false` for a connector absent from the registry (not a static-secret
 * connector at all) or with no explicit opt-out — the same
 * backward-compatible default every other layer uses.
 */
export function isStaticSecretCaptureOptional(connectorId: string): boolean {
  return STATIC_SECRET_CONNECTOR_REGISTRY[connectorId]?.captureRequired === false;
}

function setupFieldsFromSourceBinding(sourceBinding: unknown): StaticSecretSetupFields {
  if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
    return {};
  }
  const raw = (sourceBinding as { setup_fields?: unknown }).setup_fields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim().length > 0) {
      fields[key] = value.trim();
    }
  }
  return fields;
}

function secretBundleFields(connectorId: string, secret: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    // biome-ignore lint/style/useErrorCause: intentional — JSON.parse's error can echo a snippet of the invalid input, which here is the raw secret
    throw new StaticSecretInjectionError(
      "recovered_secret_bundle_invalid",
      `Connector '${connectorId}' expects a sealed JSON credential bundle; recovered secret was not valid JSON.`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StaticSecretInjectionError(
      "recovered_secret_bundle_invalid",
      `Connector '${connectorId}' expects a sealed JSON credential bundle object.`
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

function injectionMappingForRecoveredSecret(
  connectorId: string,
  descriptor: StaticSecretConnectorDescriptor,
  recovered: RecoveredStaticSecret
): StaticSecretInjectionMapping {
  if (!recovered || typeof recovered.secret !== "string" || recovered.secret.length === 0) {
    throw new StaticSecretInjectionError(
      "recovered_secret_invalid",
      `Cannot inject an empty credential for connector '${connectorId}'.`
    );
  }
  if (recovered.credentialKind === descriptor.credentialKind) {
    return descriptor;
  }
  const variant = descriptor.acceptedCredentialVariants?.find(
    (candidate) => candidate.credentialKind === recovered.credentialKind
  );
  if (variant) {
    return variant;
  }
  const expectedKinds = [
    descriptor.credentialKind,
    ...(descriptor.acceptedCredentialVariants ?? []).map((v) => v.credentialKind),
  ];
  if (!expectedKinds.includes(recovered.credentialKind)) {
    throw new StaticSecretInjectionError(
      "credential_kind_mismatch",
      `Connector '${connectorId}' expects credential kind '${expectedKinds.join("' or '")}', ` +
        `but the recovered credential is '${recovered.credentialKind}'.`
    );
  }
  return descriptor;
}

function injectSingleSecret(fragment: Record<string, string>, envVars: readonly string[] | undefined, secret: string) {
  for (const envVar of envVars ?? []) {
    fragment[envVar] = secret;
  }
}

/**
 * `captureRequired: false` (Venmo) means an entirely EMPTY bundle is the
 * owner's valid "sign in by hand every time" choice, not a bug — inject
 * nothing and let the connector's own `process.env.X && process.env.Y`
 * check (e.g. `ensureVenmoSession`) fall back to its manual path. A bundle
 * that has SOME but not all fields present is still fail-closed exactly like
 * a required capture: BOTH-OR-NONE was already enforced at capture time
 * (console/RI), so reaching injection with a genuinely partial bundle means
 * something upstream let a broken row through, and injecting half a
 * credential would risk a login attempt with a corrupt/incomplete
 * credential rather than a clean fallback to manual sign-in.
 */
function injectSecretBundle(
  fragment: Record<string, string>,
  connectorId: string,
  secret: string,
  secretFieldEnvVars: StaticSecretConnectorDescriptor["secretFieldEnvVars"],
  optionalSecretBundleFields: StaticSecretInjectionMapping["optionalSecretBundleFields"],
  captureRequired: boolean
) {
  if (!secretFieldEnvVars) {
    return;
  }
  const bundle = secretBundleFields(connectorId, secret);
  if (!captureRequired && Object.keys(bundle).length === 0) {
    return;
  }
  for (const [fieldName, envVars] of Object.entries(secretFieldEnvVars)) {
    const value = bundle[fieldName];
    if (!value) {
      if (optionalSecretBundleFields?.has(fieldName)) {
        continue;
      }
      throw new StaticSecretInjectionError(
        "recovered_secret_bundle_field_missing",
        `Connector '${connectorId}' credential bundle is missing required field '${fieldName}'.`
      );
    }
    for (const envVar of envVars) {
      fragment[envVar] = value;
    }
  }
}

function injectSetupFields(
  fragment: Record<string, string>,
  setupFieldEnvVars: StaticSecretConnectorDescriptor["setupFieldEnvVars"],
  sourceBinding: unknown
) {
  const setupFields = setupFieldsFromSourceBinding(sourceBinding);
  for (const [fieldName, envVars] of Object.entries(setupFieldEnvVars ?? {})) {
    const value = setupFields[fieldName];
    if (!value) {
      continue;
    }
    for (const envVar of envVars) {
      fragment[envVar] = value;
    }
  }
}

/**
 * Build the connection-scoped env fragment for one connector run.
 *
 * The returned object carries ONLY the secret env var(s) for this one
 * connection. It is intended for the per-run child environment:
 *
 *   const env = { ...declaredConnectorEnv, ...buildConnectionScopedSecretEnv(id, cred) };
 *
 * Never mutate `process.env` with the result. The fragment's lifetime is the one
 * run; runtime-owned platform and protocol controls retain precedence, and
 * nothing here logs or returns the secret outside the fragment.
 *
 * Throws when the connector is not a known static-secret connector, or when the
 * recovered credential's kind does not match the connector's expectation (a
 * guard against injecting one connector's credential kind into another
 * connector's runtime.
 */
export function buildConnectionScopedSecretEnv(
  connectorId: string,
  recovered: RecoveredStaticSecret,
  sourceBinding?: unknown
): Record<string, string> {
  const descriptor = STATIC_SECRET_CONNECTOR_REGISTRY[connectorId];
  if (!descriptor) {
    throw new StaticSecretInjectionError(
      "not_a_static_secret_connector",
      `Connector '${connectorId}' is not a known static-secret connector; refusing to invent secret env vars for it.`
    );
  }
  const mapping = injectionMappingForRecoveredSecret(connectorId, descriptor, recovered);
  const fragment: Record<string, string> = {};
  injectSingleSecret(fragment, mapping.secretEnvVars, recovered.secret);
  injectSecretBundle(
    fragment,
    connectorId,
    recovered.secret,
    mapping.secretFieldEnvVars,
    mapping.optionalSecretBundleFields,
    descriptor.captureRequired
  );
  injectSetupFields(fragment, mapping.setupFieldEnvVars, sourceBinding);
  return fragment;
}
