// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates `src/generated/static-secret-registry.generated.ts` from every
 * shipped connector manifest's `setup.credential_capture` block.
 *
 * Why this exists: setup (reference-implementation/server/connection-setup-plan.ts
 * `isStaticSecretConnector`/`staticSecretCredentialCaptureFromManifest`) already
 * classifies a connector as static-secret and describes its capture fields
 * purely from the manifest. Runtime injection (`static-secret-injection.ts`)
 * used to re-declare the same facts by hand in `STATIC_SECRET_CONNECTOR_REGISTRY`
 * — a second, hand-maintained authority that can (and did, for venmo) drift
 * from the manifest setup already trusts. This generator makes the manifest
 * the ONE authority for both: the checked-in `.generated.ts` is produced BY
 * this script, never hand-edited, and `scripts/check-generated-artifacts.ts`
 * fails CI if it drifts from what this script would produce.
 *
 * Split authority is closed by CONSTRUCTION, not just by agreement: this
 * generator and `connection-setup-plan.ts`'s
 * `staticSecretCredentialCaptureFromManifest` both call the same
 * `normalizeStaticSecretCredentialCapture` (`../src/static-secret-credential-capture.ts`)
 * to decide which fields are secret and what their contract requires. Setup
 * and this generator used to each hand-roll an equivalent-looking but subtly
 * different predicate — one recognized `type: "password"` without
 * `secret: true` as secret and the other did not, and one silently dropped a
 * secret field missing `label` while the other kept it. Sharing one function
 * makes that class of drift impossible rather than merely tested against.
 *
 * `static-secret-injection.ts` ships inside the publishable
 * `@pdpp/local-collector` runner slice (see `@pdpp/collector-runtime`), so it must
 * stay free of `node:fs` / directory scanning at import time on an owner's
 * machine — this generator does the manifest read once, at build/CI time, and
 * bakes the result into a plain data literal the runtime module imports. The
 * shared normalizer it and setup both call is equally free of `node:fs`.
 *
 * Derivation rule, straight from the manifest (via the shared normalizer) +
 * the console's own capture payload builder
 * (`apps/console/.../static-secret-payload.ts`
 * `bundledCredentialKind`/`bundledSecretPayload`/`collectStaticSecretSetupFields`,
 * which decide what the sealed `secret` string and `setup_fields` actually
 * contain at capture time):
 *   - `credential_kind` is `username_password` or `secret_bundle`: ALL secret
 *     fields (`field.secret === true`, where `secret` is either explicit or
 *     implied by `type: "password"` — see the shared normalizer) are sealed
 *     together as one JSON object -> `secretFieldEnvVars` keyed by field
 *     name. A secret field with `required !== true` in a manifest with 2+
 *     secret fields is an "at least one path" field (e.g. Jellyfin's
 *     username+password OR API key) -> `optionalSecretBundleFields`.
 *   - any other `credential_kind`: there is exactly one secret field -> its
 *     `env` names become `secretEnvVars`.
 *   - every non-secret field (`field.secret !== true`) is always a connector
 *     runtime-config value read from the source binding's `setup_fields` (the
 *     console's `collectStaticSecretSetupFields` populates this regardless of
 *     credential kind) -> `setupFieldEnvVars` keyed by field name.
 *
 * The shared normalizer throws `StaticSecretCredentialCaptureError` (failing
 * this generator, and CI via `check-generated-artifacts.ts`) if a manifest
 * declares a secret field with no `label` or zero `env` aliases — both are
 * contract violations that would otherwise let this generator and setup
 * silently disagree on whether the connector is usable.
 *
 * Two connectors carry credential shapes their CURRENT manifest cannot
 * express, because they predate that manifest shape: Reddit's retired sealed
 * OAuth bundle and Jellyfin's legacy bare `api_key` string. Both are captured
 * as `LEGACY_CREDENTIAL_KIND_MIGRATIONS` below — an explicit, minimal,
 * hand-maintained table keyed by (connector, legacy stored `credentialKind`),
 * never touched by this generator. They are old-data-shape facts, not new
 * manifest-derivable ones, and are called out by name in the generated
 * file's header so a reviewer sees exactly what is NOT manifest-derived and
 * why.
 *
 * Takes one optional CLI arg: an output path to write to instead of the
 * tracked `src/generated/static-secret-registry.generated.ts` (used by the
 * drift check to render into a scratch directory).
 *
 * The manifests source is overridable via `PDPP_POLYFILL_MANIFESTS_DIR` (see
 * `readPolyfillManifests`) so tests can point this generator at a scratch
 * manifest directory instead of the real, shared `manifests/`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isBundledStaticSecretCredentialKind,
  isFullyBundledStaticSecretCredentialKind,
  normalizeStaticSecretCredentialCapture,
  type StaticSecretCredentialCaptureLike,
} from "../src/static-secret-credential-capture.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const targetPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(packageDir, "src/generated/static-secret-registry.generated.ts");

interface ManifestLike {
  connector_id?: unknown;
  connector_key?: unknown;
  setup?: {
    credential_capture?: StaticSecretCredentialCaptureLike | null;
    modality?: unknown;
  } | null;
}

const { readPolyfillManifests } = (await import(resolve(packageDir, "src/manifest-registry.ts"))) as {
  readPolyfillManifests: () => { file: string; manifest: ManifestLike }[];
};

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

interface StaticSecretDescriptor {
  /**
   * Present (`false`) only when the manifest's block-level
   * `credential_capture.required` is explicitly `false` — omitted otherwise
   * (the backward-compatible default is `true`, so most connectors never
   * carry this key at all). Lets `injectSecretBundle`
   * (`../src/static-secret-injection.ts`) distinguish "the owner explicitly
   * chose to save no credential — inject nothing" from "a partial/corrupt
   * bundle is missing a required field — fail closed", which
   * `secretFieldEnvVars`/`optionalSecretBundleFields` alone cannot express:
   * an entirely EMPTY bundle for a required, multi-field capture (e.g.
   * Jellyfin) is still a bug to fail closed on, while the SAME empty bundle
   * for an explicitly optional capture (e.g. Venmo) is the valid "sign in by
   * hand every time" choice the manifest itself declares.
   */
  captureRequired?: false;
  credentialKind: string;
  optionalSecretBundleFields?: string[];
  secretEnvVars?: string[];
  secretFieldEnvVars?: Record<string, string[]>;
  setupFieldEnvVars?: Record<string, string[]>;
}

// Only `secret_bundle` treats the ENTIRE capture (secret and non-secret
// fields alike) as one opaque sealed JSON object — see the console's
// `bundledSecretPayload`, which puts every field, non-secret included, into
// the sealed `secret` string for this kind. `username_password` bundles only
// its secret fields (username/password); any accompanying non-secret field
// (e.g. Jellyfin's base_url) is genuinely separate connector runtime config,
// not part of the credential bundle. This distinction is real, observable
// behavior a scheduler-side test enforces for slack running with
// `sourceBinding: null` (reference-implementation/test/
// scheduler-static-secret-injection.test.ts): slack's non-secret
// `slack_workspace` must still resolve from the sealed secret alone.
function descriptorFromManifest(connectorKey: string, manifest: ManifestLike): StaticSecretDescriptor | null {
  const normalized = normalizeStaticSecretCredentialCapture(connectorKey, manifest.setup?.credential_capture);
  if (!normalized) {
    return null;
  }
  const { fields, kind: credentialKind, required } = normalized;
  const secretFields = fields.filter((field) => field.secret);
  if (secretFields.length === 0) {
    return null;
  }
  const fullyBundled = isFullyBundledStaticSecretCredentialKind(credentialKind);
  const bundleFields = fullyBundled ? fields : secretFields;
  const setupFields = fullyBundled ? [] : fields.filter((field) => !field.secret);
  const descriptor: StaticSecretDescriptor = {
    credentialKind,
    ...(required === false ? { captureRequired: false } : {}),
  };
  if (isBundledStaticSecretCredentialKind(credentialKind) && bundleFields.length > 1) {
    descriptor.secretFieldEnvVars = Object.fromEntries(bundleFields.map((field) => [field.name, [...field.env]]));
    const optional = bundleFields.filter((field) => !field.required).map((field) => field.name);
    if (optional.length > 0) {
      descriptor.optionalSecretBundleFields = optional;
    }
  } else {
    // Either exactly one secret field, or a bundled kind declared with only
    // one secret field — still a single bare-string secret, not a JSON
    // bundle (no field to key it by).
    // biome-ignore lint/style/noNonNullAssertion: length === 1 in both branches reaching here.
    descriptor.secretEnvVars = [...secretFields[0]!.env];
  }
  if (setupFields.length > 0) {
    descriptor.setupFieldEnvVars = Object.fromEntries(setupFields.map((field) => [field.name, [...field.env]]));
  }
  return descriptor;
}

const polyfillManifests = readPolyfillManifests();

const entries: [string, StaticSecretDescriptor][] = [];
for (const { manifest } of polyfillManifests) {
  const key = manifestKey(manifest);
  if (!key) {
    continue;
  }
  const descriptor = descriptorFromManifest(key, manifest);
  if (descriptor) {
    entries.push([key, descriptor]);
  }
}
entries.sort(([a], [b]) => a.localeCompare(b));

function jsonStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function jsonStringArrayMap(record: Record<string, string[]>, indent: string): string {
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  if (keys.length === 0) {
    return "{}";
  }
  const lines = keys.map((key) => `${indent}  ${JSON.stringify(key)}: ${jsonStringArray(record[key] ?? [])},`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function descriptorLiteral(descriptor: StaticSecretDescriptor): string {
  const lines: string[] = [`      credentialKind: ${JSON.stringify(descriptor.credentialKind)},`];
  if (descriptor.captureRequired === false) {
    lines.push("      captureRequired: false,");
  }
  if (descriptor.secretEnvVars) {
    lines.push(`      secretEnvVars: ${jsonStringArray(descriptor.secretEnvVars)},`);
  }
  if (descriptor.secretFieldEnvVars) {
    lines.push(`      secretFieldEnvVars: ${jsonStringArrayMap(descriptor.secretFieldEnvVars, "      ")},`);
  }
  if (descriptor.optionalSecretBundleFields) {
    lines.push(`      optionalSecretBundleFields: ${jsonStringArray(descriptor.optionalSecretBundleFields)},`);
  }
  if (descriptor.setupFieldEnvVars) {
    lines.push(`      setupFieldEnvVars: ${jsonStringArrayMap(descriptor.setupFieldEnvVars, "      ")},`);
  }
  return `{\n${lines.join("\n")}\n    }`;
}

const registryBody = entries.map(
  ([key, descriptor]) => `    ${JSON.stringify(key)}: ${descriptorLiteral(descriptor)},`
);

const output = `// Copyright The PDP-Connect Contributors
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
// Regenerate with \`node --experimental-strip-types
// scripts/generate-static-secret-registry.ts\` from packages/polyfill-connectors.

export interface GeneratedStaticSecretDescriptor {
  /** \`false\` only when the manifest's credential_capture.required is explicitly false; omitted (defaults true) otherwise. */
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
${registryBody.join("\n")}
  });
`;

if (process.argv[2]) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(targetPath), { recursive: true });
}
const { writeFileSync } = await import("node:fs");
writeFileSync(targetPath, output);
console.log(`wrote ${targetPath}`);
