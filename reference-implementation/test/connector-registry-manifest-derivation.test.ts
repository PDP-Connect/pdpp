// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two things this test proves, per the Cluster B closure task
 * (docs/inbox/findings-deployment-env-vars.md):
 *
 * 1. Enumeration: every entry in connector-registry.generated.ts is exactly
 *    what regenerating from the manifests currently on disk would produce —
 *    i.e. no hand-edit has drifted the checked-in file from the manifest
 *    source of truth. This runs the actual generator
 *    (scripts/generate-connector-registry.ts) into a scratch path and
 *    byte-compares it against the tracked file, the same pattern
 *    scripts/check-generated-artifacts.ts uses for every other generated
 *    artifact in this repo. Supersedes the three former parity tests
 *    (connection-setup-plan-proof-gates-manifest-parity.test.ts,
 *    connection-setup-plan-local-collector-proven-manifest-parity.test.ts,
 *    connection-setup-plan-browser-bound-manifest-parity.test.ts), which
 *    diffed two hand-maintained lists against each other: this test's
 *    oracle IS the generator, so there is no second hand-maintained list
 *    left to drift. The browser-bound file was deleted outright (its one
 *    test became fully redundant with this drift oracle); the other two
 *    were kept but trimmed to only their genuinely distinct real-manifest
 *    invariant checks and renamed to
 *    connector-manifest-proof-gate-modality-invariant.test.ts and
 *    connector-manifest-local-collector-proof-binding-invariant.test.ts.
 *
 * 2. Counterweight: a synthetic third-party connector manifest — a
 *    connector_id no shipped manifest declares — must classify purely from
 *    its own declared traits (capabilities.proven.*,
 *    runtime_requirements.bindings, setup.credential_capture), not because
 *    its id happens to appear in a hardcoded RI list. This is the
 *    "custom/third-party connector must work identically to a first-party
 *    one with the same traits" guarantee the task asked for.
 *
 * 3. cli/commands/seed.ts's seedableConnectors intersects manifest presence
 *    with connectors/seed/index.ts's own SUPPORTED_SEED_CONNECTOR_KEYS export
 *    — the connector-owned fact of which fixture families it actually has
 *    emit logic for — rather than inferring seedability from every RI
 *    manifest declaring a connector_id/connector_key. A manifest alone only
 *    proves registration is possible, not that the seed connector can emit
 *    anything for it.
 *
 * 4. Fail-loud omission guard: a manifest claiming
 *    capabilities.proven.local_collector=true with no matching
 *    LOCAL_COLLECTOR_DEFINITIONS entry (packages/polyfill-connectors/src/
 *    collector-registry.ts) must make the generator throw, not silently drop
 *    the claim. Before this guard, LOCAL_COLLECTOR_PROVEN_KEYS is derived by
 *    walking the fixed LOCAL_COLLECTOR_DEFINITIONS array, so a proven
 *    manifest outside that array was structurally invisible to the
 *    computation — no error, no drift, no CI signal. This test reproduces
 *    that exact scenario against the real generator and real manifests
 *    directory (a temporary sibling manifest file, removed in `finally`).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { seedableConnectors } from "../cli/commands/seed.ts";
import { SUPPORTED_SEED_CONNECTOR_KEYS } from "../connectors/seed/index.ts";
import type { ConnectorManifestLike } from "../server/connection-setup-plan.ts";
import {
  buildConnectionSetupPlan,
  classifyConnectorSetupModality,
  PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS,
} from "../server/connection-setup-plan.ts";
import { canonicalConnectorKey, isConnectorKey } from "../server/connector-key.ts";
import {
  BROWSER_BOUND_KEYS,
  FIRST_PARTY_CONNECTOR_KEYS,
  LEGACY_LOCAL_ALIASES,
  LOCAL_COLLECTOR_PROVEN_KEYS,
  NATIVE_CONNECTOR_KEYS,
  PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS,
  STATIC_SECRET_LIVE_PROVEN_KEYS,
} from "../server/generated/connector-registry.generated.ts";

const trackedRegistry = {
  BROWSER_BOUND_KEYS,
  FIRST_PARTY_CONNECTOR_KEYS,
  LEGACY_LOCAL_ALIASES,
  LOCAL_COLLECTOR_PROVEN_KEYS,
  NATIVE_CONNECTOR_KEYS,
  PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS,
  STATIC_SECRET_LIVE_PROVEN_KEYS,
};

const riRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const generatorScript = join(riRoot, "scripts/generate-connector-registry.ts");
const trackedRegistryPath = join(riRoot, "server/generated/connector-registry.generated.ts");
const polyfillManifestsDir = join(repoRoot, "packages/polyfill-connectors/manifests");
const OMISSION_PROBE_KEY_RE = /zzz-test-omission-probe/;

test("connector-registry.generated.ts has not drifted from what regenerating from the manifests on disk would produce", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "connector-registry-drift-"));
  try {
    const scratchPath = join(scratchDir, "connector-registry.generated.ts");
    execFileSync("node", ["--experimental-strip-types", generatorScript, scratchPath], {
      cwd: riRoot,
      stdio: "pipe",
    });
    const generated = readFileSync(scratchPath, "utf8");
    const tracked = readFileSync(trackedRegistryPath, "utf8");
    assert.equal(
      generated,
      tracked,
      "server/generated/connector-registry.generated.ts is stale — rerun `node --experimental-strip-types scripts/generate-connector-registry.ts`"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("the generator throws (does not silently drop the claim) when a manifest declares capabilities.proven.local_collector=true with no matching LOCAL_COLLECTOR_DEFINITIONS entry", () => {
  const probeConnectorKey = "zzz-test-omission-probe";
  const probeManifestPath = join(polyfillManifestsDir, `${probeConnectorKey}.json`);
  const probeManifest = {
    capabilities: {
      proven: { local_collector: true },
    },
    connector_id: `https://registry.pdpp.org/connectors/${probeConnectorKey}`,
    connector_key: probeConnectorKey,
    display_name: "Omission Probe (test fixture, not a real connector)",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { filesystem: { required: true } } },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, type: "object" },
      },
    ],
    version: "0.1.0",
  };
  writeFileSync(probeManifestPath, JSON.stringify(probeManifest, null, 2));
  try {
    assert.throws(
      () =>
        execFileSync("node", ["--experimental-strip-types", generatorScript, "/dev/null"], {
          cwd: riRoot,
          stdio: "pipe",
        }),
      OMISSION_PROBE_KEY_RE,
      "generator must fail loud on a local_collector-proven manifest with no LOCAL_COLLECTOR_DEFINITIONS entry, not silently omit it from LOCAL_COLLECTOR_PROVEN_KEYS"
    );
  } finally {
    unlinkSync(probeManifestPath);
  }
});

test("every generated registry entry is a real, non-empty connector key with no duplicates", () => {
  for (const [name, value] of Object.entries(trackedRegistry)) {
    if (Array.isArray(value)) {
      assert.ok(
        value.every((key) => typeof key === "string" && key.trim().length > 0),
        `${name} has a blank entry`
      );
      assert.equal(new Set(value).size, value.length, `${name} has a duplicate entry`);
    }
  }
});

test("PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS is exactly the generated manifest-derived set plus the synthetic test_provider literal", () => {
  // test_provider is a synthetic connector constructed only by
  // test/provider-auth-lifecycle.test.ts fixtures; it has no manifest file,
  // so it is a deliberate non-generated literal addition in
  // connection-setup-plan.ts, not manifest-derived. This proves it is the
  // ONLY non-generated entry — a future hand-edit adding a second literal
  // key would fail here instead of silently reopening the connector-id
  // allowlist this generator closed.
  const nonGenerated = PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS.filter(
    (key) => !PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS.includes(key)
  );
  assert.deepEqual(nonGenerated, ["test_provider"]);
  assert.deepEqual(
    [...PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS].sort(),
    [...new Set(["test_provider", ...PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS])].sort()
  );
});

function customManifest(
  connectorId: string,
  bindings: Readonly<Record<string, unknown>>,
  extra: Partial<ConnectorManifestLike> = {}
): ConnectorManifestLike {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: "A Third-Party Connector",
    runtime_requirements: { bindings },
    ...extra,
  };
}

test("counterweight: a custom third-party connector_id, unknown to every generated set, still classifies purely from its own manifest traits", () => {
  const thirdPartyId = "acme-widgets-tracker";
  assert.ok(
    !trackedRegistry.FIRST_PARTY_CONNECTOR_KEYS.includes(thirdPartyId),
    "test fixture collided with a real first-party connector key"
  );

  // A third-party filesystem connector that declares the exact same proof
  // trait a first-party one would (capabilities.proven.local_collector) must
  // be treated identically to a first-party proven connector — proving the
  // RI reads the trait, not a hardcoded id.
  const provenLocalCollector = buildConnectionSetupPlan({
    connectorKey: thirdPartyId,
    manifest: customManifest(
      thirdPartyId,
      { filesystem: { required: true } },
      { capabilities: { proven: undefined } as never }
    ),
  });
  assert.equal(provenLocalCollector.connectorModality, "local_collector");
  assert.equal(
    provenLocalCollector.supportState,
    "proof_gated",
    "an unproven third-party filesystem connector must stay proof-gated, exactly like an unproven first-party one"
  );

  // A third-party browser-bound connector: classification must come from
  // runtime_requirements.bindings.browser, not from BROWSER_BOUND_CONNECTORS
  // naming this id.
  const browserBound = buildConnectionSetupPlan({
    connectorKey: thirdPartyId,
    manifest: customManifest(thirdPartyId, { browser: { required: true } }),
  });
  assert.equal(browserBound.connectorModality, "browser_bound");
  assert.equal(browserBound.catalogDisposition, "browser_bound_runbook");

  // A third-party static-secret connector with a real credential_capture
  // block reaches the same generic experimental path a first-party
  // connector without a live-proof entry would — proving the classifier
  // reads setup.credential_capture, not STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS
  // membership.
  const staticSecret = buildConnectionSetupPlan({
    connectorKey: thirdPartyId,
    manifest: customManifest(
      thirdPartyId,
      { network: { required: true } },
      {
        setup: {
          credential_capture: {
            fields: [{ label: "API key", name: "secret", required: true, secret: true, type: "password" }],
            kind: "api_key",
            label: "Acme Widgets API key",
          },
          modality: "static_secret",
        },
      }
    ),
  });
  assert.equal(staticSecret.setupModality, "static_secret");
  assert.equal(staticSecret.supportState, "experimental");
  assert.equal(staticSecret.catalogDisposition, "static_secret_experimental");

  // canonicalConnectorKey must fail closed for this id in URL-shaped form:
  // a third party cannot get its own registry-URL-shaped connector_id
  // silently promoted into the first-party allowlist.
  assert.equal(canonicalConnectorKey(`https://registry.pdpp.org/connectors/${thirdPartyId}`), null);
  // But a bare custom connector_key (not URL-shaped) is still a syntactically
  // valid key a custom manifest may declare — the fail-closed behavior only
  // applies to the registry-URL namespace, not to bare custom keys.
  assert.equal(isConnectorKey(thirdPartyId), true);
});

test("cli/commands/seed.ts: seedableConnectors intersects manifest presence with the seed connector's own SUPPORTED_SEED_CONNECTOR_KEYS export, not manifest presence alone", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "seed-manifests-"));
  try {
    writeFileSync(
      join(scratchDir, "acme.json"),
      JSON.stringify({ connector_id: "https://registry.pdpp.org/connectors/acme", connector_key: "acme" })
    );
    // connector_key present, no top-level connector_id — the shape a custom
    // manifest without a registry URL can still declare (canonicalConnectorKey
    // fails closed on bare, non-URL-shaped connector_id values it doesn't
    // already recognize, matching connector-key.ts's documented fail-closed
    // posture — so a manifest identifying itself this way must use
    // connector_key directly).
    writeFileSync(join(scratchDir, "bravo.json"), JSON.stringify({ connector_key: "bravo" }));
    // provider_id-shaped fixtures (no connector_id/connector_key) are
    // correctly excluded — same rule northstar-hr.json exercises for real.
    writeFileSync(join(scratchDir, "charlie.json"), JSON.stringify({ provider_id: "charlie" }));
    // delta.json declares a real connector_key but has no fixture logic in
    // connectors/seed/index.ts — a manifest declaring connector_id/connector_key
    // is necessary but not sufficient for seedability. If seedableConnectors
    // fell back to manifest-presence alone (the over-claim this closes),
    // "delta" would appear here and later fail at runtime with zero records
    // emitted instead of being excluded up front.
    writeFileSync(join(scratchDir, "delta.json"), JSON.stringify({ connector_key: "delta" }));

    assert.deepEqual(seedableConnectors(scratchDir, ["acme", "bravo"]), ["acme", "bravo"]);
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("cli/commands/seed.ts: seedableConnectors against the real manifests/ and the real seed connector export reproduces the historical [github, reddit, spotify] set", () => {
  assert.deepEqual(seedableConnectors(join(riRoot, "manifests"), SUPPORTED_SEED_CONNECTOR_KEYS), [
    "github",
    "reddit",
    "spotify",
  ]);
});

test("classifyConnectorSetupModality never special-cases a specific connector id", () => {
  // A first-party-shaped id and a third-party id with byte-identical
  // manifests (same bindings, same setup block) must classify identically.
  // If this ever fails, some branch in classifyConnectorSetupModality started
  // keying off the id rather than the manifest shape.
  const bindings = { network: { required: true } };
  const firstPartyLike = classifyConnectorSetupModality(
    "gmail",
    customManifest("gmail", bindings, {
      setup: {
        credential_capture: {
          fields: [{ label: "x", name: "secret", required: true, secret: true, type: "password" }],
          kind: "app_password",
          label: "x",
        },
        modality: "static_secret",
      },
    })
  );
  const thirdPartyLike = classifyConnectorSetupModality(
    "totally-unrelated-vendor",
    customManifest("totally-unrelated-vendor", bindings, {
      setup: {
        credential_capture: {
          fields: [{ label: "x", name: "secret", required: true, secret: true, type: "password" }],
          kind: "app_password",
          label: "x",
        },
        modality: "static_secret",
      },
    })
  );
  assert.equal(firstPartyLike, thirdPartyLike);
});
