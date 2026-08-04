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
  ["tunnel profile oracle", new URL("./blessed-compose-tunnel-profile.test.ts", import.meta.url)],
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

// The friend path no longer quotes any PDPP image tag or commit SHA at all —
// the released bundle at .../releases/latest/download/docker-compose.yml
// already pins reference/web/neko by digest. This oracle now forbids the
// three ways that contract could regress: (1) a raw main-branch or
// commit-SHA fetch URL standing in for the stable release URL, which
// reintroduces exactly the pin-churn the bundle exists to close; (2) a
// friend-facing PDPP_REFERENCE_IMAGE/PDPP_WEB_IMAGE/PDPP_NEKO_IMAGE override
// in a secret-generation block, which would let a stale .env silently
// override the bundle's digest pins; (3) a mutable main/latest image tag,
// which was never safe to advertise.
const RELEASED_BUNDLE_URL = "https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml";
const RAW_MAIN_OR_COMMIT_FETCH_RE =
  /raw\.githubusercontent\.com\/PDP-Connect\/pdpp\/(?:main|[0-9a-f]{40})\/deploy\/docker\/docker-compose\.yml/;
const MUTABLE_IMAGE_TAG_RE = /ghcr\.io\/pdp-connect\/pdpp\/[a-z-]+:(?:main|latest)\b/;
const RETIRED_OWNER_PATH_RE = /contains the retired owner path/;
const LEGACY_OWNER_PATH = ["/", "dashboard"].join("");
const MATRIX_IMAGE_RE = /^\s*- image:\s*(\S+)\s*$/;
const MATRIX_ENTRY_RE = /^\s*- image:/;
const MATRIX_PROPERTY_RE = /^\s{2,}\w/;
const MATRIX_TARGET_RE = /^\s*target:\s*(\S+)\s*$/;
const MATRIX_TITLE_RE = /^\s*title:\s*(.+?)\s*$/;

// A friend-facing secret-generation block is one that also sets
// PDPP_OWNER_PASSWORD/PDPP_CREDENTIAL_ENCRYPTION_KEY — the actual
// steady-state .env this path tells a friend to write. This scoping matters:
// deploy/docker/docker-compose.yml's OWN `image: ${PDPP_REFERENCE_IMAGE:-...}`
// default lines are legitimate (the release generator rewrites exactly
// those), and the developer-fallback PDPP_NEKO_IMAGE=pdpp-neko:local
// override is explicitly documented as non-friend-path — neither should trip
// this check. What must never reappear is a friend-facing secret block that
// ALSO sets an image override, since that silently defeats the bundle's pin.
const SECRET_BLOCK_RE = /```(?:sh|powershell)\n([\s\S]*?)```/g;
const OWNER_SECRET_MARKER_RE = /PDPP_OWNER_PASSWORD|PDPP_CREDENTIAL_ENCRYPTION_KEY/;
const IMAGE_OVERRIDE_IN_BLOCK_RE = /PDPP_(?:REFERENCE|WEB)_IMAGE\s*=/;

function readSources(paths: readonly (readonly [string, URL])[]) {
  return Promise.all(
    paths.map(async ([sourceName, path]) => [sourceName, await readFile(fileURLToPath(path), "utf8")] as const)
  );
}

function assertSourceArtifactsConsistent(sourceName: string, source: string) {
  assert.doesNotMatch(
    source,
    RAW_MAIN_OR_COMMIT_FETCH_RE,
    `${sourceName} must not fetch deploy/docker/docker-compose.yml from a raw main-branch or commit-SHA URL — use the stable release URL (${RELEASED_BUNDLE_URL}) instead`
  );
  assert.doesNotMatch(source, MUTABLE_IMAGE_TAG_RE, `${sourceName} must not use mutable main/latest image tags`);

  for (const block of source.matchAll(SECRET_BLOCK_RE)) {
    const body = block[1] ?? "";
    if (!OWNER_SECRET_MARKER_RE.test(body)) {
      continue;
    }
    assert.doesNotMatch(
      body,
      IMAGE_OVERRIDE_IN_BLOCK_RE,
      `${sourceName} ships a friend-facing secret-generation block that also sets PDPP_REFERENCE_IMAGE/PDPP_WEB_IMAGE — the released bundle already pins both by digest, and a stale override in this block would silently defeat that pin`
    );
  }
}

function assertNoLegacyOwnerPath(sourceName: string, source: string) {
  assert.equal(source.includes(LEGACY_OWNER_PATH), false, `${sourceName} contains the retired owner path`);
}

test("blessed friend-facing paths use the one stable release URL, never a raw main/commit fetch or a stale image override", async () => {
  const sources = await readSources(BLESSED_ARTIFACT_PATHS);

  for (const [sourceName, source] of sources) {
    assertSourceArtifactsConsistent(sourceName, source);
  }

  const readmeSource = sources.find(([sourceName]) => sourceName === "Docker deployment runbook");
  assert.ok(readmeSource);
  const [, readme] = readmeSource;
  assert.ok(
    readme.includes(RELEASED_BUNDLE_URL),
    "deploy/docker/README.md must document the one stable release URL"
  );
});

test("artifact oracle mutation-proof: raw main-branch fetch URL in source text", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        "curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/main/deploy/docker/docker-compose.yml"
      ),
    { message: /raw main-branch or commit-SHA URL/ }
  );
});

test("artifact oracle mutation-proof: raw commit-SHA fetch URL in source text", () => {
  assert.throws(
    () =>
      assertSourceArtifactsConsistent(
        "synthetic regression input",
        "curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/cc07e3a896c2c0df7841da4ec6b2c660ffe1e792/deploy/docker/docker-compose.yml"
      ),
    { message: /raw main-branch or commit-SHA URL/ }
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

test("artifact oracle mutation-proof: friend-facing secret block with a stale image override", () => {
  const mutated = [
    "```sh",
    "printf 'PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a\\nPDPP_OWNER_PASSWORD=%s\\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\\n' \\",
    '  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env',
    "```",
  ].join("\n");
  assert.throws(() => assertSourceArtifactsConsistent("synthetic regression input", mutated), {
    message: /silently defeat that pin/,
  });
});

test("artifact oracle allows a developer-fallback image override outside a friend-facing secret block", () => {
  // PDPP_NEKO_IMAGE=pdpp-neko:local is explicitly documented as a
  // developer-only fallback, never bundled with owner-password/encryption
  // secret generation — it must NOT trip the friend-path guard above.
  assert.doesNotThrow(() =>
    assertSourceArtifactsConsistent("synthetic regression input", "PDPP_NEKO_IMAGE=pdpp-neko:local")
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
