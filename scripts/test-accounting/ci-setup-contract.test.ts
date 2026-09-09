// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const CHILD_CONCURRENCY_PATTERN = /^childConcurrency: 1$/m;
const INSTALL_PATTERN = /pnpm install/;
const IGNORE_SCRIPTS_PATTERN = /--ignore-scripts/;
const INVENTORY_BASE_PATTERN = /node -p 'require\("\.\/test-accounting\.manifest\.json"\)\.inventory_base_sha'/;
const FETCH_BASE_PATTERN = /git fetch --no-tags origin "\$base_sha"/;
const ANCESTOR_PATTERN = /git merge-base --is-ancestor "\$base_sha" HEAD/;

test("root pnpm config serializes workspace lifecycle children for every installer", async () => {
  const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
  assert.match(workspace, CHILD_CONCURRENCY_PATTERN);

  const vercel = JSON.parse(await readFile(new URL("vercel.json", root), "utf8")) as { installCommand: string };
  assert.match(vercel.installCommand, INSTALL_PATTERN);
  assert.doesNotMatch(vercel.installCommand, IGNORE_SCRIPTS_PATTERN);
});

test("inventory workflow explicitly fetches and verifies the manifest baseline", async () => {
  const workflow = await readFile(new URL(".github/workflows/test-accounting.yml", root), "utf8");
  assert.match(workflow, INVENTORY_BASE_PATTERN);
  assert.match(workflow, FETCH_BASE_PATTERN);
  assert.match(workflow, ANCESTOR_PATTERN);
});
