#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Generates a version-coherent self-host Compose bundle for one release.
//
// The problem this closes: deploy/docker/docker-compose.yml's `image:`
// defaults, and every doc that quotes them (docs/operator/selfhost-quickstart.md,
// deploy/docker/README.md, docs/operator/self-service-gmail-mcp.md), hardcode
// a single commit-SHA tag (`sha-cc07e3a`) that only ever covered
// reference/web — never neko/core-browser/railway-core — and had to be
// hand-edited in every doc on every release, or silently go stale. A clean
// user following that pin got an old reference/web pair AND a browser
// profile the compose file could not even resolve (neko had no coherent
// default at all).
//
// The fix is not a new hand-maintained template: it is a generator that
// takes the checked-in deploy/docker/docker-compose.yml — whatever its
// current shape, including services this script has never heard of — and
// mechanically repoints only its PDPP-built `image:` defaults at ONE
// release's resolved digests. Every other line (services, healthchecks, env
// vars, comments, unrelated profiles like `cloudflared`) passes through
// byte-identical. There is exactly one source of truth for the Compose
// shape; this script never re-describes it.
//
// The generated bundle is uploaded as a GitHub Release asset (not committed
// to the repository — see semantic-release.yml's publish-selfhost-bundle
// job), so `.../releases/latest/download/docker-compose.yml` is a single,
// permanently stable URL that always resolves to the CURRENT release's
// exact pinned bundle. No doc ever needs to quote a tag or commit SHA again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_PATH = "deploy/docker/docker-compose.yml";

// Maps each PDPP-built image this bundle pins to the compose `image:` line's
// env-var default it must rewrite. Postgres is deliberately excluded — it is
// a third-party image (`pgvector/pgvector`), not a PDPP release artifact, and
// its `image:` line must pass through untouched.
export const BUNDLE_IMAGES = [
  { envVar: "PDPP_REFERENCE_IMAGE", matrixImage: "reference" },
  { envVar: "PDPP_WEB_IMAGE", matrixImage: "web" },
  { envVar: "PDPP_NEKO_IMAGE", matrixImage: "neko" },
] as const;

export interface ResolvedImage {
  digest: string;
  image: string;
}

function digestReference(image: string, digest: string): string {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/, `${image} digest must be a full sha256 digest`);
  return `ghcr.io/pdp-connect/pdpp/${image}@${digest}`;
}

// Rewrites exactly the N `image: ${ENV_VAR:-...}` default lines this bundle
// owns, and asserts each appears EXACTLY once before rewriting — a template
// edit that renames, removes, or duplicates one of these lines must fail the
// generator loudly rather than silently miss a pin (String.replace only
// touches the first match) or double-pin an ambiguous template.
export function renderBundle(template: string, resolved: ResolvedImage[]): string {
  let output = template;
  const resolvedByImage = new Map(resolved.map((entry) => [entry.image, entry]));
  for (const { envVar, matrixImage } of BUNDLE_IMAGES) {
    const entry = resolvedByImage.get(matrixImage);
    assert.ok(entry, `no resolved digest supplied for ${matrixImage} (${envVar})`);
    const linePattern = new RegExp(`image: \\$\\{${envVar}:-[^}]*\\}`, "g");
    const occurrences = output.match(linePattern) ?? [];
    assert.equal(
      occurrences.length,
      1,
      `template must have exactly one ${envVar} image default line, found ${occurrences.length}`
    );
    const pinned = digestReference(entry.image, entry.digest);
    // The generated bundle still honors an operator override via the same
    // env var — pinning the DEFAULT to this release's digest, not replacing
    // the variable, so `PDPP_REFERENCE_IMAGE=...` in .env still works exactly
    // as it does in the template today.
    output = output.replace(linePattern, `image: \${${envVar}:-${pinned}}`);
  }
  return output;
}

export interface BundleGenerationResult {
  compose: string;
  release: {
    images: ResolvedImage[];
    version: string;
  };
}

export function generateBundle(template: string, version: string, resolved: ResolvedImage[]): BundleGenerationResult {
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `invalid release version: ${version}`);
  const compose = renderBundle(template, resolved);
  // The rewritten template must still be identical to the source line-for-line
  // outside the exact-one-occurrence image lines renderBundle already
  // validated above — this is the structural guarantee that makes "single
  // source of truth, no drift" true rather than aspirational.
  const changedLines = diffLineCount(template, compose);
  assert.equal(
    changedLines,
    resolved.length,
    `generated bundle changed ${changedLines} line(s); expected exactly ${resolved.length} (one per pinned image)`
  );
  return { compose, release: { version, images: resolved } };
}

// Counts lines that differ between template and generated output.
function diffLineCount(before: string, after: string): number {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(beforeLines.length, afterLines.length, "generated bundle changed the template's line count");
  let changed = 0;
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      changed += 1;
    }
  }
  return changed;
}

function parseArgs(argv: string[]): { image: string[]; outFile: string | undefined; version: string | undefined } {
  const image: string[] = [];
  let version: string | undefined;
  let outFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = argv[index + 1];
      index += 1;
    } else if (arg === "--image") {
      const value = argv[index + 1];
      assert.ok(value, "--image requires a value in the form name=digest");
      image.push(value);
      index += 1;
    } else if (arg === "--out") {
      outFile = argv[index + 1];
      index += 1;
    }
  }
  return { image, outFile, version };
}

function parseImageArg(value: string): ResolvedImage {
  const separatorIndex = value.indexOf("=");
  assert.ok(separatorIndex > 0, `--image must be name=digest, got: ${value}`);
  return { image: value.slice(0, separatorIndex), digest: value.slice(separatorIndex + 1) };
}

async function main(): Promise<void> {
  const { version, image, outFile } = parseArgs(process.argv.slice(2));
  assert.ok(version, "usage: generate-selfhost-bundle.ts --version <x.y.z> --image reference=sha256:... --image web=sha256:... --image neko=sha256:... [--out <file>]");
  const resolved = image.map(parseImageArg);
  const template = readFileSync(join(REPO_ROOT, TEMPLATE_PATH), "utf8");
  const result = generateBundle(template, version, resolved);
  if (outFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outFile, result.compose);
    console.log(`generate-selfhost-bundle: wrote ${outFile} pinned to release ${version}`);
  } else {
    process.stdout.write(result.compose);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
