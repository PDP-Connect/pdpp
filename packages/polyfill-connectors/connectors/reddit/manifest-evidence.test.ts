// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest/report contract for Reddit's stream evidence.
 *
 * manifests/reddit.json declares `coverage_strategy: checkpoint_window` and
 * `freshness_strategy: manual_as_of` for every stream. Per the accepted-
 * strategy contract (openspec/changes/define-stream-coverage-freshness-
 * evidence/specs/polyfill-runtime/spec.md, "flat stream uses a non-detail
 * strategy"), a checkpoint_window stream with no detail lane proves coverage
 * through its committed STATE cursor alone — DETAIL_COVERAGE/considered is
 * for list+detail lanes, and Reddit has none, so declaring one here would be
 * inventing a denominator this connector cannot honestly measure.
 *
 * This pins two facts that integration.test.ts's collection-behavior
 * invariants don't: (1) the manifest's declared stream set matches what the
 * connector actually collects — a manifest/code stream-name drift would
 * silently orphan a stream's evidence contract — and (2) every declared
 * stream uses the strategy pair the connector's STATE-only emission is
 * actually able to satisfy, so a manifest edit can't silently promise a
 * stronger evidence strategy (e.g. `full_inventory`, `source_reported_as_of`)
 * the collector code was never built to back up.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStreamTable } from "./index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "..", "..", "manifests", "reddit.json");

interface ManifestStream {
  coverage_strategy?: unknown;
  freshness_strategy?: unknown;
  name?: unknown;
}

function readManifestStreams(): ManifestStream[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { streams?: ManifestStream[] };
  assert.ok(Array.isArray(manifest.streams) && manifest.streams.length > 0, "manifest declares streams");
  return manifest.streams;
}

test("manifests/reddit.json: declared stream names match buildStreamTable exactly", () => {
  const manifestNames = readManifestStreams()
    .map((s) => String(s.name))
    .sort((a, b) => a.localeCompare(b));
  const codeNames = buildStreamTable("/user/anon", "2026-04-24T12:00:00.000Z")
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(manifestNames, codeNames);
});

test("manifests/reddit.json: every stream declares the checkpoint_window/manual_as_of pair the connector's STATE-only emission satisfies", () => {
  for (const stream of readManifestStreams()) {
    assert.equal(
      stream.coverage_strategy,
      "checkpoint_window",
      `${String(stream.name)}: coverage_strategy must be checkpoint_window (the strategy STATE-only cursor commit proves)`
    );
    assert.equal(
      stream.freshness_strategy,
      "manual_as_of",
      `${String(stream.name)}: freshness_strategy must be manual_as_of (run-metadata-derived, no connector emission needed)`
    );
  }
});
