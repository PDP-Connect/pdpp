// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { STREAM_EVIDENCE_CAPABILITY } from "@pdpp/connector-protocol";

import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/collector-registry.ts";
import { buildConnectorSpec, parseArgs } from "./collector-runner.ts";

/**
 * Capability declaration at the CLI's connector-spec boundary.
 *
 * `buildConnectorSpec` produces the `CollectorConnectorSpec` the collector
 * runtime actually places, from two different sources: a bundled connector's
 * own `LocalCollectorDefinition` (via `LOCAL_COLLECTOR_DEFINITIONS`), and a
 * custom command — any `--connector` the CLI has no bundled definition for,
 * driven entirely by `--entrypoint-command` / `--args` / `--streams`.
 *
 * Those two sources have different obligations under connector-protocol 0.0.2.
 * A bundled definition is a first-party artifact and must carry its declared
 * capabilities into the placement. A custom command is an arbitrary
 * operator-supplied subprocess: the CLI knows nothing about what it emits, so
 * it must require an explicit operator declaration rather than fabricate `[]`.
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

test("a custom command without a capability declaration fails closed", () => {
  // "custom-provider" is deliberately absent from LOCAL_COLLECTOR_DEFINITIONS:
  // this is the operator-supplied-subprocess path.
  assert.equal(
    LOCAL_COLLECTOR_DEFINITIONS.some((def) => def.connector_id === "custom-provider"),
    false,
    "fixture connector must not be a bundled definition, or this test proves nothing"
  );

  assert.throws(
    () => buildConnectorSpec(customCommandOptions("custom-provider")),
    /run requires --protocol-capabilities .* for custom connector custom-provider/
  );
});

test("a custom command carries the operator's exact capability declaration", () => {
  const options = parseArgs([
    "run",
    "--connector",
    "custom-provider",
    "--streams",
    "messages",
    "--protocol-capabilities",
    "STREAM_EVIDENCE",
  ]);
  const spec = buildConnectorSpec(options);

  assert.equal(spec.connector_id, "custom-provider");
  assert.equal(spec.command, "tsx");
  assert.deepEqual(spec.protocol_capabilities, [STREAM_EVIDENCE_CAPABILITY]);
});

test("overriding a bundled connector command cannot inherit its capabilities", () => {
  assert.throws(
    () => buildConnectorSpec(customCommandOptions("gmail")),
    /run requires --protocol-capabilities .* for custom connector gmail/
  );

  const spec = buildConnectorSpec({
    ...customCommandOptions("gmail"),
    protocolCapabilities: [STREAM_EVIDENCE_CAPABILITY],
  });
  assert.deepEqual(spec.protocol_capabilities, [STREAM_EVIDENCE_CAPABILITY]);
});

test("a custom command cannot inherit capabilities from a bundled connector that shares its streams", () => {
  // Guards against a future "look up defaults by stream shape" convenience
  // silently attaching a bundled connector's declaration to a custom command.
  const [bundled] = LOCAL_COLLECTOR_DEFINITIONS;
  assert.ok(bundled, "expected at least one bundled definition");

  const spec = buildConnectorSpec({
    ...customCommandOptions("custom-lookalike"),
    protocolCapabilities: [STREAM_EVIDENCE_CAPABILITY],
    streams: [...bundled.streams],
  });

  assert.deepEqual([...spec.streams], [...bundled.streams], "fixture should mirror the bundled stream set");
  assert.deepEqual(spec.protocol_capabilities, [STREAM_EVIDENCE_CAPABILITY]);
});

test("every bundled connector resolves through buildConnectorSpec without losing its definition's capability declaration", () => {
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const spec = buildConnectorSpec({
      baseUrl: BASE_URL,
      command: "run",
      connector: def.connector_id,
      queuePath: "/tmp/pdpp-test-queue.json",
    });
    assert.deepEqual([...spec.streams], [...def.streams], `${def.connector_id} streams must come from its definition`);
    assert.deepEqual(
      [...spec.protocol_capabilities],
      [...def.protocol_capabilities],
      `${def.connector_id}: placement must carry the definition's exact capabilities`
    );
  }
});
