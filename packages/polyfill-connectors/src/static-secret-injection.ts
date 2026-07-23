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
export type StaticSecretCredentialKind =
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
  if (descriptor.acceptedCredentialVariants) {
    for (const variant of descriptor.acceptedCredentialVariants) {
      freezeMapping(variant);
    }
    Object.freeze(descriptor.acceptedCredentialVariants);
  }
  return Object.freeze(descriptor);
}

/**
 * Registry of static-secret connectors and the env vars each reads its secret
 * from. The env var names are the ground truth in each connector's code:
 *   - gmail/index.ts `resolveGmailPasswordFromEnv`: GOOGLE_APP_PASSWORD_PDPP / GMAIL_APP_PASSWORD
 *   - github/index.ts auth.required: GITHUB_PERSONAL_ACCESS_TOKEN / GITHUB_TOKEN
 *   - ynab/index.ts auth.required: YNAB_PERSONAL_ACCESS_TOKEN / YNAB_PAT
 *   - slack/index.ts auth.required: SLACK_WORKSPACE / SLACK_TOKEN / SLACK_COOKIE
 *   - oura/index.ts auth.required: OURA_PERSONAL_ACCESS_TOKEN
 *   - notion/index.ts auth.required: NOTION_API_TOKEN
 *   - reddit/index.ts auth.required: REDDIT_USERNAME / REDDIT_PASSWORD
 *   - chatgpt/auto-login/chatgpt.ts: CHATGPT_USERNAME / CHATGPT_PASSWORD
 *   - amazon/auto-login/amazon.ts: AMAZON_USERNAME / AMAZON_PASSWORD
 *   - heb/auto-login/heb.ts: HEB_USERNAME / HEB_PASSWORD
 *   - chase/auto-login/chase.ts: CHASE_USERNAME / CHASE_PASSWORD
 *   - usaa/auto-login/usaa.ts: USAA_USERNAME / USAA_PASSWORD
 *
 * A connector absent from this registry is NOT a static-secret connector for
 * the purposes of injection; callers must not invent env var names for it.
 */
export const STATIC_SECRET_CONNECTOR_REGISTRY: Readonly<Record<string, StaticSecretConnectorDescriptor>> =
  Object.freeze({
    amazon: freezeStaticSecretDescriptor({
      credentialKind: "username_password",
      secretFieldEnvVars: {
        password: ["AMAZON_PASSWORD"],
        username: ["AMAZON_USERNAME"],
      },
    }),
    heb: freezeStaticSecretDescriptor({
      credentialKind: "username_password",
      secretFieldEnvVars: {
        password: ["HEB_PASSWORD"],
        username: ["HEB_USERNAME"],
      },
    }),
    chatgpt: freezeStaticSecretDescriptor({
      credentialKind: "username_password",
      secretFieldEnvVars: {
        password: ["CHATGPT_PASSWORD"],
        username: ["CHATGPT_USERNAME"],
      },
    }),
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
    ynab: freezeStaticSecretDescriptor({
      credentialKind: "personal_access_token",
      secretEnvVars: ["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"],
    }),
    slack: freezeStaticSecretDescriptor({
      credentialKind: "secret_bundle",
      secretFieldEnvVars: {
        slack_workspace: ["SLACK_WORKSPACE"],
        slack_token: ["SLACK_TOKEN"],
        slack_cookie: ["SLACK_COOKIE"],
      },
    }),
    oura: freezeStaticSecretDescriptor({
      credentialKind: "personal_access_token",
      secretEnvVars: ["OURA_PERSONAL_ACCESS_TOKEN"],
    }),
    notion: freezeStaticSecretDescriptor({
      credentialKind: "personal_access_token",
      secretEnvVars: ["NOTION_API_TOKEN"],
    }),
    reddit: freezeStaticSecretDescriptor({
      credentialKind: "username_password",
      acceptedCredentialVariants: [
        {
          credentialKind: "secret_bundle",
          secretFieldEnvVars: {
            reddit_password: ["REDDIT_PASSWORD"],
            reddit_username: ["REDDIT_USERNAME"],
          },
        },
      ],
      secretFieldEnvVars: {
        password: ["REDDIT_PASSWORD"],
        username: ["REDDIT_USERNAME"],
      },
    }),
    chase: freezeStaticSecretDescriptor({
      credentialKind: "username_password",
      secretFieldEnvVars: {
        password: ["CHASE_PASSWORD"],
        username: ["CHASE_USERNAME"],
      },
    }),
    usaa: freezeStaticSecretDescriptor({
      credentialKind: "username_password",
      secretFieldEnvVars: {
        password: ["USAA_PASSWORD"],
        username: ["USAA_USERNAME"],
      },
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

function secretBundleFields(connectorId: string, secret: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    // biome-ignore lint/style/useErrorCause: custom error factory/constructor owns its domain-specific cause contract
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

function injectSecretBundle(
  fragment: Record<string, string>,
  connectorId: string,
  secret: string,
  secretFieldEnvVars: StaticSecretConnectorDescriptor["secretFieldEnvVars"]
) {
  if (!secretFieldEnvVars) {
    return;
  }
  const bundle = secretBundleFields(connectorId, secret);
  for (const [fieldName, envVars] of Object.entries(secretFieldEnvVars)) {
    const value = bundle[fieldName];
    if (!value) {
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
  const mapping = injectionMappingForRecoveredSecret(connectorId, descriptor, recovered);
  const fragment: Record<string, string> = {};
  injectSingleSecret(fragment, mapping.secretEnvVars, recovered.secret);
  injectSecretBundle(fragment, connectorId, recovered.secret, mapping.secretFieldEnvVars);
  injectSetupFields(fragment, mapping.setupFieldEnvVars, sourceBinding);
  return fragment;
}
