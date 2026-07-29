// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const referenceSpine = path.join(repoRoot, "reference-implementation/lib/spine.ts");
const whitespacePattern = /\s+/;

function noTypeStrippingFlag() {
  if (process.allowedNodeEnvironmentFlags.has("--no-experimental-strip-types")) {
    return "--no-experimental-strip-types";
  }
  if (process.allowedNodeEnvironmentFlags.has("--no-strip-types")) {
    return "--no-strip-types";
  }
  throw new Error("the supported Node engine must expose a type-stripping disable flag");
}

test("pack-install-run starts the private reference fixture under tsx", async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const command = packageJson.scripts?.["pack-install-run"]?.trim().split(whitespacePattern);

  assert.deepEqual(command, ["node", "--import", "tsx", "scripts/pack-install-run.ts"]);
  assert.equal(packageJson.dependencies?.tsx, undefined, "tsx must not become a runtime dependency");
  assert.equal(packageJson.optionalDependencies?.tsx, undefined, "tsx must not become an optional runtime dependency");

  const sourceUrl = pathToFileURL(referenceSpine).href;
  const loaderArgs = command.slice(1, 3);
  const probe = `await import(${JSON.stringify(sourceUrl)});`;
  await execFileAsync(
    process.execPath,
    [noTypeStrippingFlag(), ...loaderArgs, "--input-type=module", "--eval", probe],
    { cwd: repoRoot }
  );
});
