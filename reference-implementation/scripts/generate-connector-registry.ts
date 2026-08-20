// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates `server/generated/connector-registry.generated.ts` from the
 * shipped connector manifests (`packages/polyfill-connectors/manifests/*.json`,
 * `reference-implementation/fixtures/seed-manifests/*.json`) and the connector-owned
 * local-collector bundle registry (`@pdpp/polyfill-connectors/collectors`).
 *
 * Why this exists: `server/connector-key.ts` and `server/connection-setup-plan.ts`
 * are imported by `apps/console` (browser/edge bundling) and must stay free of
 * `node:fs`, so they cannot scan the manifests directory at load time. Before
 * this generator, the fix was a hand-copied literal array plus a test that
 * failed CI on drift — the RI still hardcoded the connector-id list, a test
 * just caught divergence after the fact. This generator makes the manifests
 * (plus the connector package's own local-collector registry) the actual
 * source of truth: the checked-in `connector-registry.generated.ts` is
 * produced BY this script, never hand-edited, and `scripts/check-generated-
 * artifacts.ts` fails CI if it drifts from what this script would produce.
 * It lives under `server/generated/` (not `server/`) so the
 * zero-connector-knowledge conformance guard's existing `generated/`
 * directory exemption applies to it — the file is manifest-derived data, not
 * RI-authored connector knowledge, matching the same exemption manifests
 * themselves get.
 *
 * Every exported set here is derived from a manifest-declared fact:
 *   - firstPartyConnectorKeys: every manifest's connector_key (or the
 *     canonical slug of its connector_id)
 *   - nativeConnectorKeys: manifests using storage_binding.connector_id
 *     instead of a registry-URL connector_id (reference-implementation/fixtures/seed-manifests)
 *   - legacyLocalAliases: derived by cross-referencing each local-collector
 *     bundle definition's own `connector_id` (the npm-package directory name,
 *     necessarily snake_case) against its manifest's canonical `connector_key`
 *     — an alias entry exists only where the two differ
 *   - localCollectorProvenKeys: manifests declaring
 *     capabilities.proven.local_collector === true, ordered by
 *     LOCAL_COLLECTOR_DEFINITIONS's own connector_id iteration order (the
 *     connector package's documented supported public order), not
 *     alphabetically — the enrollment UI's connector picker renders in this
 *     order
 *   - browserBoundKeys: manifests declaring runtime_requirements.bindings.browser
 *   - providerAuthLifecycleProvenKeys: manifests declaring
 *     capabilities.proven.provider_auth_lifecycle === true
 *   - staticSecretLiveProvenKeys: manifests declaring
 *     capabilities.proven.static_secret_live.proven === true
 *
 * Takes one optional CLI arg: an output path to write to instead of the
 * tracked `server/generated/connector-registry.generated.ts` (used by the
 * drift check to render into a scratch directory without touching the real
 * file).
 *
 * The polyfill-connector manifests source is overridable via
 * `PDPP_POLYFILL_MANIFESTS_DIR` (see `@pdpp/polyfill-connectors`'s
 * `readPolyfillManifests`) so tests can point the generator at a scratch
 * manifest directory instead of writing synthetic/probe manifests into the
 * real, shared `packages/polyfill-connectors/manifests`. Unset in normal use
 * (CLI, `pnpm run generate:connector-registry`, the drift-check test), where
 * the real directory applies. `reference-implementation/fixtures/seed-manifests` (RI's own
 * native-storage-binding fixtures) has no override — no test currently needs
 * one — and is always read from its real, fixed location.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const riRoot = resolve(scriptDir, "..");
const repoRoot = resolve(riRoot, "..");
const targetPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(riRoot, "server/generated/connector-registry.generated.ts");

interface ManifestLike {
  capabilities?: {
    proven?: {
      local_collector?: unknown;
      provider_auth_lifecycle?: unknown;
      static_secret_live?: { proven?: unknown };
    };
  };
  connector_id?: unknown;
  connector_key?: unknown;
  runtime_requirements?: { bindings?: Record<string, unknown> };
  storage_binding?: { connector_id?: unknown };
}

// Polyfill-connector manifest enumeration/loading is connector-package
// knowledge, not RI knowledge: this generator consumes the package's own
// `readPolyfillManifests` export rather than walking
// `packages/polyfill-connectors/manifests` itself. Loaded via a direct file
// path (not the `@pdpp/polyfill-connectors/manifests` specifier) because
// this script runs standalone via `node --experimental-strip-types`,
// without workspace package resolution — matching the existing
// `collector-registry.ts` import below.
const { readPolyfillManifests } = (await import(
  resolve(repoRoot, "packages/polyfill-connectors/src/manifest-registry.ts")
)) as { readPolyfillManifests: () => { file: string; manifest: ManifestLike }[] };

/** Parses one reference-implementation manifest JSON file at `manifestPath`. */
function readReferenceManifestFile(manifestPath: string): ManifestLike {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestLike;
}

function readReferenceManifests(): { file: string; manifest: ManifestLike }[] {
  const realDir = resolve(riRoot, "fixtures", "seed-manifests");
  const out: { file: string; manifest: ManifestLike }[] = [];
  for (const file of readdirSync(realDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    out.push({ file, manifest: readReferenceManifestFile(resolve(realDir, file)) });
  }
  return out;
}

const REGISTRY_URL_PREFIX = "https://registry.pdpp.dev/connectors/";

function canonicalSlug(connectorId: string): string {
  return connectorId.startsWith(REGISTRY_URL_PREFIX) ? connectorId.slice(REGISTRY_URL_PREFIX.length) : connectorId;
}

function manifestKey(manifest: ManifestLike): string | null {
  if (typeof manifest.connector_key === "string" && manifest.connector_key.trim()) {
    return manifest.connector_key.trim();
  }
  if (typeof manifest.connector_id === "string" && manifest.connector_id.trim()) {
    return canonicalSlug(manifest.connector_id.trim());
  }
  return null;
}

const polyfillManifests = readPolyfillManifests();
const referenceManifests = readReferenceManifests();

// First-party connector keys: every polyfill manifest's canonical key.
// (reference-implementation/fixtures/seed-manifests are the native-storage-binding fixtures
// handled separately below — northstar-hr has no connector_id/connector_key
// at all and is excluded, matching today's hand-maintained list.)
const firstPartyConnectorKeys = polyfillManifests
  .map(({ manifest }) => manifestKey(manifest))
  .filter((key): key is string => key !== null)
  .sort((a, b) => a.localeCompare(b));

// Native connector keys: reference-implementation/fixtures/seed-manifests entries that
// declare storage_binding.connector_id instead of a registry-URL connector_id.
const nativeConnectorKeys = referenceManifests
  .map(({ manifest }) => manifest.storage_binding?.connector_id)
  .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
  .sort((a, b) => a.localeCompare(b));

// Legacy local-collector aliases: cross-reference each bundle definition's
// own connector_id (bundle directory name) against its manifest's canonical
// connector_key. An alias entry exists only where the two differ — this is
// the connector package's own bundling convention, not RI-invented knowledge.
const { LOCAL_COLLECTOR_DEFINITIONS } = (await import(
  resolve(repoRoot, "packages/polyfill-connectors/src/collector-registry.ts")
)) as { LOCAL_COLLECTOR_DEFINITIONS: readonly { connector_id: string }[] };

const manifestByBundleSlug = new Map<string, ManifestLike>();
for (const { manifest } of polyfillManifests) {
  const key = manifestKey(manifest);
  if (key) {
    manifestByBundleSlug.set(key.replace(/-/g, "_"), manifest);
  }
}

const legacyLocalAliases: Record<string, string> = {};
for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
  const bundleId = definition.connector_id;
  const manifest = manifestByBundleSlug.get(bundleId);
  const canonicalKey = manifest ? manifestKey(manifest) : null;
  // Always record the identity mapping too (matches today's `codex: "codex"`
  // entry) so callers keying by every bundled connector id resolve uniformly.
  legacyLocalAliases[bundleId] = canonicalKey ?? bundleId;
}

// Local-collector proven keys: capabilities.proven.local_collector === true,
// ordered by LOCAL_COLLECTOR_DEFINITIONS's own connector_id iteration order
// (the connector package's documented supported public order), not
// alphabetically — this order is consumed by the enrollment UI's connector
// picker and must match its pinned COLLECTOR_RUN_CONNECTORS literal.
const provenManifestsByKey = new Map(
  polyfillManifests
    .filter(({ manifest }) => manifest.capabilities?.proven?.local_collector === true)
    .map(({ manifest }) => [manifestKey(manifest), manifest] as const)
    .filter((entry): entry is [string, ManifestLike] => entry[0] !== null)
);

// Fail loud on either direction of drift between "manifests claiming the
// local_collector proof" and "LOCAL_COLLECTOR_DEFINITIONS entries" — walking
// LOCAL_COLLECTOR_DEFINITIONS below (to get the canonical order) silently
// drops a proven manifest that has no matching definition entry unless this
// is checked explicitly first: that manifest never appears in the walk's
// input at all, so there is nothing downstream that would notice its
// disappearance. A contributor who ships a proven manifest without wiring
// its LocalCollectorDefinition (or vice versa) must see CI fail here, not a
// connector silently missing from the enrollment picker.
const definitionKeysByBundleId = new Map(
  LOCAL_COLLECTOR_DEFINITIONS.map((definition) => {
    const manifest = manifestByBundleSlug.get(definition.connector_id);
    return [definition.connector_id, manifest ? manifestKey(manifest) : null] as const;
  })
);
const definitionCanonicalKeys = new Set(
  [...definitionKeysByBundleId.values()].filter((key): key is string => key !== null)
);
const provenKeysMissingADefinition = [...provenManifestsByKey.keys()].filter(
  (key) => !definitionCanonicalKeys.has(key)
);
if (provenKeysMissingADefinition.length > 0) {
  throw new Error(
    "capabilities.proven.local_collector=true declared for connector(s) with no matching " +
      "LOCAL_COLLECTOR_DEFINITIONS entry in packages/polyfill-connectors/src/collector-registry.ts: " +
      `${provenKeysMissingADefinition.join(", ")}. A proven local-collector manifest must have a ` +
      "LocalCollectorDefinition wired into LOCAL_COLLECTOR_DEFINITIONS, or the proof claim must be removed."
  );
}
const definitionsWithoutAProvenManifest = [...definitionKeysByBundleId.entries()].filter(
  ([, canonicalKey]) => canonicalKey !== null && !provenManifestsByKey.has(canonicalKey)
);
if (definitionsWithoutAProvenManifest.length > 0) {
  throw new Error(
    "LOCAL_COLLECTOR_DEFINITIONS entry/entries with no matching capabilities.proven.local_collector=true " +
      `manifest declaration: ${definitionsWithoutAProvenManifest.map(([bundleId]) => bundleId).join(", ")}. ` +
      "A bundled LocalCollectorDefinition must have its manifest declare the proof, or the definition must " +
      "be removed from LOCAL_COLLECTOR_DEFINITIONS."
  );
}

const localCollectorProvenKeys = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => {
  const manifest = manifestByBundleSlug.get(definition.connector_id);
  const canonicalKey = manifest ? manifestKey(manifest) : null;
  return canonicalKey && provenManifestsByKey.has(canonicalKey) ? canonicalKey : null;
}).filter((key): key is string => key !== null);

// Browser-bound keys: runtime_requirements.bindings.browser present.
const browserBoundKeys = polyfillManifests
  .filter(({ manifest }) => Object.hasOwn(manifest.runtime_requirements?.bindings ?? {}, "browser"))
  .map(({ manifest }) => manifestKey(manifest))
  .filter((key): key is string => key !== null)
  .sort((a, b) => a.localeCompare(b));

// Provider-auth lifecycle proven keys: capabilities.proven.provider_auth_lifecycle === true.
const providerAuthLifecycleProvenKeys = polyfillManifests
  .filter(({ manifest }) => manifest.capabilities?.proven?.provider_auth_lifecycle === true)
  .map(({ manifest }) => manifestKey(manifest))
  .filter((key): key is string => key !== null)
  .sort((a, b) => a.localeCompare(b));

// Static-secret live proven keys: capabilities.proven.static_secret_live.proven === true.
const staticSecretLiveProvenKeys = polyfillManifests
  .filter(({ manifest }) => manifest.capabilities?.proven?.static_secret_live?.proven === true)
  .map(({ manifest }) => manifestKey(manifest))
  .filter((key): key is string => key !== null)
  .sort((a, b) => a.localeCompare(b));

function jsonArrayLiteral(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function jsonObjectLiteral(record: Record<string, string>): string {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  const lines = entries.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  return `{\n${lines.join("\n")}\n}`;
}

const output = `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// reference-implementation/scripts/generate-connector-registry.ts from the
// shipped connector manifests (packages/polyfill-connectors/manifests/,
// reference-implementation/fixtures/seed-manifests/) and
// @pdpp/polyfill-connectors's LOCAL_COLLECTOR_DEFINITIONS. Regenerate with
// \`pnpm --filter pdpp-reference-implementation run generate:connector-registry\`.
// scripts/check-generated-artifacts.ts fails CI if this file drifts from
// what the generator would produce for the manifests currently on disk —
// this is how the RI's setup/proof-gate classification stays manifest-derived
// instead of a hand-maintained connector-id allowlist. See
// docs/inbox/findings-deployment-env-vars.md (Cluster B).

/** Every first-party manifest's canonical connector_key. */
export const FIRST_PARTY_CONNECTOR_KEYS: readonly string[] = Object.freeze(${jsonArrayLiteral(firstPartyConnectorKeys)});

/** Native (storage_binding.connector_id) reference-fixture connector keys. */
export const NATIVE_CONNECTOR_KEYS: readonly string[] = Object.freeze(${jsonArrayLiteral(nativeConnectorKeys)});

/**
 * Legacy snake_case local-collector bundle id -> canonical manifest
 * connector_key, wherever the two differ. Derived by cross-referencing
 * LOCAL_COLLECTOR_DEFINITIONS (the bundle's own directory-name ids) against
 * each connector's manifest-declared connector_key.
 */
export const LEGACY_LOCAL_ALIASES: Readonly<Record<string, string>> = Object.freeze(${jsonObjectLiteral(legacyLocalAliases)});

/** Manifests declaring capabilities.proven.local_collector === true. */
export const LOCAL_COLLECTOR_PROVEN_KEYS: readonly string[] = Object.freeze(${jsonArrayLiteral(localCollectorProvenKeys)});

/** Manifests declaring a runtime_requirements.bindings.browser binding. */
export const BROWSER_BOUND_KEYS: readonly string[] = Object.freeze(${jsonArrayLiteral(browserBoundKeys)});

/** Manifests declaring capabilities.proven.provider_auth_lifecycle === true. */
export const PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS: readonly string[] = Object.freeze(${jsonArrayLiteral(providerAuthLifecycleProvenKeys)});

/** Manifests declaring capabilities.proven.static_secret_live.proven === true. */
export const STATIC_SECRET_LIVE_PROVEN_KEYS: readonly string[] = Object.freeze(${jsonArrayLiteral(staticSecretLiveProvenKeys)});
`;

if (process.argv[2]) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(targetPath), { recursive: true });
}
const { writeFileSync } = await import("node:fs");
writeFileSync(targetPath, output);
console.log(`wrote ${targetPath}`);
