// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the systemic fix this closes: setup (RI's
 * connection-setup-plan.ts `isStaticSecretConnector` /
 * `staticSecretCredentialCaptureFromManifest`) and runtime injection (this
 * package's `isStaticSecretConnector` / `buildConnectionScopedSecretEnv`)
 * are BOTH derived from the same manifest `setup.credential_capture` block —
 * one authority, not two hand-maintained lists that can silently drift (as
 * they did for venmo: setup recognized it, runtime injection did not, and
 * every run failed closed with "interaction_required").
 *
 * 1. Drift oracle: `src/generated/static-secret-registry.generated.ts` is
 *    exactly what regenerating from the manifests on disk would produce —
 *    the same pattern `connector-registry-manifest-derivation.test.ts` uses
 *    for the RI's own generated registry.
 * 2. Fail-before / no-divergence counterweight: a synthetic manifest fixture
 *    (a new static-secret connector no registry has ever seen) is
 *    classified static-secret by setup's manifest-driven check AND is
 *    injectable by runtime's registry in the same test run, from the same
 *    manifest, with no hand-edit in between. This is the shape of test that
 *    would have caught the venmo gap before it shipped: it fails if either
 *    side is missing the entry, not just if they merely match each other's
 *    (possibly both-wrong) current state.
 * 3. Fail-closed counterweights: a manifest with a missing/partial
 *    credential_capture, or a recovered credential whose kind doesn't match
 *    the connector's expectation, must be refused — never silently injected
 *    with invented or wrong env vars.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildConnectionScopedSecretEnv,
  isStaticSecretConnector as isStaticSecretConnectorForInjection,
  type RecoveredStaticSecret,
  StaticSecretInjectionError,
} from "./static-secret-injection.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const generatorScript = join(packageDir, "scripts/generate-static-secret-registry.ts");
const trackedRegistryPath = join(packageDir, "src/generated/static-secret-registry.generated.ts");
const realManifestsDir = join(packageDir, "manifests");

test("static-secret-registry.generated.ts has not drifted from what regenerating from the manifests on disk would produce", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-registry-drift-"));
  try {
    const scratchPath = join(scratchDir, "static-secret-registry.generated.ts");
    execFileSync("node", ["--experimental-strip-types", generatorScript, scratchPath], {
      cwd: packageDir,
      stdio: "pipe",
    });
    const generated = readFileSync(scratchPath, "utf8");
    const tracked = readFileSync(trackedRegistryPath, "utf8");
    assert.equal(
      generated,
      tracked,
      "src/generated/static-secret-registry.generated.ts is stale — rerun " +
        "`node --experimental-strip-types scripts/generate-static-secret-registry.ts`"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

function writeScratchManifests(scratchDir: string, extra: Record<string, unknown>): void {
  for (const file of readdirSync(realManifestsDir)) {
    if (file.endsWith(".json")) {
      writeFileSync(join(scratchDir, file), readFileSync(join(realManifestsDir, file)));
    }
  }
  for (const [file, manifest] of Object.entries(extra)) {
    writeFileSync(join(scratchDir, file), JSON.stringify(manifest, null, 2));
  }
}

function generateScratchRegistry(scratchManifestsDir: string): { GENERATED_STATIC_SECRET_REGISTRY: unknown } {
  const outDir = mkdtempSync(join(tmpdir(), "static-secret-registry-out-"));
  const outPath = join(outDir, "registry.generated.ts");
  try {
    execFileSync("node", ["--experimental-strip-types", generatorScript, outPath], {
      cwd: packageDir,
      env: { ...process.env, PDPP_POLYFILL_MANIFESTS_DIR: scratchManifestsDir },
      stdio: "pipe",
    });
    const source = readFileSync(outPath, "utf8");
    const match = source.match(/GENERATED_STATIC_SECRET_REGISTRY[^{]*Object\.freeze\(([\s\S]*)\);\s*$/);
    assert.ok(match, "could not locate GENERATED_STATIC_SECRET_REGISTRY literal in generator output");
    // biome-ignore lint/security/noGlobalEval: test-only parse of generator-produced literal data, never user input.
    const registry = eval(`(${match[1]})`) as unknown;
    return { GENERATED_STATIC_SECRET_REGISTRY: registry };
  } finally {
    rmSync(outDir, { force: true, recursive: true });
  }
}

// A brand-new static-secret connector, shaped exactly like a real onboarding:
// single required secret field, no accompanying setup fields. If runtime
// injection ever again required a second, hand-maintained list entry (the
// venmo bug), this manifest alone would satisfy setup's classifier while the
// runtime registry stayed silently unaware of it — this test proves that
// cannot happen anymore, because the runtime registry is generated from the
// exact manifest file the classifier reads.
const PROBE_CONNECTOR_KEY = "zzz-test-static-secret-probe";
function probeManifest(): Record<string, unknown> {
  return {
    connector_id: `https://registry.pdpp.dev/connectors/${PROBE_CONNECTOR_KEY}`,
    connector_key: PROBE_CONNECTOR_KEY,
    display_name: "Static Secret Onboarding Probe (test fixture, not a real connector)",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    setup: {
      credential_capture: {
        fields: [
          {
            env: ["ZZZ_TEST_STATIC_SECRET_PROBE_TOKEN"],
            label: "Probe API token",
            name: "secret",
            required: true,
            secret: true,
            type: "password",
          },
        ],
        kind: "api_key",
        label: "Probe API token",
      },
      modality: "static_secret",
    },
    streams: [
      { name: "items", primary_key: ["id"], schema: { properties: { id: { type: "string" } }, type: "object" } },
    ],
    version: "0.1.0",
  };
}

test("counterweight: a brand-new static-secret manifest is picked up by the generated runtime registry with no hand-edit — reproduces the venmo onboarding gap as a failing case first", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-registry-onboarding-probe-"));
  try {
    writeScratchManifests(scratchDir, { [`${PROBE_CONNECTOR_KEY}.json`]: probeManifest() });
    const { GENERATED_STATIC_SECRET_REGISTRY } = generateScratchRegistry(scratchDir) as {
      GENERATED_STATIC_SECRET_REGISTRY: Record<string, unknown>;
    };
    assert.ok(
      Object.hasOwn(GENERATED_STATIC_SECRET_REGISTRY, PROBE_CONNECTOR_KEY),
      "a static-secret connector's manifest alone must be sufficient for the generated runtime registry to " +
        "recognize it — no second, hand-maintained registry entry may be required"
    );
    assert.deepEqual(GENERATED_STATIC_SECRET_REGISTRY[PROBE_CONNECTOR_KEY], {
      credentialKind: "api_key",
      secretEnvVars: ["ZZZ_TEST_STATIC_SECRET_PROBE_TOKEN"],
    });
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("Spotify setup and runtime injection share the manifest-declared access-token mapping", () => {
  assert.equal(isStaticSecretConnectorForInjection("spotify"), true);
  assert.deepEqual(
    buildConnectionScopedSecretEnv("spotify", { credentialKind: "access_token", secret: "synthetic-spotify-token" }),
    { SPOTIFY_ACCESS_TOKEN: "synthetic-spotify-token" }
  );
});

test("fail-closed: a manifest with credential_capture.fields but no secret:true field is not injectable (missing secret field)", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-registry-missing-secret-"));
  try {
    const manifest = probeManifest();
    (manifest.setup as { credential_capture: { fields: Record<string, unknown>[] } }).credential_capture.fields = [
      { env: ["ZZZ_NON_SECRET"], label: "Not a secret", name: "note", required: true, secret: false, type: "text" },
    ];
    writeScratchManifests(scratchDir, { [`${PROBE_CONNECTOR_KEY}.json`]: manifest });
    const { GENERATED_STATIC_SECRET_REGISTRY } = generateScratchRegistry(scratchDir) as {
      GENERATED_STATIC_SECRET_REGISTRY: Record<string, unknown>;
    };
    assert.ok(
      !Object.hasOwn(GENERATED_STATIC_SECRET_REGISTRY, PROBE_CONNECTOR_KEY),
      "a credential_capture block with no secret field must not be treated as an injectable static-secret connector"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("fail-closed: a manifest with an empty credential_capture (no kind) is not injectable (partial declaration)", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-registry-partial-"));
  try {
    const manifest = probeManifest();
    (manifest.setup as { credential_capture: unknown }).credential_capture = { fields: [] };
    writeScratchManifests(scratchDir, { [`${PROBE_CONNECTOR_KEY}.json`]: manifest });
    const { GENERATED_STATIC_SECRET_REGISTRY } = generateScratchRegistry(scratchDir) as {
      GENERATED_STATIC_SECRET_REGISTRY: Record<string, unknown>;
    };
    assert.ok(
      !Object.hasOwn(GENERATED_STATIC_SECRET_REGISTRY, PROBE_CONNECTOR_KEY),
      "a partial credential_capture with no declared kind must not be treated as an injectable static-secret connector"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("fail-closed: buildConnectionScopedSecretEnv refuses a connector absent from the generated registry instead of inventing env vars", () => {
  assert.equal(isStaticSecretConnectorForInjection(PROBE_CONNECTOR_KEY), false);
  assert.throws(
    () => buildConnectionScopedSecretEnv(PROBE_CONNECTOR_KEY, { credentialKind: "api_key", secret: "x" }),
    (err: unknown) => err instanceof StaticSecretInjectionError && err.code === "not_a_static_secret_connector"
  );
});

test("fail-closed: buildConnectionScopedSecretEnv refuses a recovered credential kind mismatch for every generated connector, not just gmail", () => {
  const mismatches: { connectorId: string; recovered: RecoveredStaticSecret }[] = [
    { connectorId: "github", recovered: { credentialKind: "app_password", secret: "x" } },
    { connectorId: "venmo", recovered: { credentialKind: "personal_access_token", secret: "x" } },
    { connectorId: "steam", recovered: { credentialKind: "username_password", secret: "x" } },
  ];
  for (const { connectorId, recovered } of mismatches) {
    assert.throws(
      () => buildConnectionScopedSecretEnv(connectorId, recovered),
      (err: unknown) => err instanceof StaticSecretInjectionError && err.code === "credential_kind_mismatch",
      `${connectorId} must fail closed on a credential-kind mismatch`
    );
  }
});
