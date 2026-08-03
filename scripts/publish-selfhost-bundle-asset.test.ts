#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards for the create-once release-asset publish contract.
//
// Covers publishCreateOnce's three branches with a fake AssetLookup (no
// gh/network required — this proves the DECISION logic, not gh's I/O), and
// a structural gate over the checked-in workflows/scripts that fails if
// `gh release upload ... --clobber` (or an equivalent mutable-overwrite
// invocation) is ever reintroduced anywhere in the repository.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { publishCreateOnce, type AssetLookup } from "./publish-selfhost-bundle-asset.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeLookup(existing: Buffer | null): { calls: string[]; lookup: AssetLookup } {
  const calls: string[] = [];
  const lookup: AssetLookup = {
    async downloadExisting() {
      calls.push("download");
      return existing;
    },
    async uploadNew() {
      calls.push("upload");
    },
  };
  return { calls, lookup };
}

test("publishCreateOnce uploads when no asset exists yet", async () => {
  const { calls, lookup } = fakeLookup(null);
  const result = await publishCreateOnce(Buffer.from("bundle-v1"), lookup);
  assert.equal(result.outcome, "created");
  assert.deepEqual(calls, ["download", "upload"]);
});

test("publishCreateOnce is idempotent: an identical re-run does not re-upload", async () => {
  const bundle = Buffer.from("bundle-v1");
  const { calls, lookup } = fakeLookup(Buffer.from("bundle-v1"));
  const result = await publishCreateOnce(bundle, lookup);
  assert.equal(result.outcome, "identical");
  // The discriminating assertion: downloadExisting was called, uploadNew
  // was NOT — this is what makes the contract create-ONCE rather than
  // create-or-replace. A regression back to unconditional upload/--clobber
  // would still report "identical" content-wise but would have called
  // upload, which this catches.
  assert.deepEqual(calls, ["download"]);
});

test("publishCreateOnce fails loudly (does not upload) when the existing asset differs", async () => {
  const bundle = Buffer.from("bundle-v2-different-digest");
  const { calls, lookup } = fakeLookup(Buffer.from("bundle-v1"));
  const result = await publishCreateOnce(bundle, lookup);
  assert.equal(result.outcome, "diverged");
  // Divergence must NEVER trigger an upload — that would be exactly the
  // silent-overwrite behavior --clobber gave us and this fix removes.
  assert.deepEqual(calls, ["download"]);
});

test("publishCreateOnce treats a single-byte difference as diverged, not identical", async () => {
  const { lookup } = fakeLookup(Buffer.from("bundle-v1"));
  const result = await publishCreateOnce(Buffer.from("bundle-v1 "), lookup);
  assert.equal(result.outcome, "diverged");
});

// Structural gate: scan every checked-in workflow and script for a
// `gh release upload` invocation carrying `--clobber`. This scans WHOLE
// FILE CONTENT (not line-by-line — a real `run: |` shell block spans
// `gh release upload <tag> \` and `--clobber` across separate lines joined
// by a backslash continuation, so a per-line pattern would miss exactly the
// shape this repository's own workflow used before this fix). It must catch
// --clobber showing up ANYWHERE (a new workflow, a rewritten script, a
// copy-pasted runbook snippet), not just in the one call site this fix
// touched.
const CLOBBER_PATTERN = /gh\s+release\s+upload\b[\s\S]{0,200}?--clobber/;

function scanForClobber(root: string): { file: string }[] {
  const findings: { file: string }[] = [];
  const targets = [join(root, ".github", "workflows"), join(root, "scripts")];
  for (const dir of targets) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      if (!/\.(ya?ml|ts|sh)$/.test(entry.name)) {
        continue;
      }
      const filePath = join(dir, entry.name);
      // This file itself documents the removal in prose comments — skip it
      // so the gate scans for a live invocation, not its own explanatory text.
      if (
        filePath.endsWith("publish-selfhost-bundle-asset.ts") ||
        filePath.endsWith("publish-selfhost-bundle-asset.test.ts")
      ) {
        continue;
      }
      const content = readFileSync(filePath, "utf8");
      if (CLOBBER_PATTERN.test(content)) {
        findings.push({ file: filePath });
      }
    }
  }
  return findings;
}

test("structural gate: no workflow or script uses gh release upload --clobber", () => {
  const findings = scanForClobber(REPO_ROOT);
  assert.deepEqual(
    findings,
    [],
    `found --clobber usage that would allow overwriting an immutable release asset: ${JSON.stringify(findings)}`
  );
});

test("structural gate mutation-proof: the scanner catches --clobber across a shell line-continuation, like the workflow this fix removed", () => {
  const syntheticMultiLine = [
    "        run: |",
    '          gh release upload "${{ needs.release.outputs.git-tag }}" \\',
    "            .release-bundle/docker-compose.yml \\",
    "            --clobber",
  ].join("\n");
  assert.equal(
    CLOBBER_PATTERN.test(syntheticMultiLine),
    true,
    "the clobber-detection pattern failed to match a multi-line gh release upload ... --clobber block"
  );
});

test("structural gate mutation-proof: the scanner does not false-positive on an unrelated gh release upload call", () => {
  const syntheticSafeCall = 'run: gh release upload "${{ tag }}" asset.txt';
  assert.equal(CLOBBER_PATTERN.test(syntheticSafeCall), false);
});
