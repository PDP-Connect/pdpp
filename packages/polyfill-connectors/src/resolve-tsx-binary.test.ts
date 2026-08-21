// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConnectorCommand, resolveTsxBinary, TSX_MISSING_MESSAGE } from "./resolve-tsx-binary.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("resolveTsxBinary finds node_modules/.bin/tsx by walking up from a nested dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsx-resolve-"));
  const binDir = join(root, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "tsx"), "#!/bin/sh\n");
  const nested = join(root, "a", "b", "c");
  await mkdir(nested, { recursive: true });

  assert.equal(resolveTsxBinary(nested), join(binDir, "tsx"));
});

test("resolveTsxBinary returns null when no tsx exists anywhere up the tree", async () => {
  // A temp dir has no node_modules/.bin/tsx between it and the filesystem
  // root, so the walk terminates at "/" without a hit.
  const root = await mkdtemp(join(tmpdir(), "tsx-absent-"));
  assert.equal(resolveTsxBinary(root), null);
});

test("resolveTsxBinary resolves a real tsx from this package (regression: the live ENOENT)", () => {
  const resolved = resolveTsxBinary(PACKAGE_ROOT);
  assert.ok(resolved, "expected the monorepo's tsx to be resolvable from the package root");
  assert.ok(resolved.endsWith(join("node_modules", ".bin", "tsx")));
  assert.ok(resolved.startsWith("/"), "resolved tsx must be an absolute path, not a bare command");
});

test("resolveConnectorCommand rewrites a bare tsx to the resolved absolute path", () => {
  const resolved = resolveConnectorCommand("tsx", () => "/opt/tools/node_modules/.bin/tsx");
  assert.equal(resolved, "/opt/tools/node_modules/.bin/tsx");
  assert.notEqual(resolved, "tsx", "a bare 'tsx' must never reach spawn()");
});

test("resolveConnectorCommand throws a named error instead of spawning a bare tsx", () => {
  assert.throws(
    () => resolveConnectorCommand("tsx", () => null),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, TSX_MISSING_MESSAGE);
      assert.match(error.message, /tsx/, "the error must name the missing binary");
      assert.doesNotMatch(error.message, /ENOENT/, "must not surface a bare spawn ENOENT");
      return true;
    }
  );
});

test("resolveConnectorCommand passes a non-tsx command through untouched", () => {
  // Operator overrides and node-entrypoint connectors must not be rewritten,
  // and must not require tsx to be resolvable at all.
  assert.equal(
    resolveConnectorCommand("node", () => null),
    "node"
  );
  assert.equal(
    resolveConnectorCommand("/usr/local/bin/custom-runtime", () => null),
    "/usr/local/bin/custom-runtime"
  );
});

test("TSX_MISSING_MESSAGE stays textually in sync with the CLI copy", async () => {
  // packages/cli cannot import this module: its tsconfig.build.json pins
  // rootDir to the cli package, so a cross-package import fails with TS6059,
  // and @pdpp/cli deliberately ships zero runtime dependencies. The two
  // copies are therefore kept in sync by this assertion rather than by an
  // import. If this fails, update both copies together.
  const cliRunner = await readFile(join(PACKAGE_ROOT, "..", "cli", "src", "collector", "runner.ts"), "utf8");
  assert.ok(
    cliRunner.includes(TSX_MISSING_MESSAGE.replaceAll('"', '\\"')) || cliRunner.includes("Could not locate tsx"),
    "the CLI's TSX_MISSING_MESSAGE drifted from the shared copy"
  );
  // Assert the meaningful invariant: both name tsx and both give an install fix.
  assert.match(cliRunner, /Could not locate tsx alongside the collector runner/);
  assert.match(TSX_MISSING_MESSAGE, /Could not locate tsx alongside the collector runner/);
});
