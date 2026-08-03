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
const REJECTED_NONEXISTENT_TAG_RE = /rejected nonexistent tag class/;
const MUTABLE_MAIN_LATEST_TAG_RE = /must not use mutable main\/latest image tags/;
const UNVERIFIED_ALTERNATE_TAG_RE = /an unverified alternate image tag/;
const UNKNOWN_REPOSITORY_RE = /unknown PDPP image repository/;
const RETIRED_OWNER_PATH_RE = /contains the retired owner path/;
const LEGACY_OWNER_PATH = ["/", "dashboard"].join("");
const MATRIX_IMAGE_RE = /^\s*- image:\s*(\S+)\s*$/;
const MATRIX_ENTRY_RE = /^\s*- image:/;
const MATRIX_PROPERTY_RE = /^\s{2,}\w/;
const MATRIX_TARGET_RE = /^\s*target:\s*(\S+)\s*$/;
const MATRIX_TITLE_RE = /^\s*title:\s*(.+?)\s*$/;

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
    { message: REJECTED_NONEXISTENT_TAG_RE }
  );
});

test("artifact oracle mutation-proof: mutable main tag in source text", () => {
  const composePlaceholder = ["image: $", "{PDPP_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference:main}"].join("");
  assert.throws(() => assertSourceArtifactsConsistent("synthetic regression input", composePlaceholder), {
    message: MUTABLE_MAIN_LATEST_TAG_RE,
  });
});

test("artifact oracle mutation-proof: mutable latest tag in source text", () => {
  assert.throws(
    () => assertSourceArtifactsConsistent("synthetic regression input", "ghcr.io/pdp-connect/pdpp/web:latest"),
    { message: MUTABLE_MAIN_LATEST_TAG_RE }
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
    { message: UNVERIFIED_ALTERNATE_TAG_RE }
  );
});

test("artifact oracle mutation-proof: unknown repository under the same org is rejected", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        "ghcr.io/pdp-connect/pdpp/railway-core:sha-cc07e3a"
      ),
    { message: UNKNOWN_REPOSITORY_RE }
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

// An image a self-host doc can recommend MUST be published by the normal
// release pipeline, or its only tags are the moving `main`/`sha-*` builds a
// manual docker-images dispatch produces — which is how the one-command
// `railway-core` path ended up advertised at `:main` with no released version
// to pin instead. This oracle makes that structural, not editorial: adding a
// self-hostable image without adding it to the release matrix fails here.
const SEMANTIC_RELEASE_WORKFLOW = new URL("../../../.github/workflows/semantic-release.yml", import.meta.url);
const SELF_HOSTABLE_IMAGES = ["reference", "reference-browser", "web", "railway-core", "core-browser"] as const;

const DOCKER_IMAGES_WORKFLOW = new URL("../../../.github/workflows/docker-images.yml", import.meta.url);

// Parse `- image: X` matrix entries with the keys that follow them, so the
// oracle checks what each entry actually BUILDS and LABELS rather than merely
// that a name appears. Counting names alone would pass while an entry built the
// wrong target or inherited another image's title — both real mistakes made
// while adding these images.
function matrixEntries(workflow: string): { image: string; target?: string; title?: string }[] {
  const entries: { image: string; target?: string; title?: string }[] = [];
  const lines = workflow.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = MATRIX_IMAGE_RE.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const entry: { image: string; target?: string; title?: string } = { image: match[1] };
    for (const next of lines.slice(index + 1)) {
      if (MATRIX_ENTRY_RE.test(next) || !MATRIX_PROPERTY_RE.test(next)) {
        break;
      }
      const target = MATRIX_TARGET_RE.exec(next);
      if (target?.[1]) {
        entry.target = target[1];
      }
      const title = MATRIX_TITLE_RE.exec(next);
      if (title?.[1]) {
        entry.title = title[1];
      }
    }
    entries.push(entry);
  }
  return entries;
}

test("every self-hostable image is published by the release pipeline", async () => {
  const workflow = await readFile(fileURLToPath(SEMANTIC_RELEASE_WORKFLOW), "utf8");
  const entries = matrixEntries(workflow);
  for (const image of SELF_HOSTABLE_IMAGES) {
    const forImage = entries.filter((entry) => entry.image === image);
    assert.equal(
      forImage.length,
      2,
      `${image} must appear in BOTH the validate-release-images and publish-images matrices (found ${forImage.length})`
    );
    // A matrix entry that builds someone else's target ships the wrong bits
    // under this tag — e.g. a browser-capable name built from the browser-free
    // stage. Name-presence alone cannot catch that. `web` is a deliberate
    // legacy alias for the `console` stage (see the Dockerfile comment).
    const expectedTarget = image === "web" ? "console" : image;
    for (const entry of forImage) {
      assert.equal(
        entry.target,
        expectedTarget,
        `${image} must build the \`${expectedTarget}\` Dockerfile target, not \`${entry.target}\``
      );
    }
  }
});

// Every published image needs its OWN title. A misplaced insertion can leave
// one image with no labels and give its text to the next, which is how
// `core-browser` briefly shipped labelled as the browser-free Railway node.
test("each published image entry carries its own distinct title", async () => {
  const workflowPaths = [
    ["semantic-release", SEMANTIC_RELEASE_WORKFLOW],
    ["docker-images", DOCKER_IMAGES_WORKFLOW],
  ] as const;
  const workflows = await Promise.all(
    workflowPaths.map(async ([label, url]) => [label, await readFile(fileURLToPath(url), "utf8")] as const)
  );
  for (const [label, workflow] of workflows) {
    const entries = matrixEntries(workflow).filter((entry) =>
      SELF_HOSTABLE_IMAGES.includes(entry.image as (typeof SELF_HOSTABLE_IMAGES)[number])
    );
    const seen = new Map<string, string>();
    for (const entry of entries) {
      assert.ok(entry.title, `${label}: ${entry.image} has no title label`);
      const owner = seen.get(entry.title as string);
      assert.ok(
        owner === undefined || owner === entry.image,
        `${label}: ${entry.image} reuses the title of ${owner}, so one image ships mislabelled`
      );
      seen.set(entry.title as string, entry.image);
    }
  }
});
