// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// reference-implementation/scripts/generate-connector-registry.ts from the
// shipped connector manifests (packages/polyfill-connectors/manifests/,
// reference-implementation/manifests/) and
// @pdpp/polyfill-connectors's LOCAL_COLLECTOR_DEFINITIONS. Regenerate with
// `pnpm --filter pdpp-reference-implementation run generate:connector-registry`.
// scripts/check-generated-artifacts.ts fails CI if this file drifts from
// what the generator would produce for the manifests currently on disk —
// this is how the RI's setup/proof-gate classification stays manifest-derived
// instead of a hand-maintained connector-id allowlist. See
// docs/inbox/findings-deployment-env-vars.md (Cluster B).

/** Every first-party manifest's canonical connector_key. */
export const FIRST_PARTY_CONNECTOR_KEYS: readonly string[] = Object.freeze(["amazon", "anthropic", "apple_contacts", "apple-health", "apple-photos", "chase", "chatgpt", "claude-code", "codex", "doordash", "github", "gmail", "google-calendar", "google-contacts", "google-maps", "google-maps-data-portability", "google-messages", "google-takeout", "groupme", "heb", "ical", "imessage", "jellyfin", "linkedin", "loom", "meta", "netflix-export", "notion", "oura", "pocket", "reddit", "shopify", "slack", "spotify", "steam", "strava", "twitter-archive", "uber", "usaa", "venmo", "whatsapp", "wholefoods", "whoop", "ynab"]);

/** Native (storage_binding.connector_id) reference-fixture connector keys. */
export const NATIVE_CONNECTOR_KEYS: readonly string[] = Object.freeze(["northstar_hr_native"]);

/**
 * Legacy snake_case local-collector bundle id -> canonical manifest
 * connector_key, wherever the two differ. Derived by cross-referencing
 * LOCAL_COLLECTOR_DEFINITIONS (the bundle's own directory-name ids) against
 * each connector's manifest-declared connector_key.
 */
export const LEGACY_LOCAL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "apple_photos": "apple-photos",
  "claude_code": "claude-code",
  "codex": "codex",
  "google_messages": "google-messages",
  "google_takeout": "google-takeout",
  "imessage": "imessage",
});

/** Manifests declaring capabilities.proven.local_collector === true. */
export const LOCAL_COLLECTOR_PROVEN_KEYS: readonly string[] = Object.freeze(["claude-code", "codex", "google-takeout", "imessage", "apple-photos", "google-messages"]);

/** Manifests declaring a runtime_requirements.bindings.browser binding. */
export const BROWSER_BOUND_KEYS: readonly string[] = Object.freeze(["amazon", "anthropic", "chase", "chatgpt", "doordash", "heb", "linkedin", "loom", "meta", "reddit", "shopify", "uber", "usaa", "venmo", "wholefoods", "whoop"]);

/** Manifests declaring capabilities.proven.provider_auth_lifecycle === true. */
export const PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS: readonly string[] = Object.freeze(["google-calendar", "google-contacts", "google-maps-data-portability"]);

/** Manifests declaring capabilities.proven.static_secret_live.proven === true. */
export const STATIC_SECRET_LIVE_PROVEN_KEYS: readonly string[] = Object.freeze(["github", "gmail", "slack", "ynab"]);
