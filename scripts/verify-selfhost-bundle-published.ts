#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Post-publish verification for the version-coherent self-host bundle.
//
// Proves the property the friend-readiness blocker requires: a clean user
// following ONE stable URL —
//   https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml
// — receives a Compose bundle whose PDPP-built `image:` defaults
// (reference/web/neko) are ALL pinned by immutable digest, and every one of
// those digests is (a) anonymously pullable from GHCR right now and (b)
// actually the digest published for that release's tag — not a stale asset
// left over from an earlier release.
//
// Run after a real release (`publish-selfhost-bundle` in semantic-release.yml
// already runs this as its own verification step against the release it just
// created). Also safe to run by hand at any time against `latest`.
//
// Usage:
//   node --import tsx scripts/verify-selfhost-bundle-published.ts --tag latest
//   node --import tsx scripts/verify-selfhost-bundle-published.ts --tag v1.4.0

import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BUNDLE_IMAGES } from "./generate-selfhost-bundle.ts";

const REPOSITORY = "PDP-Connect/pdpp";
const REGISTRY = "ghcr.io";
const REPOSITORY_PREFIX = "pdp-connect/pdpp";
const OCI_ACCEPT_HEADERS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const IMAGE_LINE_PATTERN = /image: \$\{(PDPP_[A-Z_]+_IMAGE):-ghcr\.io\/pdp-connect\/pdpp\/([a-z-]+)@(sha256:[a-f0-9]{64})\}/g;

export interface BundleImagePin {
  digest: string;
  envVar: string;
  image: string;
}

// Parses the pinned `image:` lines out of a generated bundle. A bundle line
// that is NOT digest-pinned (still `:tag`, or the unset placeholder) simply
// will not match — findMissingPins below is what turns that into a finding,
// so a regression to tag-pinning fails with a specific message instead of
// this parser silently returning fewer pins than expected.
export function parseBundlePins(compose: string): BundleImagePin[] {
  return [...compose.matchAll(IMAGE_LINE_PATTERN)].map((match) => ({
    envVar: match[1] as string,
    image: match[2] as string,
    digest: match[3] as string,
  }));
}

export interface PinFinding {
  detail: string;
}

// Every image this bundle is supposed to own (BUNDLE_IMAGES) must appear
// EXACTLY once as a digest pin. Fewer means a pin regressed to a moving tag
// (or was dropped); this is the oracle for "no main/moving-tag deployment".
export function findMissingPins(pins: BundleImagePin[]): PinFinding[] {
  const findings: PinFinding[] = [];
  const seen = new Map<string, number>();
  for (const pin of pins) {
    seen.set(pin.image, (seen.get(pin.image) ?? 0) + 1);
  }
  for (const { matrixImage, envVar } of BUNDLE_IMAGES) {
    const count = seen.get(matrixImage) ?? 0;
    if (count !== 1) {
      findings.push({
        detail: `${matrixImage} (${envVar}) must appear exactly once as a digest-pinned image default, found ${count}`,
      });
    }
  }
  return findings;
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

export interface DigestPullabilityResult {
  image: string;
  ok: boolean;
  reason: string;
}

async function checkDigestPullable(image: string, digest: string): Promise<DigestPullabilityResult> {
  const token = await fetchAnonymousToken(image);
  if (!token) {
    return { image, ok: false, reason: "package does not exist or denied anonymous pull" };
  }
  const response = await fetch(`https://${REGISTRY}/v2/${REPOSITORY_PREFIX}/${image}/manifests/${digest}`, {
    headers: { Accept: OCI_ACCEPT_HEADERS, Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    return { image, ok: false, reason: `pinned digest ${digest} is not anonymously pullable (404)` };
  }
  if (!response.ok) {
    return { image, ok: false, reason: `manifest fetch failed with HTTP ${response.status}` };
  }
  return { image, ok: true, reason: "digest is anonymously pullable" };
}

async function fetchReleaseAsset(tag: string, assetName: string): Promise<string> {
  const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/${assetName}`;
  const response = await fetch(url, { redirect: "follow" });
  assert.equal(response.status, 200, `release asset fetch failed: ${url} -> HTTP ${response.status}`);
  return response.text();
}

export interface VerificationReport {
  bundleUrl: string;
  digestFindings: DigestPullabilityResult[];
  missingPinFindings: PinFinding[];
  ok: boolean;
  pins: BundleImagePin[];
}

export async function verifyPublishedBundle(tag: string): Promise<VerificationReport> {
  const bundleUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/docker-compose.yml`;
  const compose = await fetchReleaseAsset(tag, "docker-compose.yml");
  const pins = parseBundlePins(compose);
  const missingPinFindings = findMissingPins(pins);
  const digestFindings: DigestPullabilityResult[] = [];
  for (const pin of pins) {
    // Sequential: matches verify-published-docker-images.ts's rationale —
    // this is a small, by-hand/CI-once probe, not a throughput-sensitive path.
    digestFindings.push(await checkDigestPullable(pin.image, pin.digest));
  }
  const ok = missingPinFindings.length === 0 && digestFindings.every((result) => result.ok);
  return { bundleUrl, pins, missingPinFindings, digestFindings, ok };
}

function parseArgs(argv: string[]): { tag: string } {
  let tag = "latest";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tag") {
      const value = argv[index + 1];
      assert.ok(value, "--tag requires a value");
      tag = value;
      index += 1;
    }
  }
  return { tag };
}

async function main(): Promise<void> {
  const { tag } = parseArgs(process.argv.slice(2));
  // GitHub's "latest" release download alias only exists as
  // /releases/latest/download/<asset> (redirects), not as a tag literally
  // named "latest" under /releases/download/. Resolve it first so the same
  // fetchReleaseAsset path works for both a real tag and the latest alias.
  const resolvedTag =
    tag === "latest"
      ? await (async () => {
          const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`);
          assert.equal(response.status, 200, "could not resolve the latest release");
          const body = (await response.json()) as { tag_name?: string };
          assert.ok(body.tag_name, "latest release response is missing tag_name");
          return body.tag_name;
        })()
      : tag;
  const report = await verifyPublishedBundle(resolvedTag);
  console.log(`Self-host bundle: ${report.bundleUrl}`);
  for (const pin of report.pins) {
    console.log(`  pinned: ${pin.envVar} -> ghcr.io/pdp-connect/pdpp/${pin.image}@${pin.digest}`);
  }
  for (const finding of report.missingPinFindings) {
    console.error(`  MISSING PIN: ${finding.detail}`);
  }
  for (const result of report.digestFindings) {
    console.log(`  ${result.ok ? "OK  " : "MISS"} ${result.image}: ${result.reason}`);
  }
  if (!report.ok) {
    console.error(`\nverify-selfhost-bundle-published: bundle at tag "${resolvedTag}" failed verification.`);
    process.exit(1);
  }
  console.log(`\nverify-selfhost-bundle-published: bundle at tag "${resolvedTag}" is version-coherent and pullable.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`verify-selfhost-bundle-published: ${message}`);
    process.exitCode = 1;
  });
}
