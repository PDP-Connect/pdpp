// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-static-secret-registry.ts from every shipped connector
// manifest's setup.credential_capture block (manifests/*.json), normalized by
// the same normalizeStaticSecretCredentialCapture
// (../static-secret-credential-capture.ts) that connection-setup-plan.ts's
// staticSecretCredentialCaptureFromManifest calls for setup — one shared
// predicate, not two hand-maintained ones that can silently disagree.
// scripts/check-generated-artifacts.ts fails CI if this file drifts from what
// the generator would produce for the manifests currently on disk, instead of
// a second, hand-maintained connector-id registry that can silently omit an
// onboarded connector (see the venmo run-injection gap this replaced).
//
// Two connectors' STORED credentials predate their current manifest shape and
// are intentionally NOT represented here — see
// LEGACY_CREDENTIAL_KIND_MIGRATIONS in ../static-secret-injection.ts:
//   - reddit: a retired sealed OAuth bundle (credentialKind "secret_bundle")
//     from before the connector switched to username_password.
//   - jellyfin: a bare api_key string (credentialKind "api_key") from before
//     the connector switched to a username/password-or-api_key bundle.
// Regenerate with `node --experimental-strip-types
// scripts/generate-static-secret-registry.ts` from packages/polyfill-connectors.

export interface GeneratedStaticSecretDescriptor {
  /** `false` only when the manifest's credential_capture.required is explicitly false; omitted (defaults true) otherwise. */
  readonly captureRequired?: false;
  readonly credentialKind: string;
  readonly optionalSecretBundleFields?: readonly string[];
  readonly secretEnvVars?: readonly string[];
  readonly secretFieldEnvVars?: Readonly<Record<string, readonly string[]>>;
  readonly setupFieldEnvVars?: Readonly<Record<string, readonly string[]>>;
}

/** Every manifest-declared static-secret connector's injection mapping, keyed by connector_key. */
export const GENERATED_STATIC_SECRET_REGISTRY: Readonly<Record<string, GeneratedStaticSecretDescriptor>> =
  Object.freeze({
    "amazon": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["AMAZON_PASSWORD"],
        "username": ["AMAZON_USERNAME"],
      },
    },
    "apple_contacts": {
      credentialKind: "app_password",
      secretEnvVars: ["APPLE_APP_SPECIFIC_PASSWORD"],
      setupFieldEnvVars: {
        "account_email": ["APPLE_ID", "APPLE_ID_EMAIL"],
      },
    },
    "chase": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["CHASE_PASSWORD"],
        "username": ["CHASE_USERNAME"],
      },
    },
    "chatgpt": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["CHATGPT_PASSWORD"],
        "username": ["CHATGPT_USERNAME"],
      },
    },
    "github": {
      credentialKind: "personal_access_token",
      secretEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"],
    },
    "gmail": {
      credentialKind: "app_password",
      secretEnvVars: ["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"],
      setupFieldEnvVars: {
        "account_email": ["GMAIL_ADDRESS", "GMAIL_USER"],
      },
    },
    "groupme": {
      credentialKind: "access_token",
      secretEnvVars: ["GROUPME_ACCESS_TOKEN"],
    },
    "heb": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["HEB_PASSWORD"],
        "username": ["HEB_USERNAME"],
      },
    },
    "jellyfin": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["JELLYFIN_PASSWORD"],
        "secret": ["JELLYFIN_API_KEY"],
        "username": ["JELLYFIN_USERNAME"],
      },
      optionalSecretBundleFields: ["username", "password", "secret"],
      setupFieldEnvVars: {
        "base_url": ["JELLYFIN_BASE_URL"],
        "jellyfin_user_id": ["JELLYFIN_USER_ID"],
      },
    },
    "notion": {
      credentialKind: "personal_access_token",
      secretEnvVars: ["NOTION_API_TOKEN"],
    },
    "oura": {
      credentialKind: "personal_access_token",
      secretEnvVars: ["OURA_PERSONAL_ACCESS_TOKEN"],
    },
    "reddit": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["REDDIT_PASSWORD"],
        "username": ["REDDIT_USERNAME"],
      },
    },
    "slack": {
      credentialKind: "secret_bundle",
      secretFieldEnvVars: {
        "slack_cookie": ["SLACK_COOKIE"],
        "slack_token": ["SLACK_TOKEN"],
        "slack_workspace": ["SLACK_WORKSPACE"],
      },
    },
    "spotify": {
      credentialKind: "access_token",
      secretEnvVars: ["SPOTIFY_ACCESS_TOKEN"],
    },
    "steam": {
      credentialKind: "api_key",
      secretEnvVars: ["STEAM_API_KEY"],
      setupFieldEnvVars: {
        "steamid": ["STEAM_USER_ID"],
      },
    },
    "usaa": {
      credentialKind: "username_password",
      secretFieldEnvVars: {
        "password": ["USAA_PASSWORD"],
        "username": ["USAA_USERNAME"],
      },
    },
    "venmo": {
      credentialKind: "username_password",
      captureRequired: false,
      secretFieldEnvVars: {
        "password": ["VENMO_PASSWORD"],
        "username": ["VENMO_USERNAME"],
      },
    },
    "ynab": {
      credentialKind: "personal_access_token",
      secretEnvVars: ["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"],
    },
  });
