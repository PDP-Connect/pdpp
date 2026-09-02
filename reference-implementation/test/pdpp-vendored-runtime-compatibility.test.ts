// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Release-boundary tests for the two data-connect packages consumed by PDPP.
 *
 * The source repositories have independent release workflows.  These tests
 * keep the installed consumer contract honest: protocol 0.0.2 remains
 * parseable without being advertised by the withdrawn device runtime, while a
 * connector that declares STREAM_EVIDENCE is rejected before it can spawn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyPdppVendoredPackagePins } from "../../scripts/check-pdpp-vendored-package-pins.ts";

test("PDPP consumes both reviewed data-connect package-release 1.0.0 artifacts at exact hashes", () => {
  verifyPdppVendoredPackagePins(fileURLToPath(new URL("../../", import.meta.url)));
});

test("withdrawn device runtime rejects STREAM_EVIDENCE while protocol 0.0.2 still validates it", async () => {
  const runtime = await import("@pdpp/collector-runtime");
  const protocol = await import("@pdpp/connector-protocol");
  const emitter = {
    connector_id: "synthetic-future-stream-evidence",
    protocol_capabilities: [protocol.STREAM_EVIDENCE_CAPABILITY],
  };

  assert.equal(protocol.CONNECTOR_PROTOCOL_VERSION, "0.0.2");
  assert.doesNotThrow(() =>
    protocol.validateStreamEvidenceCounts({
      considered: 4,
      outcomes: { emitted: 1, gapped: 1, unaccounted: 1, unchanged: 1 },
    })
  );
  assert.equal(runtime.COLLECTOR_RUNTIME_CAPABILITIES.protocolVersion, "0.0.2");
  assert.equal(runtime.COLLECTOR_RUNTIME_CAPABILITIES.protocolCapabilities.has("STREAM_EVIDENCE"), false);
  assert.throws(
    () => runtime.assertPlacementOrThrow(emitter, runtime.COLLECTOR_RUNTIME_CAPABILITIES),
    (error: unknown) => {
      assert.equal(error instanceof runtime.RuntimeCapabilityMismatchError, true);
      assert.deepEqual((error as { missing: readonly string[] }).missing, ["STREAM_EVIDENCE"]);
      return true;
    }
  );
  assert.doesNotThrow(() =>
    runtime.assertPlacementOrThrow(
      { connector_id: "ordinary-non-emitter", protocol_capabilities: [] },
      runtime.COLLECTOR_RUNTIME_CAPABILITIES
    )
  );
});
