// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Every manual-upload connector's data streams must declare
// `coverage_strategy: "snapshot_import_receipt"`.
//
// A manual upload is a one-time snapshot of a file the owner exported: the
// artifact is parsed once, in full, and nothing will run again. That is what
// `snapshot_import_receipt` names. `checkpoint_window` names the opposite
// shape -- a rolling cursor over a source that keeps producing -- and a
// connector whose freshness strategy is `manual_as_of` has no such window by
// construction.
//
// The two strategies happen to carry the SAME proof obligation today
// (`strategyBoundsWindowRatherThanCounting` in the shared evidence contract
// treats both as window-bounding), so this mislabel changes no verdict right
// now. It is pinned anyway because the label is the manifest's honest
// self-description of what kind of source this is, and because the two
// strategies are free to diverge later -- at which point a stale
// `checkpoint_window` on a finished import would start asking the projection
// for a window that can never close.
//
// Scoped to the manual-upload roster by `setup.modality`, so a newly added
// manual connector is covered without editing this test.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MANIFESTS_DIR = new URL("../../manifests/", import.meta.url);

interface ManifestStream {
  readonly coverage_strategy?: string;
  readonly freshness_strategy?: string;
  readonly name: string;
}

interface Manifest {
  readonly connector_key?: string;
  readonly setup?: { readonly modality?: string };
  readonly streams?: readonly ManifestStream[];
}

function readManifest(fileName: string): Manifest {
  return JSON.parse(readFileSync(new URL(fileName, MANIFESTS_DIR), "utf8")) as Manifest;
}

/** Every connector whose setup modality is a manual file upload. */
function manualUploadManifests(): { manifest: Manifest; name: string }[] {
  return readdirSync(new URL(MANIFESTS_DIR))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ manifest: readManifest(file), name: file }))
    .filter(({ manifest }) => manifest.setup?.modality === "manual_or_upload");
}

test("every manual-upload connector is discoverable by setup modality", () => {
  // `connector_key` is optional on the manifest type, so a missing key would
  // otherwise sort as a silent `undefined` hole. Surface it as the literal
  // string instead: the deepEqual below then fails loudly on the real defect
  // rather than on an unexplained gap in the roster.
  const found = manualUploadManifests()
    .map(({ manifest }) => manifest.connector_key ?? "<missing connector_key>")
    .sort((a, b) => a.localeCompare(b));
  // Guards the filter itself: if `setup.modality` were renamed, the roster
  // would silently empty and every assertion below would vacuously pass.
  assert.deepEqual(found, ["google-maps", "netflix-export", "whatsapp"]);
});

test("manual-upload data streams declare snapshot_import_receipt coverage", () => {
  for (const { manifest, name } of manualUploadManifests()) {
    for (const stream of manifest.streams ?? []) {
      // `parent_detail_accounting` is a stricter per-item obligation (it owes
      // a numerator that actually satisfies its denominator), so a stream that
      // declares it is making a stronger claim, not evading this one.
      if (stream.coverage_strategy === "parent_detail_accounting") {
        continue;
      }
      assert.equal(
        stream.coverage_strategy,
        "snapshot_import_receipt",
        `${name}: stream '${stream.name}' is a finished one-time import, so it must declare ` +
          `snapshot_import_receipt (got '${String(stream.coverage_strategy)}')`
      );
    }
  }
});

test("no manual-upload stream claims a rolling checkpoint window", () => {
  for (const { manifest, name } of manualUploadManifests()) {
    for (const stream of manifest.streams ?? []) {
      assert.notEqual(
        stream.coverage_strategy,
        "checkpoint_window",
        `${name}: stream '${stream.name}' declares a rolling checkpoint window, but a manual ` +
          "upload has no window to roll -- nothing will run again after the import"
      );
    }
  }
});
