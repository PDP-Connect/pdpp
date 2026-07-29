// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Import the TypeScript file directly - tsx will handle the transpilation
const { npmPackMetadata } = await import("../scripts/pack-metadata.ts");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandFailurePattern = /Command failed: npm pack --json --foreground-scripts=false/;
const stderrPattern = /stderr:\nprepare failed/;
const stdoutPattern = /stdout:\nbuild detail/;

test("npm pack metadata uses the JSON-only background-lifecycle contract", async () => {
  let invocation: { args: string[]; command: string; options: { cwd: string; maxBuffer: number } } | undefined;
  const packInfo = await npmPackMetadata({
    cwd: "/candidate-package",
    dryRun: true,
    execute: (command, args, options) => {
      invocation = { args, command, options };
      return { stdout: JSON.stringify([{ filename: "candidate.tgz", files: [] }]) };
    },
  });

  assert.deepEqual(invocation, {
    args: ["pack", "--json", "--foreground-scripts=false", "--dry-run"],
    command: "npm",
    options: { cwd: "/candidate-package", maxBuffer: 1024 * 1024 },
  });
  assert.equal(packInfo.filename, "candidate.tgz");
});

test("npm pack metadata preserves lifecycle diagnostics on failure", async () => {
  const failure = Object.assign(new Error("npm exited 1"), {
    stderr: "prepare failed",
    stdout: "build detail",
  });

  await assert.rejects(
    npmPackMetadata({
      cwd: "/candidate-package",
      execute: () => {
        throw failure;
      },
    }),
    (error) => {
      assert.match(error.message, commandFailurePattern);
      assert.match(error.message, stdoutPattern);
      assert.match(error.message, stderrPattern);
      return true;
    }
  );
});

test("package validation builds once through npm pack prepare", async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

  assert.equal(packageJson.scripts.prepare, "pnpm build");
  assert.equal(packageJson.scripts.prepack, "pnpm build");
  assert.equal(packageJson.scripts["validate:package"], "tsx scripts/validate-package.ts");
});
