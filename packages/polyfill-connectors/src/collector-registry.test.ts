// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LOCAL_COLLECTOR_DEFINITIONS } from "./collector-registry.ts";

/**
 * Contract for the connector-owned local-collector definitions.
 *
 * The publishable `@pdpp/local-collector` runtime consumes these as its only
 * knowledge of which connectors run locally, so the invariants a bundled
 * connector must satisfy (non-empty manifest-declared streams, a required
 * filesystem binding, coverage_diagnostics in defaults) are asserted here at
 * the source of truth — not just downstream in the collector's registry.
 */

test("every local collector definition is well-formed and filesystem-class", () => {
  assert.ok(LOCAL_COLLECTOR_DEFINITIONS.length > 0, "expected at least one definition");
  const ids = new Set<string>();
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    assert.equal(typeof def.connector_id, "string");
    assert.ok(def.connector_id.length > 0, "connector_id must be non-empty");
    assert.equal(ids.has(def.connector_id), false, `duplicate connector_id ${def.connector_id}`);
    ids.add(def.connector_id);
    // `entry` is the connectors/ directory name, used to resolve the spawnable
    // module; keep it a bare segment (no path separators) so the runtime owns
    // path shape.
    assert.ok(def.entry.length > 0 && !def.entry.includes("/"), `entry must be a bare segment: ${def.entry}`);
    assert.equal(def.bindings.filesystem?.required, true, `${def.connector_id} must require the filesystem binding`);
    assert.ok(Array.isArray(def.streams) && def.streams.length > 0, `${def.connector_id} must declare streams`);
  }
});

test("bundled default streams request coverage_diagnostics whenever the connector's manifest declares that stream, so a drained run is never coverage_unknown", async () => {
  // Local-device collectors push records from a device outbox and write no
  // spine run, so the connection-health rollup can only project a non-`unknown`
  // coverage axis from durable `coverage_diagnostics` records where that is the
  // connector's coverage mechanism. Omitting that stream from the defaults
  // strands the dashboard at coverage_unknown even after a healthy drain. See
  // openspec/changes/derive-local-collector-coverage-from-diagnostics.
  //
  // Not every connector uses this mechanism: a connector may instead declare a
  // per-stream `coverage_strategy` (e.g. `snapshot_import_receipt`, as
  // iMessage does) in its manifest, in which case it has no
  // `coverage_diagnostics` stream to request at all — this check only applies
  // when the manifest declares one.
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const manifestPath = fileURLToPath(new URL(`../manifests/${def.connector_id}.json`, import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const declaresCoverageDiagnostics = manifest.streams.some(
      (stream: { name: string }) => stream.name === "coverage_diagnostics"
    );
    if (!declaresCoverageDiagnostics) {
      continue;
    }
    assert.ok(
      def.streams.includes("coverage_diagnostics"),
      `${def.connector_id} default streams must include coverage_diagnostics; got ${def.streams.join(", ")}`
    );
  }
});

test("every default stream is declared in the connector's manifest (no undeclared stream requested)", async () => {
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const manifestPath = fileURLToPath(new URL(`../manifests/${def.connector_id}.json`, import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const declared = new Set(manifest.streams.map((stream: { name: string }) => stream.name));
    for (const stream of def.streams) {
      assert.ok(declared.has(stream), `${def.connector_id} default stream '${stream}' is not declared in the manifest`);
    }
  }
});
