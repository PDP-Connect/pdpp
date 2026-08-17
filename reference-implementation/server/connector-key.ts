// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical connector-key helpers — migration groundwork.
 *
 * The reference implementation currently uses URL-shaped first-party
 * connector ids (`https://registry.pdpp.dev/connectors/<slug>`) as the
 * operational connector type key, plus a small set of legacy local-collector
 * aliases (`claude_code`, `codex`) that map to those URLs. That overload is
 * the root cause of the `Unknown connector: https` parser bug (URL `:`
 * collided with the picker's delimiter encoding) and of the broader identity
 * confusion the `canonicalize-connector-keys` OpenSpec change addresses.
 *
 * This module is the additive first slice. It introduces:
 *
 *   - a frozen allowlist of every known first-party `connector_id` value
 *     (URL-shaped + native + legacy alias) mapped to its canonical short
 *     `connector_key` (`gmail`, `slack`, `claude-code`, `codex`, ...);
 *   - pure functions that turn any accepted shape into a canonical key, or
 *     report `null` for an unmapped third-party / custom value.
 *
 * The helpers do not mutate storage, do not rewrite any in-flight request,
 * and do not change any current call site. They exist so subsequent slices
 * (manifest registration, hosted-MCP picker payload, dashboard labels,
 * migration script) can rely on one source of truth for "what is the
 * canonical key for this connector identifier?" without re-implementing the
 * mapping inline.
 *
 * The frozen allowlist is intentional: per the design note
 * (`openspec/changes/canonicalize-connector-keys/design.md` §3), unknown
 * third-party URLs SHALL NOT be silently normalized into first-party slugs;
 * a custom manifest must declare its canonical key explicitly. Returning
 * `null` for unknown inputs preserves that fail-closed posture.
 *
 * Keep this module pure (no DB, no fs, no network) so it stays cheap to
 * unit-test and safe to import from any layer.
 */

import {
  FIRST_PARTY_CONNECTOR_KEYS,
  LEGACY_LOCAL_ALIASES,
  NATIVE_CONNECTOR_KEYS,
} from "./generated/connector-registry.generated.ts";

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";

// FIRST_PARTY_CONNECTOR_KEYS, NATIVE_CONNECTOR_KEYS, and LEGACY_LOCAL_ALIASES
// are generated from the shipped connector manifests and the connector
// package's own local-collector bundle registry — see
// connector-registry.generated.ts and
// scripts/generate-connector-registry.ts. This module only builds the
// lookup structures (Sets/inverse maps) around that manifest-derived data;
// it does not hand-maintain a connector-id list itself. Third-party/custom
// connectors are unaffected: they simply are not in the generated set, and
// `canonicalConnectorKey` already fails closed (returns `null`) for anything
// outside it — see the module docstring above.

const FIRST_PARTY_CONNECTOR_KEY_SET = new Set(FIRST_PARTY_CONNECTOR_KEYS);
const NATIVE_CONNECTOR_KEY_SET = new Set(NATIVE_CONNECTOR_KEYS);
const LEGACY_LOCAL_ALIAS_SET = new Set(Object.keys(LEGACY_LOCAL_ALIASES));
const CONNECTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

type LegacyLocalAlias = keyof typeof LEGACY_LOCAL_ALIASES;

function isLegacyLocalAliasKey(value: string): value is LegacyLocalAlias {
  return LEGACY_LOCAL_ALIAS_SET.has(value);
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Return the canonical short connector key for a URL-shaped first-party
 * connector id (`https://registry.pdpp.dev/connectors/<slug>`), or `null`
 * if `value` is not in the first-party allowlist.
 *
 * Trailing slashes are tolerated to match common copy/paste behavior, but
 * any additional path segments, query string, or fragment cause `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function connectorKeyFromRegistryUrl(value: unknown): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return null;
  }
  let tail = trimmed.slice(FIRST_PARTY_REGISTRY_PREFIX.length);
  // Tolerate one trailing slash, but reject anything past it.
  if (tail.endsWith("/")) {
    tail = tail.slice(0, -1);
  }
  if (!tail || tail.includes("/") || tail.includes("?") || tail.includes("#")) {
    return null;
  }
  return FIRST_PARTY_CONNECTOR_KEY_SET.has(tail) ? tail : null;
}

/**
 * Return the canonical short connector key for any accepted operational
 * `connector_id` value the reference implementation currently writes or
 * reads, or `null` if the value is not in a known shape.
 *
 * Accepted shapes (today's union):
 *   - URL-shaped first-party id: `https://registry.pdpp.dev/connectors/<slug>`
 *   - Native bare slug from `reference-implementation/manifests/*.json`
 *     (e.g. `northstar_hr_native`)
 *   - Bare first-party canonical key (e.g. `gmail`, `claude-code`)
 *   - Legacy snake_case local-collector alias (`claude_code`, `codex`)
 *
 * Returns `null` for:
 *   - empty / non-string input
 *   - URL-shaped values that point at unknown first-party slugs (fail
 *     closed — a third-party connector must declare its own canonical key
 *     in its manifest rather than being implicitly promoted)
 *   - any other unrecognized string
 *
 * Pure function: no DB, no I/O, no caching.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalConnectorKey(value: unknown): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorKeyFromRegistryUrl(trimmed);
  }
  if (FIRST_PARTY_CONNECTOR_KEY_SET.has(trimmed)) {
    return trimmed;
  }
  if (NATIVE_CONNECTOR_KEY_SET.has(trimmed)) {
    return trimmed;
  }
  if (isLegacyLocalAliasKey(trimmed)) {
    // isLegacyLocalAliasKey already proved membership via LEGACY_LOCAL_ALIAS_SET;
    // the `?? null` only satisfies noUncheckedIndexedAccess on the generated
    // Record's index signature.
    return LEGACY_LOCAL_ALIASES[trimmed] ?? null;
  }
  return null;
}

/**
 * True iff `value` is a syntactically valid operational connector key.
 * Custom connectors may use keys outside the first-party allowlist, but keys
 * must stay short/path-safe and must not be registry/document URLs.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isConnectorKey(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return CONNECTOR_KEY_PATTERN.test(trimmed) && !isRegistryUrlConnectorId(trimmed);
}

/**
 * Derive the canonical connector key from a parsed connector manifest
 * object. Reads explicit top-level `connector_key` first, then falls back
 * to top-level `connector_id` (legacy polyfill-style manifest), then
 * `storage_binding.connector_id` (native-style reference manifest). Returns
 * `null` if no accepted identity field yields a key.
 *
 * Custom manifests are accepted only through explicit `connector_key`; URL
 * or arbitrary-string `connector_id` values still fail closed unless they are
 * in the first-party/native/legacy allowlists above.
 *
 * @param {unknown} manifest
 * @returns {string | null}
 */
export function canonicalConnectorKeyFromManifest(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const record = manifest as Record<string, unknown>;
  if (isConnectorKey(record.connector_key)) {
    // isConnectorKey already proved record.connector_key is a non-empty
    // string via trimOrNull; re-deriving through the same helper avoids an
    // `as string` assertion on the narrowed-but-not-narrowed-by-TS value.
    const trimmed = trimOrNull(record.connector_key);
    if (trimmed) {
      return trimmed;
    }
  }
  const topLevel = canonicalConnectorKey(record.connector_id);
  if (topLevel) {
    return topLevel;
  }
  const storageBinding = record.storage_binding;
  if (storageBinding && typeof storageBinding === "object") {
    return canonicalConnectorKey((storageBinding as Record<string, unknown>).connector_id);
  }
  return null;
}

/**
 * True iff `value` is a URL-shaped first-party connector id (whether or
 * not its slug is in the allowlist). Used by call sites that want to
 * detect "this looks like a registry URL — refuse it on an active
 * surface" without needing to know the allowlist contents.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRegistryUrlConnectorId(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return trimmed.startsWith(FIRST_PARTY_REGISTRY_PREFIX);
}

/**
 * True iff `value` is one of the migration-only legacy local-collector
 * aliases (`claude_code`, `codex`). Useful for migration diagnostics.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLegacyLocalAlias(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return LEGACY_LOCAL_ALIAS_SET.has(trimmed);
}

// Connector id substrings that identify test/stub/internal connectors that
// should not appear in owner-facing pickers or public surfaces. Matches the
// same set filtered by `isPublicReferenceConnector` in ref-control.ts for
// catalog visibility; kept here so pure connector-key helpers can apply the
// same guard without importing TypeScript modules.
const INTERNAL_CONNECTOR_ID_PARTS = Object.freeze([
  "manual_action_stub",
  "manual-action-stub",
  "stream-test-stub",
  "pg_runtime_",
  "pg_canonical_",
  "pg_expand_",
  "pg_lexical_backfill_",
]);

/**
 * True iff `value` contains a marker substring that identifies a test,
 * stub, or internal connector that must not appear in owner-facing consent
 * pickers or user-visible surfaces. Returns false for null/non-string inputs
 * (fail open — unknown ids are not silently excluded).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInternalConnectorId(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return INTERNAL_CONNECTOR_ID_PARTS.some((part) => trimmed.includes(part));
}

/**
 * Read-only allowlist getters. Returned arrays/objects are frozen so
 * callers cannot accidentally mutate the shared mapping table.
 */
export function firstPartyConnectorKeys() {
  return FIRST_PARTY_CONNECTOR_KEYS;
}

export function nativeConnectorKeys() {
  return NATIVE_CONNECTOR_KEYS;
}

export function legacyLocalAliasMap() {
  return LEGACY_LOCAL_ALIASES;
}
