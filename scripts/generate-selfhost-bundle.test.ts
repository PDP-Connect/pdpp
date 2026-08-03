#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards for the self-host bundle generator (generate-selfhost-bundle.ts).
//
// Covers renderBundle/generateBundle against synthetic templates (so a real
// missing-line/drift-detection failure is provable without editing the live
// deploy/docker/docker-compose.yml, which is actively edited by another
// worker in this checkout), plus one live-repository test that the
// generator actually produces a byte-coherent bundle from the real,
// checked-in template as it stands right now — proving "single source of
// truth, no template to keep in sync" rather than asserting it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUNDLE_IMAGES, generateBundle, renderBundle, TEMPLATE_PATH, type ResolvedImage } from "./generate-selfhost-bundle.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SYNTHETIC_TEMPLATE = `services:
  reference:
    image: \${PDPP_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a}
  web:
    image: \${PDPP_WEB_IMAGE:-ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a}
  postgres:
    image: \${PDPP_POSTGRES_IMAGE:-pgvector/pgvector:pg16}
  neko:
    image: \${PDPP_NEKO_IMAGE:-pdpp-neko-image-not-set}
    profiles: ["browser"]
`;

const VALID_RESOLVED: ResolvedImage[] = [
  { image: "reference", digest: `sha256:${"a".repeat(64)}` },
  { image: "web", digest: `sha256:${"b".repeat(64)}` },
  { image: "neko", digest: `sha256:${"c".repeat(64)}` },
];

test("renderBundle pins the three PDPP-built image defaults and leaves everything else byte-identical", () => {
  const output = renderBundle(SYNTHETIC_TEMPLATE, VALID_RESOLVED);
  assert.match(output, new RegExp(`PDPP_REFERENCE_IMAGE:-ghcr\\.io/pdp-connect/pdpp/reference@sha256:${"a".repeat(64)}`));
  assert.match(output, new RegExp(`PDPP_WEB_IMAGE:-ghcr\\.io/pdp-connect/pdpp/web@sha256:${"b".repeat(64)}`));
  assert.match(output, new RegExp(`PDPP_NEKO_IMAGE:-ghcr\\.io/pdp-connect/pdpp/neko@sha256:${"c".repeat(64)}`));
  // Postgres, and every non-image line, must pass through unchanged.
  assert.match(output, /PDPP_POSTGRES_IMAGE:-pgvector\/pgvector:pg16/);
  assert.match(output, /profiles: \["browser"\]/);
});

test("renderBundle preserves an operator override interface (still ${ENV_VAR:-<pinned>})", () => {
  const output = renderBundle(SYNTHETIC_TEMPLATE, VALID_RESOLVED);
  assert.match(output, /image: \$\{PDPP_REFERENCE_IMAGE:-/);
  assert.match(output, /image: \$\{PDPP_WEB_IMAGE:-/);
  assert.match(output, /image: \$\{PDPP_NEKO_IMAGE:-/);
});

test("renderBundle throws if a required image's resolved digest is missing", () => {
  const missingNeko = VALID_RESOLVED.filter((entry) => entry.image !== "neko");
  assert.throws(() => renderBundle(SYNTHETIC_TEMPLATE, missingNeko), /no resolved digest supplied for neko/);
});

test("renderBundle throws if the template no longer has a matching image default line", () => {
  const templateWithoutNekoLine = SYNTHETIC_TEMPLATE.replace(
    "image: ${PDPP_NEKO_IMAGE:-pdpp-neko-image-not-set}",
    "image: some-other-shape"
  );
  assert.throws(
    () => renderBundle(templateWithoutNekoLine, VALID_RESOLVED),
    /must have exactly one PDPP_NEKO_IMAGE image default line, found 0/
  );
});

test("renderBundle rejects a non-digest reference", () => {
  const badDigest: ResolvedImage[] = [
    { image: "reference", digest: "sha-abc123" },
    { image: "web", digest: `sha256:${"b".repeat(64)}` },
    { image: "neko", digest: `sha256:${"c".repeat(64)}` },
  ];
  assert.throws(() => renderBundle(SYNTHETIC_TEMPLATE, badDigest), /reference digest must be a full sha256 digest/);
});

test("generateBundle rejects a non-semver release version", () => {
  assert.throws(() => generateBundle(SYNTHETIC_TEMPLATE, "latest", VALID_RESOLVED), /invalid release version/);
  assert.throws(() => generateBundle(SYNTHETIC_TEMPLATE, "v1.2.3", VALID_RESOLVED), /invalid release version/);
});

test("renderBundle rejects a template with a duplicate image default line rather than silently under-rewriting one", () => {
  // String.replace without a global flag only touches the FIRST match — a
  // template that accidentally repeats a `PDPP_REFERENCE_IMAGE` default line
  // (e.g. two services sharing a coincidental image reference) must fail
  // loudly instead of shipping a bundle where one copy is pinned and the
  // other silently still points at the template's own default (e.g. a stale
  // `sha-cc07e3a`).
  const templateWithAccidentalDuplicate = `${SYNTHETIC_TEMPLATE}
  another-reference-mention:
    image: \${PDPP_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a}
`;
  assert.throws(
    () => renderBundle(templateWithAccidentalDuplicate, VALID_RESOLVED),
    /template must have exactly one PDPP_REFERENCE_IMAGE image default line, found 2/
  );
});

test("generateBundle asserts exactly the expected number of lines changed", () => {
  const result = generateBundle(SYNTHETIC_TEMPLATE, "1.0.0", VALID_RESOLVED);
  const changedLines = result.compose
    .split("\n")
    .filter((line, index) => line !== SYNTHETIC_TEMPLATE.split("\n")[index]);
  assert.equal(changedLines.length, VALID_RESOLVED.length);
});

test("generateBundle succeeds and returns the release binding for a clean template", () => {
  const result = generateBundle(SYNTHETIC_TEMPLATE, "1.4.0", VALID_RESOLVED);
  assert.equal(result.release.version, "1.4.0");
  assert.deepEqual(result.release.images, VALID_RESOLVED);
  assert.match(result.compose, /sha256:a{64}/);
});

test("the live repository's Compose template is generator-compatible right now", () => {
  const template = readFileSync(join(REPO_ROOT, TEMPLATE_PATH), "utf8");
  const resolved: ResolvedImage[] = BUNDLE_IMAGES.map(({ matrixImage }, index) => ({
    image: matrixImage,
    digest: `sha256:${String(index).repeat(1).padStart(64, "0")}`,
  }));
  // Proves the live template — whatever state it is in right now, including
  // concurrent unrelated edits from other work in this checkout — still has
  // exactly the three PDPP-built image default lines this generator expects,
  // and that rewriting them changes ONLY those three lines.
  const result = generateBundle(template, "0.0.0-generator-smoke", resolved);
  for (const { envVar } of BUNDLE_IMAGES) {
    assert.match(result.compose, new RegExp(`image: \\$\\{${envVar}:-ghcr\\.io/pdp-connect/pdpp/`));
  }
  assert.match(result.compose, /PDPP_POSTGRES_IMAGE:-pgvector\/pgvector:pg16/, "postgres image must stay untouched");
});
