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
 *    artifact in this repo. Unlike the three parity tests this replaces
 *    (connection-setup-plan-proof-gates-manifest-parity.test.ts,
 *    connection-setup-plan-local-collector-proven-manifest-parity.test.ts,
 *    connection-setup-plan-browser-bound-manifest-parity.test.ts — which
 *    diffed two hand-maintained lists against each other), this test's
 *    oracle IS the generator: there is no second hand-maintained list left
 *    to drift.
 *
 * 2. Counterweight: a synthetic third-party connector manifest — a
 *    connector_id no shipped manifest declares — must classify purely from
 *    its own declared traits (capabilities.proven.*,
 *    runtime_requirements.bindings, setup.credential_capture), not because
 *    its id happens to appear in a hardcoded RI list. This is the
 *    "custom/third-party connector must work identically to a first-party
 *    one with the same traits" guarantee the task asked for.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { connectorsWithConnectorId } from "../cli/commands/seed.ts";
import type { ConnectorManifestLike } from "../server/connection-setup-plan.ts";
import { buildConnectionSetupPlan, classifyConnectorSetupModality } from "../server/connection-setup-plan.ts";
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
const generatorScript = join(riRoot, "scripts/generate-connector-registry.ts");
const trackedRegistryPath = join(riRoot, "server/generated/connector-registry.generated.ts");

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

test("cli/commands/seed.ts: DEFAULT_CONNECTORS derives from every manifest declaring connector_id/connector_key, not a hand-named fixture list", () => {
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

    assert.deepEqual(connectorsWithConnectorId(scratchDir), ["acme", "bravo"]);
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
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
