// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlacementOrThrow,
  COLLECTOR_RUNTIME_CAPABILITIES,
  diffRequiredBindings,
  evaluatePlacement,
  PROVIDER_RUNTIME_CAPABILITIES,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  RuntimeCapabilityMismatchError,
} from "./runtime-capabilities.ts";

const apiConnector = {
  connector_id: "github",
  runtime_requirements: { bindings: { network: { required: true } } },
};

const browserConnector = {
  connector_id: "usaa",
  runtime_requirements: {
    bindings: { network: { required: true }, browser: { required: true } },
  },
};

const codexConnector = {
  connector_id: "codex",
  runtime_requirements: { bindings: { filesystem: { required: true } } },
};

const localDeviceConnector = {
  connector_id: "imessage",
  runtime_requirements: {
    bindings: { filesystem: { required: true }, local_device: { required: true } },
  },
};

test("provider runtime advertises network and filesystem but not browser or local_device", () => {
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("network"), true);
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("filesystem"), true);
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("browser"), false);
  assert.equal(PROVIDER_RUNTIME_CAPABILITIES.bindings.has("local_device"), false);
});

test("collector runtime advertises every default binding", () => {
  for (const binding of ["network", "browser", "filesystem", "local_device"] as const) {
    assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.bindings.has(binding), true);
  }
});

test("evaluatePlacement: API connector is eligible for the provider runtime", () => {
  assert.deepEqual(evaluatePlacement(apiConnector, PROVIDER_RUNTIME_CAPABILITIES), {
    kind: "ok",
    satisfied: ["network"],
  });
});

test("evaluatePlacement: browser-required connector fails on provider with named missing binding", () => {
  const decision = evaluatePlacement(browserConnector, PROVIDER_RUNTIME_CAPABILITIES);
  assert.equal(decision.kind, "missing_capability");
  if (decision.kind === "missing_capability") {
    assert.deepEqual(decision.missing, ["browser"]);
    assert.equal(decision.runtime, "provider");
    assert.equal(decision.connectorId, "usaa");
  }
});

test("evaluatePlacement: local-device connector fails on provider, succeeds on collector", () => {
  const onProvider = evaluatePlacement(localDeviceConnector, PROVIDER_RUNTIME_CAPABILITIES);
  assert.equal(onProvider.kind, "missing_capability");
  if (onProvider.kind === "missing_capability") {
    assert.deepEqual(onProvider.missing, ["local_device"]);
  }

  const onCollector = evaluatePlacement(localDeviceConnector, COLLECTOR_RUNTIME_CAPABILITIES);
  assert.equal(onCollector.kind, "ok");
});

test("evaluatePlacement: filesystem-only connector is eligible on both runtimes", () => {
  assert.equal(evaluatePlacement(codexConnector, PROVIDER_RUNTIME_CAPABILITIES).kind, "ok");
  assert.equal(evaluatePlacement(codexConnector, COLLECTOR_RUNTIME_CAPABILITIES).kind, "ok");
});

test("diffRequiredBindings ignores non-required declarations", () => {
  const optional = {
    connector_id: "x",
    runtime_requirements: { bindings: { browser: { required: false } } },
  };
  assert.deepEqual(diffRequiredBindings(optional, PROVIDER_RUNTIME_CAPABILITIES), []);
});

test("assertPlacementOrThrow returns satisfied bindings on success", () => {
  const satisfied = assertPlacementOrThrow(apiConnector, PROVIDER_RUNTIME_CAPABILITIES);
  assert.deepEqual([...satisfied], ["network"]);
});

test("assertPlacementOrThrow throws RuntimeCapabilityMismatchError with stable code", () => {
  assert.throws(
    () => assertPlacementOrThrow(browserConnector, PROVIDER_RUNTIME_CAPABILITIES),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeCapabilityMismatchError);
      if (err instanceof RuntimeCapabilityMismatchError) {
        assert.equal(err.code, RUNTIME_CAPABILITY_MISMATCH_CODE);
        assert.deepEqual([...err.missing], ["browser"]);
        assert.equal(err.runtime, "provider");
        assert.equal(err.connectorId, "usaa");
        // Diagnostic must not leak credentials or owner data — the
        // message references the binding name and runtime id only.
        assert.match(err.message, /browser/);
        assert.match(err.message, /collector/i);
      }
      return true;
    }
  );
});

test("assertPlacementOrThrow does not name optional bindings as missing", () => {
  // A connector that declares browser as not-required should pass on a
  // runtime that lacks browser.
  const optional = {
    connector_id: "soft-browser",
    runtime_requirements: {
      bindings: { network: { required: true }, browser: { required: false } },
    },
  };
  const satisfied = assertPlacementOrThrow(optional, PROVIDER_RUNTIME_CAPABILITIES);
  assert.deepEqual([...satisfied], ["network"]);
});
