// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type NpmRuntime, resolveNpmRuntime, runNpm } from "./npm-runtime.ts";
import { installedPackageProbeSource } from "./public-api.ts";
import { packAndInspect } from "./validate-package.ts";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  name: string;
  version: string;
}

interface DependencyTree {
  dependencies?: Record<string, unknown>;
  name: string;
  version: string;
}

interface OfflineConsumerProbeResult {
  dependencyTree: DependencyTree;
  npmExecutable: string;
  npmVersion: string;
  packedFiles: string[];
  probeOutput: string;
  tarballHash: string;
}

export async function runOfflineConsumerProbe({
  packageRoot: root = packageRoot,
  manifest,
  env = process.env,
  nodePath = process.execPath,
  npmRuntime,
  expectedNodeVersion = process.version,
}: {
  packageRoot?: string;
  manifest: PackageManifest;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  npmRuntime?: NpmRuntime;
  expectedNodeVersion?: string;
}): Promise<OfflineConsumerProbeResult> {
  const resolvedNpmRuntime = npmRuntime ?? (await resolveNpmRuntime(env));
  const { packedFiles, tarballHash, tarballPath } = await packAndInspect(root, manifest, {
    npmRuntime: resolvedNpmRuntime,
  });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pdpp-read-core-pack-"));
  const projectDir = path.join(tempRoot, "consumer");

  try {
    await mkdir(projectDir, { recursive: true });
    await runNpm(resolvedNpmRuntime, ["init", "--yes"], { cwd: projectDir });
    await runNpm(resolvedNpmRuntime, ["install", "--ignore-scripts", "--offline", tarballPath], { cwd: projectDir });

    const { stdout: dependencyTree } = await runNpm(resolvedNpmRuntime, ["ls", "--json", "--all"], { cwd: projectDir });
    const parsedTree = dependencyTree.trim() ? (JSON.parse(dependencyTree) as DependencyTree | null) : null;
    const installed = parsedTree
      ? parsedTree.dependencies?.[manifest.name]
      : JSON.parse(
          await readFile(path.join(projectDir, "node_modules", ...manifest.name.split("/"), "package.json"), "utf8")
        );
    assert.equal(
      (installed as unknown as { version: string }).version,
      manifest.version,
      "consumer must resolve the candidate package version"
    );
    const consumerTree: DependencyTree = parsedTree ?? {
      name: "consumer",
      version: "0.0.0",
      dependencies: { [manifest.name]: installed },
    };

    const probePath = path.join(projectDir, "probe.mjs");
    const probeSource = installedPackageProbeSource(manifest.name, expectedNodeVersion);
    await writeFile(probePath, probeSource);
    const { stdout: probeOutput } = (await execFileAsync(nodePath, [probePath], {
      cwd: projectDir,
      env: resolvedNpmRuntime.env,
    })) as { stdout: string };
    return {
      dependencyTree: consumerTree,
      npmExecutable: resolvedNpmRuntime.executable,
      npmVersion: resolvedNpmRuntime.version,
      packedFiles,
      probeOutput,
      tarballHash,
    };
  } finally {
    await rm(tarballPath, { force: true });
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  const result = await runOfflineConsumerProbe({ manifest });
  process.stdout.write(`Installed npm: ${result.npmExecutable} (${result.npmVersion})\n`);
  process.stdout.write(`Installed consumer proof:\n${result.probeOutput}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
