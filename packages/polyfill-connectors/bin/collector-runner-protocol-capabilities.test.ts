// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/collector-registry.ts";
import { buildConnectorSpec } from "./collector-runner.ts";

/**
 * Capability declaration at the CLI's connector-spec boundary.
 *
 * `buildConnectorSpec` produces the `CollectorConnectorSpec` the collector
 * runtime actually places, from two different sources: a bundled connector's
 * own `LocalCollectorDefinition` (via `LOCAL_COLLECTOR_DEFINITIONS`), and a
 * custom command — any `--connector` the CLI has no bundled definition for,
 * driven entirely by `--entrypoint-command` / `--args` / `--streams`.
 *
 * Those two sources have opposite obligations under connector-protocol 0.0.2.
 * A bundled definition is a first-party artifact and must declare its
 * capabilities explicitly. A custom command is an arbitrary operator-supplied
 * subprocess: the CLI knows nothing about what it emits, so it must NOT
 * synthesize a capability declaration on that subprocess's behalf. Fabricating
 * `[]` there would be exactly the silent-empty-declaration the upstream
 * capability guard exists to reject.
 */

const BASE_URL = "https://example.invalid";

function customCommandOptions(connector: string) {
  return {
    baseUrl: BASE_URL,
    command: "run" as const,
    connector,
    entrypointCommand: "node",
    args: ["./custom-collector.mjs"],
    streams: ["messages"],
    queuePath: "/tmp/pdpp-test-queue.json",
  };
}

test("a custom command spec declares no protocol capabilities on the subprocess's behalf", () => {
  // "custom-provider" is deliberately absent from LOCAL_COLLECTOR_DEFINITIONS:
  // this is the operator-supplied-subprocess path.
  assert.equal(
    LOCAL_COLLECTOR_DEFINITIONS.some((def) => def.connector_id === "custom-provider"),
    false,
    "fixture connector must not be a bundled definition, or this test proves nothing"
  );

  const spec = buildConnectorSpec(customCommandOptions("custom-provider"));

  assert.equal(spec.connector_id, "custom-provider");
  assert.equal(spec.command, "node");
  // The CLI must not invent a declaration for code it cannot inspect. Key
  // absence is the assertion: a synthesized `[]` would read as "this connector
  // declared it needs nothing", a claim the CLI has no standing to make.
  assert.equal(
    "protocol_capabilities" in spec,
    false,
    "buildConnectorSpec must not synthesize protocol_capabilities for a custom command"
  );
});

test("a custom command cannot inherit capabilities from a bundled connector that shares its streams", () => {
  // Guards against a future "look up defaults by stream shape" convenience
  // silently attaching a bundled connector's declaration to a custom command.
  const [bundled] = LOCAL_COLLECTOR_DEFINITIONS;
  assert.ok(bundled, "expected at least one bundled definition");

  const spec = buildConnectorSpec({
    ...customCommandOptions("custom-lookalike"),
    streams: [...bundled.streams],
  });

  assert.deepEqual([...spec.streams], [...bundled.streams], "fixture should mirror the bundled stream set");
  assert.equal(
    "protocol_capabilities" in spec,
    false,
    "matching a bundled connector's streams must not confer its capability declaration"
  );
});

test("every bundled connector resolves through buildConnectorSpec without losing its definition's capability declaration", () => {
  // The spec type does not carry protocol_capabilities today (the vendored
  // @pdpp/collector-runtime is still 0.0.1 and has no capability field on
  // ConnectorPlacementInput). This pins the seam: the definition remains the
  // sole declaration site, and the CLI neither drops it into the spec nor
  // invents a different value. When collector-runtime adopts 0.0.2, this test
  // is the one that must change, deliberately.
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const spec = buildConnectorSpec({
      baseUrl: BASE_URL,
      command: "run",
      connector: def.connector_id,
      queuePath: "/tmp/pdpp-test-queue.json",
    });
    assert.deepEqual([...spec.streams], [...def.streams], `${def.connector_id} streams must come from its definition`);
    assert.equal(
      "protocol_capabilities" in spec,
      false,
      `${def.connector_id}: spec should not carry protocol_capabilities while collector-runtime is 0.0.1`
    );
    assert.ok(
      Array.isArray(def.protocol_capabilities),
      `${def.connector_id}: the definition remains the declaration site`
    );
  }
});
