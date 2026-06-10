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
 * sets this fragment on the per-run `connector.env`, which the collector runner
 * merges LAST over `process.env` when it spawns the child — so each run receives
 * exactly its own connection's secret, scoped to that one subprocess, never the
 * shared process environment. Two connections for the same connector therefore
 * run as two addressable `connection_id`s with two distinct secrets.
 *
 * This file is pure string mapping with no provider, network, or native
 * dependency, so it is safe inside the publishable runner slice. See
 * `add-static-secret-owner-connect-primitive` design Decision 5.
 */

/** Credential kinds the per-connection store can hold. Mirrors the store. */
export type StaticSecretCredentialKind = "app_password" | "personal_access_token";

export interface RecoveredStaticSecret {
  /** The kind of secret, used to validate it matches the connector's expectation. */
  readonly credentialKind: StaticSecretCredentialKind;
  /** The recovered plaintext provider secret. Ephemeral — inject, never persist. */
  readonly secret: string;
}

type StaticSecretSetupFields = Readonly<Record<string, string>>;

interface StaticSecretConnectorDescriptor {
  /** Credential kind this connector authenticates with. */
  readonly credentialKind: StaticSecretCredentialKind;
  /**
   * Env var name(s) the connector reads the secret from. The connector resolves
   * the first non-empty; the injection sets all of them to the same recovered
   * value so the connector finds it regardless of which alias it prefers.
   */
  readonly secretEnvVars: readonly string[];
  /** Non-secret setup fields to inject for connector runtime configuration. */
  readonly setupFieldEnvVars?: Readonly<Record<string, readonly string[]>>;
}

function freezeStaticSecretDescriptor(descriptor: StaticSecretConnectorDescriptor): StaticSecretConnectorDescriptor {
  Object.freeze(descriptor.secretEnvVars);
  if (descriptor.setupFieldEnvVars) {
    for (const value of Object.values(descriptor.setupFieldEnvVars)) {
      Object.freeze(value);
    }
    Object.freeze(descriptor.setupFieldEnvVars);
  }
  return Object.freeze(descriptor);
}

/**
 * Registry of static-secret connectors and the env vars each reads its secret
 * from. The env var names are the ground truth in each connector's code:
 *   - gmail/index.ts `resolveGmailPasswordFromEnv`: GOOGLE_APP_PASSWORD_PDPP / GMAIL_APP_PASSWORD
 *   - github/index.ts auth.required: GITHUB_PERSONAL_ACCESS_TOKEN / GITHUB_TOKEN
 *
 * A connector absent from this registry is NOT a static-secret connector for
 * the purposes of injection; callers must not invent env var names for it.
 */
export const STATIC_SECRET_CONNECTOR_REGISTRY: Readonly<Record<string, StaticSecretConnectorDescriptor>> =
  Object.freeze({
    gmail: freezeStaticSecretDescriptor({
      credentialKind: "app_password",
      secretEnvVars: ["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"],
      setupFieldEnvVars: {
        account_email: ["GMAIL_ADDRESS", "GMAIL_USER"],
      },
    }),
    github: freezeStaticSecretDescriptor({
      credentialKind: "personal_access_token",
      secretEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"],
    }),
  });

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

/**
 * Build the connection-scoped env fragment for one connector run.
 *
 * The returned object carries ONLY the secret env var(s) for this one
 * connection. It is intended to be spread into the per-run `connector.env`:
 *
 *   const env = { ...connector.env, ...buildConnectionScopedSecretEnv(id, cred) };
 *
 * Never mutate `process.env` with the result. The fragment's lifetime is the one
 * run; nothing here logs or returns the secret outside the fragment.
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
  if (!recovered || typeof recovered.secret !== "string" || recovered.secret.length === 0) {
    throw new StaticSecretInjectionError(
      "recovered_secret_invalid",
      `Cannot inject an empty credential for connector '${connectorId}'.`
    );
  }
  if (recovered.credentialKind !== descriptor.credentialKind) {
    throw new StaticSecretInjectionError(
      "credential_kind_mismatch",
      `Connector '${connectorId}' expects credential kind '${descriptor.credentialKind}', ` +
        `but the recovered credential is '${recovered.credentialKind}'.`
    );
  }
  const fragment: Record<string, string> = {};
  for (const envVar of descriptor.secretEnvVars) {
    fragment[envVar] = recovered.secret;
  }
  const setupFields = setupFieldsFromSourceBinding(sourceBinding);
  for (const [fieldName, envVars] of Object.entries(descriptor.setupFieldEnvVars ?? {})) {
    const value = setupFields[fieldName];
    if (!value) {
      continue;
    }
    for (const envVar of envVars) {
      fragment[envVar] = value;
    }
  }
  return fragment;
}
