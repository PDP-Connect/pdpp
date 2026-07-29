// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boundRuntimeEnvironment, resolveNpmRuntime } from "./npm-runtime.ts";
import { runOfflineConsumerProbe } from "./pack-install-test.ts";

export const exactNodeVersion = "v22.14.0";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  name: string;
  version: string;
  [key: string]: unknown;
}

export function assertExactRuntime(actualVersion: string = process.version): void {
  assert.equal(
    actualVersion,
    exactNodeVersion,
    `read-core floor verification requires Node ${exactNodeVersion}; running ${actualVersion}`
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  assertExactRuntime();

  const manifestPath = path.join(packageRoot, "package.json");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestSource) as PackageManifest;
  const env = boundRuntimeEnvironment({ env: process.env, nodePath: process.execPath });
  const npmRuntime = await resolveNpmRuntime(env);
  const probe = await runOfflineConsumerProbe({
    env,
    expectedNodeVersion: exactNodeVersion,
    manifest,
    npmRuntime,
    nodePath: process.execPath,
    packageRoot,
  });

  const receipt = {
    command: {
      packageScript: "pnpm build && tsx scripts/verify-node-22.14.ts",
      invocation: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    },
    tree: probe.dependencyTree,
    manifest: {
      path: manifestPath,
      sha256: sha256(manifestSource),
      value: manifest,
    },
    tarball: {
      files: probe.packedFiles,
      sha256: probe.tarballHash,
    },
    npm: {
      executable: probe.npmExecutable,
      version: probe.npmVersion,
    },
    runtime: {
      expectedVersion: exactNodeVersion,
      actualVersion: process.version,
      execPath: process.execPath,
      nodeCommand: process.execPath,
      path: env.PATH,
    },
    consumerProbe: probe.probeOutput.trimEnd().split("\n"),
  };

  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
