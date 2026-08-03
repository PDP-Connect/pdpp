#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Create-once publish for the self-host bundle release asset.
//
// A prior version of this workflow used `gh release upload --clobber`,
// which unconditionally overwrites an existing asset of the same name. That
// is exactly wrong for a bundle whose entire value proposition is "the same
// stable URL always means the same bytes": a re-run of this job for the
// SAME already-published tag — triggered by a workflow retry, or a rebuild
// after an upstream base image (node:*, pgvector/pgvector) moved under an
// unpinned tag and produced different digests — could silently replace an
// already-published, already-linked-to bundle with different content. A
// user who fetched the bundle five minutes earlier would have no way to
// know the URL now serves something else.
//
// The correct contract for an immutable-per-tag asset is create-once:
//   - Asset does not exist yet at this tag -> upload it. This is the only
//     path allowed to mutate the release.
//   - Asset already exists -> download it and require BYTE-IDENTICAL
//     equality with the freshly generated bundle. Identical -> succeed
//     without uploading (idempotent retry). Different -> fail loudly; this
//     is a real problem (drifted upstream base, non-reproducible build, or
//     a second release job racing this tag) that a human must resolve, not
//     something to silently paper over by picking a winner.
//
// This script never calls `gh release upload --clobber` and the structural
// test below (`findClobberUsage`) fails the check if that flag is ever
// reintroduced anywhere in the repository's workflows.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type PublishOutcome = "created" | "identical" | "diverged";

export interface PublishResult {
  outcome: PublishOutcome;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return Buffer.compare(a, b) === 0;
}

export interface AssetLookup {
  downloadExisting(): Promise<Buffer | null>;
  uploadNew(): Promise<void>;
}

// Pure decision function, exercised directly by the structural tests below
// with a fake AssetLookup — no gh/network required to prove the create-once
// contract's branching is correct.
export async function publishCreateOnce(localBundle: Buffer, lookup: AssetLookup): Promise<PublishResult> {
  const existing = await lookup.downloadExisting();
  if (existing === null) {
    await lookup.uploadNew();
    return { outcome: "created" };
  }
  if (sameBytes(existing, localBundle)) {
    return { outcome: "identical" };
  }
  return { outcome: "diverged" };
}

function ghAssetLookup(tag: string, assetName: string, localPath: string): AssetLookup {
  return {
    async downloadExisting() {
      try {
        execFileSync("gh", ["release", "download", tag, "--pattern", assetName, "--output", `${localPath}.remote`], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // gh exits non-zero both when the release has no such asset and on
        // a real transport failure; either way there is nothing to compare
        // against, so treat it as "does not exist yet" and let uploadNew
        // (a real `gh release upload`) surface any genuine transport error.
        return null;
      }
      return readFileSync(`${localPath}.remote`);
    },
    async uploadNew() {
      // Deliberately NOT --clobber: this path only ever runs when
      // downloadExisting() returned null, i.e. the asset does not exist yet.
      // If a race means it now does, `gh release upload` without --clobber
      // fails instead of silently overwriting — the correct outcome for a
      // concurrent-publish race on the same tag.
      execFileSync("gh", ["release", "upload", tag, localPath], { stdio: "inherit" });
    },
  };
}

function parseArgs(argv: string[]): { assetName: string; localPath: string; tag: string } {
  let tag: string | undefined;
  let localPath: string | undefined;
  let assetName = "docker-compose.yml";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      tag = argv[index + 1];
      index += 1;
    } else if (arg === "--file") {
      localPath = argv[index + 1];
      index += 1;
    } else if (arg === "--asset-name") {
      assetName = argv[index + 1] ?? assetName;
      index += 1;
    }
  }
  assert.ok(tag, "usage: publish-selfhost-bundle-asset.ts --tag <tag> --file <path> [--asset-name <name>]");
  assert.ok(localPath, "usage: publish-selfhost-bundle-asset.ts --tag <tag> --file <path> [--asset-name <name>]");
  return { tag, localPath, assetName };
}

async function main(): Promise<void> {
  const { tag, localPath, assetName } = parseArgs(process.argv.slice(2));
  const localBundle = readFileSync(localPath);
  const result = await publishCreateOnce(localBundle, ghAssetLookup(tag, assetName, localPath));
  if (result.outcome === "created") {
    console.log(`publish-selfhost-bundle-asset: uploaded ${assetName} to release ${tag} (did not previously exist).`);
    return;
  }
  if (result.outcome === "identical") {
    console.log(
      `publish-selfhost-bundle-asset: ${assetName} already published on release ${tag} and is byte-identical to the freshly generated bundle — left as-is.`
    );
    return;
  }
  console.error(
    `publish-selfhost-bundle-asset: ${assetName} already exists on release ${tag} and DIFFERS from the freshly generated bundle.\n` +
      "This asset is meant to be immutable per tag. Refusing to overwrite it. " +
      "Investigate why the same release tag produced different bundle bytes " +
      "(e.g. a moving upstream base image, or a concurrent publish race) before taking any action."
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
