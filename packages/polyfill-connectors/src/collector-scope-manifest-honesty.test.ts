// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A local collector's `time_scopable_streams` is a claim about what an
// owner-declared `since` can be PROVEN against. The published collector runtime
// ships no manifests — it knows only the definitions injected into its registry
// — so that claim is mirrored in the definition rather than read at run time.
//
// A mirror can drift, and drift here is not cosmetic in either direction:
//
//   - Claiming a stream the manifest gives NO `consent_time_field` would put a
//     `time_range` on a START scope that the runtime's emission gate compares
//     against a field the record does not have. The bound would silently match
//     everything while the run reported itself as scoped — a fabricated
//     boundary, exactly what the scope contract exists to prevent.
//   - OMITTING a stream the manifest CAN scope quietly widens the run past what
//     the owner asked for, and reports the stream as out-of-scope-collected when
//     it could have been honestly bounded.
//
// So this file pins the mirror to the manifest in both directions, for every
// connector that declares a local-collector definition. It is deliberately
// generic: it discovers definitions rather than naming connectors, so a future
// local collector is covered the day it ships.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCAL_COLLECTOR_DEFINITIONS } from "./collector-registry.ts";

interface ManifestStream {
  consent_time_field?: string;
  name?: string;
}

interface ConnectorManifest {
  streams?: ManifestStream[];
}

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "..", "manifests");

function readManifest(connectorId: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${connectorId}.json`), "utf8")) as ConnectorManifest;
}

test("every local-collector definition mirrors its manifest's time-scopable streams exactly", () => {
  assert.ok(LOCAL_COLLECTOR_DEFINITIONS.length > 0, "no local collector definitions were discovered");

  for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
    const manifest = readManifest(definition.connector_id);
    const declared = [...(definition.time_scopable_streams ?? [])].sort();

    // The manifest authority: a stream is time-scopable exactly when it declares
    // the field a `since` would be compared against. Restricted to the streams
    // this collector actually requests — a bound on a stream the run never asks
    // for is not a boundary anyone can observe.
    const requested = new Set(definition.streams);
    const scopableByManifest = (manifest.streams ?? [])
      .filter((stream) => typeof stream.name === "string" && requested.has(stream.name))
      .filter((stream) => typeof stream.consent_time_field === "string" && stream.consent_time_field.trim())
      .map((stream) => stream.name as string)
      .sort();

    assert.deepEqual(
      declared,
      scopableByManifest,
      `${definition.connector_id}: time_scopable_streams must equal the requested streams whose manifest declares a consent_time_field`
    );
  }
});

/**
 * The connectors whose own enumeration walk consults the declared roots before
 * opening anything. Kept as an explicit list so adding the flag to a connector
 * without implementing pruning fails here rather than shipping a false claim.
 */
const ROOT_ENFORCING_CONNECTORS = new Set(["claude_code", "codex"]);

test("enforces_source_roots is declared by exactly the connectors that implement root pruning", () => {
  for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
    assert.equal(
      definition.enforces_source_roots === true,
      ROOT_ENFORCING_CONNECTORS.has(definition.connector_id),
      `${definition.connector_id}: enforces_source_roots must reflect implemented behaviour, not intent — ` +
        "claiming it without a root-pruning walk would report corpus-wide coverage as bounded"
    );
  }
});

test("a root-enforcing connector's source actually consults the shared containment helper", () => {
  // Pins the flag to the implementation rather than to a comment: a connector
  // that drops the pruning call must fail this, not silently keep the claim.
  for (const connectorId of ROOT_ENFORCING_CONNECTORS) {
    const source = readFileSync(join(PACKAGE_ROOT, "..", "connectors", connectorId, "index.ts"), "utf8");
    assert.match(
      source,
      /shouldDescendIntoDirectory|isPathWithinSourceRoots|projectDirMatchesSourceRoots/,
      `${connectorId} declares enforces_source_roots but never calls a shared path-containment helper`
    );
  }
});

test("no definition claims a time-scopable stream it does not collect", () => {
  for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
    const requested = new Set(definition.streams);
    for (const stream of definition.time_scopable_streams ?? []) {
      assert.ok(
        requested.has(stream),
        `${definition.connector_id}: "${stream}" is declared time-scopable but is not in the collector's stream set`
      );
    }
  }
});
