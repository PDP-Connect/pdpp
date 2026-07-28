// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("root pnpm config serializes workspace lifecycle children for every installer", async () => {
  const npmrc = await readFile(new URL(".npmrc", root), "utf8");
  assert.match(npmrc, /^child-concurrency=1$/m);

  const vercel = JSON.parse(await readFile(new URL("vercel.json", root), "utf8")) as { installCommand: string };
  assert.match(vercel.installCommand, /pnpm install/);
  assert.doesNotMatch(vercel.installCommand, /--ignore-scripts/);
});

test("inventory workflow explicitly fetches and verifies the manifest baseline", async () => {
  const workflow = await readFile(new URL(".github/workflows/test-accounting.yml", root), "utf8");
  assert.match(workflow, /node -p 'require\("\.\/test-accounting\.manifest\.json"\)\.inventory_base_sha'/);
  assert.match(workflow, /git fetch --no-tags origin "\$base_sha"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$base_sha" HEAD/);
});
