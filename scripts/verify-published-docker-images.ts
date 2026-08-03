#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Verifies that every image in the release-image matrix is actually pullable
// from GHCR at a given tag, using GHCR's anonymous token endpoint (no
// registry login required for public packages, matching what a clean
// self-hosting user does with `docker compose pull`).
//
// This is deliberately NOT wired into any CI workflow: CI runs on every push
// and PR, long before a tag is released, so a network check against
// not-yet-published images would fail permanently on unrelated changes.
// Run it by hand (or from a release runbook step) after `semantic-release`
// reports a published version, to prove the images that version's tag
// promised are actually there — see docs/operator/... for the runbook.
//
// Usage:
//   node --import tsx scripts/verify-published-docker-images.ts --tag 1.2.3
//   node --import tsx scripts/verify-published-docker-images.ts --tag latest --json

import assert from "node:assert/strict";
import process from "node:process";

import { loadMatrix, type MatrixRow } from "./check-docker-release-matrix.ts";

const REGISTRY = "ghcr.io";
const REPOSITORY_PREFIX = "pdp-connect/pdpp";
const OCI_ACCEPT_HEADERS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface ImageCheckResult {
  digest: string | null;
  image: string;
  ok: boolean;
  reason: string;
  reference: string;
}

async function fetchAnonymousToken(image: string): Promise<string | null> {
  const scope = `repository:${REPOSITORY_PREFIX}/${image}:pull`;
  const response = await fetch(`https://${REGISTRY}/token?scope=${encodeURIComponent(scope)}&service=${REGISTRY}`);
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { token?: string };
  return body.token ?? null;
}

export async function checkPublishedImage(image: string, tag: string): Promise<ImageCheckResult> {
  const reference = `${REGISTRY}/${REPOSITORY_PREFIX}/${image}:${tag}`;
  const token = await fetchAnonymousToken(image);
  if (!token) {
    return { digest: null, image, ok: false, reason: "package does not exist or denied anonymous pull", reference };
  }
  const response = await fetch(`https://${REGISTRY}/v2/${REPOSITORY_PREFIX}/${image}/manifests/${tag}`, {
    headers: { Accept: OCI_ACCEPT_HEADERS, Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    return { digest: null, image, ok: false, reason: `tag "${tag}" not found`, reference };
  }
  if (!response.ok) {
    return { digest: null, image, ok: false, reason: `manifest fetch failed with HTTP ${response.status}`, reference };
  }
  const digest = response.headers.get("docker-content-digest");
  return { digest, image, ok: true, reason: "published", reference };
}

export async function checkAllPublishedImages(rows: MatrixRow[], tag: string): Promise<ImageCheckResult[]> {
  const results: ImageCheckResult[] = [];
  for (const row of rows) {
    // Sequential, not Promise.all: GHCR's anonymous token endpoint is rate
    // limited per caller, and this script only ever runs by hand against a
    // handful of images, so throughput is not worth the added flakiness risk.
    results.push(await checkPublishedImage(row.image, tag));
  }
  return results;
}

function parseArgs(argv: string[]): { json: boolean; tag: string } {
  let tag = "latest";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      const value = argv[index + 1];
      assert.ok(value, "--tag requires a value");
      tag = value;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
    }
  }
  return { json, tag };
}

async function main(): Promise<void> {
  const { tag, json } = parseArgs(process.argv.slice(2));
  const rows = loadMatrix({ path: ".github/workflows/docker-images.yml", jobHeading: "publish:" });
  const results = await checkAllPublishedImages(rows, tag);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      const marker = result.ok ? "OK  " : "MISS";
      console.log(`${marker} ${result.reference} — ${result.reason}${result.digest ? ` (${result.digest})` : ""}`);
    }
  }
  const missing = results.filter((result) => !result.ok);
  if (missing.length > 0) {
    console.error(
      `\nverify-published-docker-images: ${missing.length}/${results.length} image(s) not published at tag "${tag}".`
    );
    process.exit(1);
  }
  console.log(`\nverify-published-docker-images: all ${results.length} image(s) published at tag "${tag}".`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
