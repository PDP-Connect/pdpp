// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BLESSED_ARTIFACT_PATHS = [
  ["public reference page", new URL("../src/app/reference/page.tsx", import.meta.url)],
  ["blessed self-service runbook", new URL("../../../docs/operator/self-service-gmail-mcp.md", import.meta.url)],
  ["self-host quickstart", new URL("../../../docs/operator/selfhost-quickstart.md", import.meta.url)],
  ["Docker deployment runbook", new URL("../../../deploy/docker/README.md", import.meta.url)],
  ["deployment copy proposal", new URL("../../../deploy/docker/site-copy-proposal.md", import.meta.url)],
  ["blessed Compose stack", new URL("../../../deploy/docker/docker-compose.yml", import.meta.url)],
] as const;

const TOUCHED_SURFACE_PATHS = [
  ["public reference page", new URL("../src/app/reference/page.tsx", import.meta.url)],
  ["artifact consistency oracle", new URL("./reference-artifact-consistency.test.ts", import.meta.url)],
  ["no-hardcoded-host oracle", new URL("./reference-page-no-hardcoded-host.test.ts", import.meta.url)],
  ["self-service journey oracle", new URL("./reference-page-self-service.test.ts", import.meta.url)],
  ["Docker deployment runbook", new URL("../../../deploy/docker/README.md", import.meta.url)],
  ["deployment copy proposal", new URL("../../../deploy/docker/site-copy-proposal.md", import.meta.url)],
  ["Fly deployment runbook", new URL("../../../deploy/flyio/README.md", import.meta.url)],
  ["Railway deployment runbook", new URL("../../../deploy/railway/README.md", import.meta.url)],
  ["Railway template handoff", new URL("../../../deploy/railway/template.md", import.meta.url)],
  ["connection setup guide", new URL("../../../docs/operator/add-connection.md", import.meta.url)],
  ["hosted MCP runbook", new URL("../../../docs/operator/hosted-mcp-setup.md", import.meta.url)],
  ["blessed self-service runbook", new URL("../../../docs/operator/self-service-gmail-mcp.md", import.meta.url)],
  ["self-host quickstart", new URL("../../../docs/operator/selfhost-quickstart.md", import.meta.url)],
  ["local browser E2E guide", new URL("../../../docs/reference/local-testing-e2e.md", import.meta.url)],
] as const;

const VERIFIED_TAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  reference: new Set(["sha-cc07e3a"]),
  web: new Set(["sha-cc07e3a"]),
};

const IMAGE_REFERENCE_RE = /ghcr\.io\/pdp-connect\/pdpp\/([a-z-]+):([A-Za-z0-9._-]+)/g;
const MUTABLE_IMAGE_TAG_RE = /ghcr\.io\/pdp-connect\/pdpp\/[a-z-]+:(?:main|latest)\b/;
const NONEXISTENT_TAG = "sha-6581820";
const UNVERIFIED_ALTERNATE_TAG = ["sha", "2fbdb4"].join("-");
const PAGE_PINNED_TAG_RE = /const PINNED_IMAGE_TAG = "sha-cc07e3a";/;
const PAGE_REFERENCE_IMAGE_RE = /ghcr\.io\/pdp-connect\/pdpp\/reference:\$\{PINNED_IMAGE_TAG\}/;
const PAGE_WEB_IMAGE_RE = /ghcr\.io\/pdp-connect\/pdpp\/web:\$\{PINNED_IMAGE_TAG\}/;
const ORACLE_REJECTION_RE = /not a registry-proven artifact/;
const RETIRED_OWNER_PATH_RE = /contains the retired owner path/;
const LEGACY_OWNER_PATH = ["/", "dashboard"].join("");

function readSources(paths: readonly (readonly [string, URL])[]) {
  return Promise.all(
    paths.map(async ([sourceName, path]) => [sourceName, await readFile(fileURLToPath(path), "utf8")] as const)
  );
}

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
  assert.equal(
    source.includes(UNVERIFIED_ALTERNATE_TAG),
    false,
    `${sourceName} contains an unverified alternate image tag`
  );
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

function assertNoLegacyOwnerPath(sourceName: string, source: string) {
  assert.equal(source.includes(LEGACY_OWNER_PATH), false, `${sourceName} contains the retired owner path`);
}

test("blessed deployment sources use only registry-proven reference and web artifacts", async () => {
  const sources = await readSources(BLESSED_ARTIFACT_PATHS);

  for (const [sourceName, source] of sources) {
    assertSourceArtifactsConsistent(sourceName, source);
  }

  const pageSource = sources.find(([sourceName]) => sourceName === "public reference page");
  assert.ok(pageSource);
  const [, page] = pageSource;
  assert.match(page, PAGE_PINNED_TAG_RE);
  assert.match(page, PAGE_REFERENCE_IMAGE_RE);
  assert.match(page, PAGE_WEB_IMAGE_RE);
});

test("artifact oracle rejects the previously advertised nonexistent tag class", () => {
  assert.throws(() => assertRegistryProven("reference", NONEXISTENT_TAG, "synthetic regression input"), {
    message: ORACLE_REJECTION_RE,
  });
});

test("artifact oracle mutation-proof: nonexistent tag in source text", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        `image: ghcr.io/pdp-connect/pdpp/reference:${NONEXISTENT_TAG}`
      ),
    { message: /rejected nonexistent tag class/ }
  );
});

test("artifact oracle mutation-proof: mutable main tag in source text", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        "image: ${PDPP_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference:main}"
      ),
    { message: /must not use mutable main\/latest image tags/ }
  );
});

test("artifact oracle mutation-proof: mutable latest tag in source text", () => {
  assert.throws(
    () => assertSourceArtifactsConsistent("synthetic regression input", "ghcr.io/pdp-connect/pdpp/web:latest"),
    { message: /must not use mutable main\/latest image tags/ }
  );
});

test("artifact oracle mutation-proof: cross-lineage tag mismatch between reference and web", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        [
          "ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a",
          `ghcr.io/pdp-connect/pdpp/web:${UNVERIFIED_ALTERNATE_TAG}`,
        ].join("\n")
      ),
    { message: /an unverified alternate image tag/ }
  );
});

test("artifact oracle mutation-proof: unknown repository under the same org is rejected", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        "ghcr.io/pdp-connect/pdpp/railway-core:sha-cc07e3a"
      ),
    { message: /unknown PDPP image repository/ }
  );
});

test("legacy owner path oracle rejects synthetic input", () => {
  assert.throws(() => assertNoLegacyOwnerPath("synthetic regression input", `origin${LEGACY_OWNER_PATH}`), {
    message: RETIRED_OWNER_PATH_RE,
  });
});

test("touched landing/docs/page/test surface has no legacy owner path", async () => {
  const sources = await readSources(TOUCHED_SURFACE_PATHS);

  for (const [sourceName, source] of sources) {
    assertNoLegacyOwnerPath(sourceName, source);
  }
});
