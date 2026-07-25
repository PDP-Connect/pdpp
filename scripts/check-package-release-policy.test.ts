#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards for the PDPP package-release-policy checks.
//
// Covers the two pieces of logic that protect operators now that the release
// train publishes a single channel (0.x on npm's default `latest`, from main):
//
//   - findRetiredTagInstallDocReferences (hermetic doc-tag guard, part of
//     `release:policy-check`): active install docs must not reference the
//     retired `@beta` dist-tag.
//   - classifyDistTagPosture (network-aware, part of `release:dist-tag-check`):
//     a published `latest` of 0.0.0 is a hazard.
//
// It also asserts the live repository currently passes the hermetic policy
// check, so the checked-in manifests/docs cannot silently regress.

import assert from "node:assert/strict";
import test from "node:test";

import { classifyDistTagPosture, placeholderVersion } from "./check-dist-tag-posture.ts";
import {
  findLocalReleaseMatrixAuthorityErrors,
  findPublishableWorkspaceDependencyErrors,
  findRetiredTagInstallDocReferences,
  policyErrors,
} from "./check-package-release-policy.ts";

const PUBLISHABLE = ["@pdpp/cli", "@pdpp/local-collector", "@pdpp/mcp-server", "@pdpp/read-core"];

const LOCAL_COLLECTOR_DOC_PATTERN = /docs\/reference\/local-collector\.md/;
const RETIRED_BETA_PATTERN = /retired @beta/;
const PLACEHOLDER_PATTERN = /placeholder/;
const WORKSPACE_STAR_PATTERN = /workspace:\*/;
const WORKSPACE_CARET_PATTERN = /workspace:\^/;

function scanLine(line: string): string[] {
  return findRetiredTagInstallDocReferences({
    packageNames: PUBLISHABLE,
    docFiles: ["doc.md"],
    readFile: () => line,
  });
}

test("doc-tag guard flags an install that still pins the retired @beta dist-tag", () => {
  assert.equal(scanLine("npm i -g @pdpp/cli@beta").length, 1);
  assert.equal(scanLine("npm install -g @pdpp/local-collector@beta").length, 1);
  assert.equal(scanLine("npx -y @pdpp/local-collector@beta advertise").length, 1);
});

test("doc-tag guard accepts plain names and pinned versions", () => {
  assert.equal(scanLine("npm i -g @pdpp/cli").length, 0);
  assert.equal(scanLine("npx -y @pdpp/cli --help").length, 0);
  assert.equal(scanLine("npx -y @pdpp/local-collector@0.1.0 run").length, 0);
  // Pinned historical prerelease versions are factual references, not the
  // retired dist-tag.
  assert.equal(scanLine("npx -y @pdpp/local-collector@0.1.0-beta.7 run").length, 0);
});

test("doc-tag guard ignores shell comments and Markdown headings", () => {
  assert.equal(scanLine("# npm i -g @pdpp/cli@beta (the old install path)").length, 0);
  assert.equal(scanLine("## Install @pdpp/cli@beta").length, 0);
  assert.equal(scanLine("  # npx @pdpp/local-collector@beta advertise (example)").length, 0);
});

test("doc-tag guard ignores prose mentions that are not install commands", () => {
  assert.equal(scanLine("The @pdpp/cli@beta channel was retired.").length, 0);
  assert.equal(scanLine("See @pdpp/local-collector@beta history for the runner.").length, 0);
});

test("doc-tag guard does not false-match a longer package name with the same prefix", () => {
  assert.equal(scanLine("npm i -g @pdpp/cli-extras@beta").length, 0);
  assert.equal(scanLine("npm i -g @pdpp/local-collector-internal@beta").length, 0);
});

test("doc-tag guard reports the offending file and line in its message", () => {
  const problems = findRetiredTagInstallDocReferences({
    packageNames: PUBLISHABLE,
    docFiles: ["docs/reference/local-collector.md"],
    readFile: () => "npm i -g @pdpp/cli@beta",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", LOCAL_COLLECTOR_DOC_PATTERN);
  assert.match(problems[0] ?? "", RETIRED_BETA_PATTERN);
});

test("dist-tag classifier treats placeholder latest as a hazard", () => {
  const result = classifyDistTagPosture("@pdpp/cli", { latest: placeholderVersion, beta: "0.1.0-beta.7" });
  assert.equal(result.status, "hazard");
  assert.match(result.detail, PLACEHOLDER_PATTERN);
});

test("dist-tag classifier treats a real latest as ok", () => {
  assert.equal(classifyDistTagPosture("@pdpp/cli", { latest: "1.2.3" }).status, "ok");
  assert.equal(classifyDistTagPosture("@pdpp/cli", { latest: "1.2.3", beta: "1.3.0-beta.1" }).status, "ok");
});

test("dist-tag classifier treats a missing latest with a published beta as a hazard", () => {
  assert.equal(classifyDistTagPosture("@pdpp/cli", { beta: "0.1.0-beta.7" }).status, "hazard");
});

test("dist-tag classifier skips unpublished packages and unreachable registry", () => {
  assert.equal(classifyDistTagPosture("@pdpp/cli", null).status, "skip");
  assert.equal(classifyDistTagPosture("@pdpp/cli", {}).status, "skip");
});

test("publishable packages cannot carry workspace protocol dependencies", () => {
  const problems = findPublishableWorkspaceDependencyErrors([
    {
      file: "packages/mcp-server/package.json",
      dir: "packages/mcp-server",
      manifest: {
        dependencies: {
          "@pdpp/cli": "workspace:*",
          zod: "^3.25.76",
        },
        optionalDependencies: {
          "@pdpp/read-core": "workspace:^",
        },
      },
    },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? "", WORKSPACE_STAR_PATTERN);
  assert.match(problems[1] ?? "", WORKSPACE_CARET_PATTERN);
});

test("local release and signoff cannot bypass the shared release matrix authority", () => {
  const scripts = {
    "release:local": "pnpm release:policy-check && pnpm release:matrix",
    "release:signoff": "pnpm release:local && pnpm release:dry-run",
  };
  assert.deepEqual(findLocalReleaseMatrixAuthorityErrors(scripts), []);
  assert.equal(
    findLocalReleaseMatrixAuthorityErrors({ ...scripts, "release:local": "pnpm release:policy-check" }).length,
    1
  );
  assert.equal(
    findLocalReleaseMatrixAuthorityErrors({ ...scripts, "release:signoff": "pnpm release:dry-run" }).length,
    1
  );
});

test("the live repository passes the hermetic package-release policy check", () => {
  assert.deepEqual(policyErrors, []);
});
