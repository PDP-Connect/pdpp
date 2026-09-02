// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CONNECTOR_PROTOCOL_CAPABILITIES, STREAM_EVIDENCE_CAPABILITY } from "@pdpp/connector-protocol";

import { LOCAL_COLLECTOR_DEFINITIONS } from "./collector-registry.ts";

/**
 * Capability-declaration compatibility for connector-protocol 0.0.2.
 *
 * 0.0.2 made `protocol_capabilities` a REQUIRED member of
 * `LocalCollectorDefinition`, and the upstream runtime deliberately gates an
 * omitted field as `"undeclared_capabilities"` rather than defaulting it to
 * `[]` — omission is a forged-legacy-bypass shape, not an empty declaration.
 * So "it compiles" is not the property worth pinning: what matters is that
 * every bundled definition declares exactly the capabilities its connector
 * ACTUALLY uses, and that the capability set never drifts from emission
 * behavior in either direction.
 *
 * These tests derive the expected value from each connector's own source
 * (does it emit STREAM_EVIDENCE?), never from its name, so adding a connector
 * that starts emitting STREAM_EVIDENCE without declaring the capability fails
 * here instead of failing closed at runtime on an owner's machine.
 */

const CONNECTORS_DIR = fileURLToPath(new URL("../connectors", import.meta.url));

/**
 * Every capability in the 0.0.2 vocabulary, paired with the emission the
 * connector must actually perform to need it. Today the vocabulary is exactly
 * one member; the map is keyed off `CONNECTOR_PROTOCOL_CAPABILITIES` so a
 * future capability cannot be added upstream and silently go unchecked here.
 *
 * The marker is the discriminant literal as it appears in a real emission
 * (`type: "STREAM_EVIDENCE"`), not the bare token: connectors legitimately
 * NAME a message type in prose (their collector-definition comments explain
 * why they need no capability), and a bare-token scan reports every one of
 * those as an emission.
 */
const CAPABILITY_EMISSION_MARKER = {
  [STREAM_EVIDENCE_CAPABILITY]: /type\s*:\s*"STREAM_EVIDENCE"/,
} as const satisfies Readonly<Record<string, RegExp>>;

/** Line and block comments, so a doc mention of a message type is never read as an emission. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function readConnectorSource(entry: string): Promise<string> {
  const dir = `${CONNECTORS_DIR}/${entry}`;
  const names = await readdir(dir, { recursive: true });
  const sources = names.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const bodies = await Promise.all(sources.map((name) => readFile(`${dir}/${name}`, "utf8")));
  return stripComments(bodies.join("\n"));
}

test("the capability vocabulary this test derives against matches the installed protocol package", () => {
  // Guards the derivation itself: if 0.0.3 adds a capability and no marker is
  // mapped for it, every "declares what it uses" assertion below would silently
  // stop covering that capability.
  assert.deepEqual(
    [...CONNECTOR_PROTOCOL_CAPABILITIES].sort(),
    Object.keys(CAPABILITY_EMISSION_MARKER).sort(),
    "every installed protocol capability needs an emission marker in CAPABILITY_EMISSION_MARKER"
  );
});

test("every bundled collector definition declares protocol_capabilities explicitly as an array", () => {
  assert.ok(LOCAL_COLLECTOR_DEFINITIONS.length > 0, "expected at least one definition");
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    // Key presence, not just a truthy read: the upstream runtime guard
    // distinguishes "declared []" from "omitted", and only the former is
    // allowed to run. `in` is what proves the field was actually written.
    assert.ok(
      "protocol_capabilities" in def,
      `${def.connector_id} must declare protocol_capabilities explicitly (omission is gated as undeclared_capabilities, never treated as [])`
    );
    assert.ok(
      Array.isArray(def.protocol_capabilities),
      `${def.connector_id} protocol_capabilities must be an array, got ${typeof def.protocol_capabilities}`
    );
    for (const capability of def.protocol_capabilities) {
      assert.ok(
        CONNECTOR_PROTOCOL_CAPABILITIES.includes(capability),
        `${def.connector_id} declares unknown capability ${String(capability)}`
      );
    }
  }
});

test("every bundled collector definition declares exactly the capabilities its connector source actually uses", async () => {
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const source = await readConnectorSource(def.entry);
    for (const [capability, marker] of Object.entries(CAPABILITY_EMISSION_MARKER)) {
      const uses = marker.test(source);
      const declares = (def.protocol_capabilities as readonly string[]).includes(capability);
      assert.equal(
        declares,
        uses,
        uses
          ? `${def.connector_id} emits ${capability} but does not declare it; the runtime will fail it closed`
          : `${def.connector_id} declares ${capability} but never emits it; drop the undeserved declaration`
      );
    }
  }
});

test("no bundled collector definition over-declares: today every bundled connector needs an empty capability set", async () => {
  // Pins the current, verified state rather than only the derivation rule, so
  // a change to BOTH a connector's emissions and its declaration still surfaces
  // in review instead of silently satisfying the symmetric check above.
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const source = await readConnectorSource(def.entry);
    assert.equal(
      CAPABILITY_EMISSION_MARKER[STREAM_EVIDENCE_CAPABILITY].test(source),
      false,
      `${def.connector_id} now emits STREAM_EVIDENCE; update this test and declare the capability`
    );
    assert.deepEqual(def.protocol_capabilities, [], `${def.connector_id} should declare no capabilities today`);
  }
});
