// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GITHUB_REPO_URL, repoBlobUrl, SITE_LICENSES } from "../src/components/pdpp-concept/site-facts.ts";
import { SPEC_EDITORS, SPEC_STATUS } from "../src/components/pdpp-concept/spec-status.ts";

// The owner's standing rule for the site pass: anything that can go stale but is
// tracked in the repo must be wired so it cannot. These tests are the "cannot".
//
// spec-status.ts already DERIVES version/status/date/editors at module load, so
// it cannot drift by construction — these cases pin the parse against the real
// files so a change to the header or table SHAPE fails loudly here rather than
// silently emptying a stamp on the live site.
//
// SITE_LICENSES is still a literal (a license identifier is not mechanically
// derivable from the LICENSE prose), so it gets a real cross-check against the
// LICENSE files on disk.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_MAINTAINER_ROW = /^\|\s*[^|]+\|\s*`@[^`]+`\s*\|[^|]*\|\s*Active\s*\|/;
const APACHE_2_HEADING = /Apache License\s*\n?\s*Version 2\.0/;
const CC_BY_4_HEADING = /Creative Commons Attribution 4\.0/i;
const CSL_1_HEADING = /Community Specification License 1\.0/i;
const HTTPS_URL = /^https:\/\//;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

test("spec status is derived from the spec-core.md header", () => {
  const [titleLine = "", , statusLine = "", dateLine = ""] = readRepoFile("spec-core.md").split("\n");

  assert.ok(titleLine.includes(SPEC_STATUS.version), `spec-core.md line 1 must carry ${SPEC_STATUS.version}`);
  assert.equal(statusLine, `Status: ${SPEC_STATUS.label}`);
  assert.equal(dateLine, `Date: ${SPEC_STATUS.date}`);
});

test("spec version is a semver-shaped tag, not a placeholder", () => {
  assert.match(SPEC_STATUS.version, SEMVER_TAG);
  assert.match(SPEC_STATUS.date, ISO_DATE);
  assert.ok(SPEC_STATUS.label.length > 0);
});

test("editors are derived from the active rows of MAINTAINERS.md", () => {
  const maintainers = readRepoFile("MAINTAINERS.md");

  assert.ok(SPEC_EDITORS.length > 0, "MAINTAINERS.md must yield at least one active maintainer");
  for (const editor of SPEC_EDITORS) {
    assert.ok(maintainers.includes(editor), `${editor} must appear in MAINTAINERS.md`);
  }

  // Every Active row is represented — catches a parse that silently drops rows.
  const activeRows = maintainers.split("\n").filter((line) => ACTIVE_MAINTAINER_ROW.test(line));
  assert.equal(SPEC_EDITORS.length, activeRows.length);
});

test("footer license identifiers match the LICENSE files on disk", () => {
  const spdxIds = SITE_LICENSES.map((row) => row.spdx);
  assert.deepEqual(spdxIds, ["CSL-1.0", "Apache-2.0", "CC-BY-4.0"], "specification text must be listed first");

  // Apache-2.0 and CC-BY-4.0 name themselves in their license text.
  assert.match(readRepoFile("LICENSE"), APACHE_2_HEADING);
  assert.match(readRepoFile("LICENSE-docs"), CC_BY_4_HEADING);
  // LICENSE-specs is the Community Specification License 1.0; the site shows
  // the short form CSL-1.0.
  assert.match(readRepoFile("LICENSE-specs"), CSL_1_HEADING);
});

test("every footer license links to real license text", () => {
  for (const row of SITE_LICENSES) {
    assert.match(row.href, HTTPS_URL, `${row.spdx} must link to its license text`);
    assert.ok(row.artifact.length > 0);
  }
});

test("repoBlobUrl derives from GITHUB_REPO_URL, not a second literal", () => {
  assert.equal(repoBlobUrl("MAINTAINERS.md"), `${GITHUB_REPO_URL}/blob/main/MAINTAINERS.md`);
  assert.equal(
    repoBlobUrl("reference-implementation/test/pdpp.test.js"),
    `${GITHUB_REPO_URL}/blob/main/reference-implementation/test/pdpp.test.js`
  );
});

// GITHUB_REPO_URL previously had 5 independent hand-typed copies across
// docs-shared.tsx, source-link.tsx, the specification page, and 5 places in
// self-host/coverage/data.ts (2026-08-05). Every one is now derived from this
// single export or from repoBlobUrl(); this pins that so a future edit cannot
// quietly reintroduce a hand-typed "https://github.com/PDP-Connect/pdpp".
test("no site source file hand-types the GitHub repo URL outside site-facts.ts", () => {
  const filesThatMustDeriveIt = [
    "src/lib/docs-shared.tsx",
    "src/components/docs/source-link.tsx",
    "src/app/specification/[[...slug]]/page.tsx",
    "src/app/self-host/coverage/data.ts",
    "src/components/pdpp-concept/footer.tsx",
  ];

  for (const relativePath of filesThatMustDeriveIt) {
    const source = readFileSync(join(REPO_ROOT, "apps/site", relativePath), "utf8");
    assert.ok(
      !source.includes("github.com/PDP-Connect/pdpp"),
      `${relativePath} must derive the repo URL from site-facts.ts, not hand-type it`
    );
  }
});
