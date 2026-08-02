// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_PATHS = [
  ["public reference page", new URL("../src/app/reference/page.tsx", import.meta.url)],
  ["blessed self-service runbook", new URL("../../../docs/operator/self-service-gmail-mcp.md", import.meta.url)],
  ["self-host quickstart", new URL("../../../docs/operator/selfhost-quickstart.md", import.meta.url)],
  ["Docker deployment runbook", new URL("../../../deploy/docker/README.md", import.meta.url)],
  ["Railway deployment runbook", new URL("../../../deploy/railway/README.md", import.meta.url)],
  ["Railway template handoff", new URL("../../../deploy/railway/template.md", import.meta.url)],
  ["Fly deployment runbook", new URL("../../../deploy/flyio/README.md", import.meta.url)],
  ["deployment copy proposal", new URL("../../../deploy/docker/site-copy-proposal.md", import.meta.url)],
] as const;

const VERIFIED_TAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  reference: new Set(["1.0.4", "sha-cc07e3a"]),
  web: new Set(["1.0.4", "sha-cc07e3a"]),
  "railway-core": new Set(["sha-2fbdb4"]),
};

const IMAGE_REFERENCE_RE = /ghcr\.io\/pdp-connect\/pdpp\/([a-z-]+):([A-Za-z0-9._-]+)/g;
const MUTABLE_IMAGE_TAG_RE = /ghcr\.io\/pdp-connect\/pdpp\/[a-z-]+:(?:main|latest)\b/;
const NONEXISTENT_TAG = "sha-6581820";
const PAGE_PINNED_TAG_RE = /const PINNED_IMAGE_TAG = "sha-cc07e3a";/;
const RAILWAY_CORE_TAG_RE = /const RAILWAY_CORE_IMAGE_TAG = "sha-2fbdb4";/;
const ORACLE_REJECTION_RE = /not a registry-proven artifact/;

function assertRegistryProven(repository: string, tag: string, sourceName: string) {
  const allowedTags = VERIFIED_TAGS[repository];
  assert.ok(allowedTags, `${sourceName} uses an unknown PDPP image repository: ${repository}`);
  assert.ok(
    allowedTags.has(tag),
    `${sourceName} uses ${repository}:${tag}, which is not a registry-proven artifact for this path`
  );
}

function assertSourceArtifactsConsistent(sourceName: string, source: string) {
  assert.equal(source.includes(NONEXISTENT_TAG), false, `${sourceName} contains the rejected nonexistent tag class`);
  assert.doesNotMatch(source, MUTABLE_IMAGE_TAG_RE, `${sourceName} must not use mutable main/latest image tags`);

  for (const match of source.matchAll(IMAGE_REFERENCE_RE)) {
    const [, repository, tag] = match;
    assert.ok(repository);
    assert.ok(tag);
    assertRegistryProven(repository, tag, sourceName);
  }

  const referenceTags = [...source.matchAll(/ghcr\.io\/pdp-connect\/pdpp\/reference:([A-Za-z0-9._-]+)/g)].map(
    ([, tag]) => tag
  );
  const webTags = [...source.matchAll(/ghcr\.io\/pdp-connect\/pdpp\/web:([A-Za-z0-9._-]+)/g)].map(([, tag]) => tag);
  if (referenceTags.length > 0 || webTags.length > 0) {
    assert.deepEqual(referenceTags, webTags, `${sourceName} must pin reference and web to the same release`);
    assert.equal(referenceTags[0], "sha-cc07e3a", `${sourceName} must use the verified Compose release`);
  }
}

test("blessed deployment sources use only registry-proven artifact identities", async () => {
  const sources = await Promise.all(
    SOURCE_PATHS.map(async ([sourceName, path]) => [sourceName, await readFile(fileURLToPath(path), "utf8")] as const)
  );

  for (const [sourceName, source] of sources) {
    assertSourceArtifactsConsistent(sourceName, source);
  }

  const pageSource = sources.find(([sourceName]) => sourceName === "public reference page");
  assert.ok(pageSource);
  const [, page] = pageSource;
  assert.match(page, PAGE_PINNED_TAG_RE);
  assert.match(page, RAILWAY_CORE_TAG_RE);
});

test("artifact oracle rejects the previously advertised nonexistent tag class", () => {
  assert.throws(() => assertRegistryProven("reference", NONEXISTENT_TAG, "synthetic regression input"), {
    message: ORACLE_REJECTION_RE,
  });
});
