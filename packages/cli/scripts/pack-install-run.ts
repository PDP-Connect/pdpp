// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addNodeProbeToEnvironment,
  assertArtifactReceipt,
  bindNodeEnvironment,
  createNodeProbe,
  fileSha256,
  gitHeadSha,
  labelChildEnvironment,
  packageContentSha256,
  readNodeProbe,
} from "./artifact-receipt.ts";
import { parseNpmPackOutput } from "./package-contract.ts";

interface Manifest {
  exports: Record<string, unknown>;
  name: string;
  version: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
const tempRoot = mkdtempSync(join(tmpdir(), "pdpp-cli-consumer-"));
const consumerRoot = join(tempRoot, "consumer");
const packRoot = join(tempRoot, "pack");
const probe = process.env.PDPP_ARTIFACT_NODE_PROBE_FILE
  ? {
      file: process.env.PDPP_ARTIFACT_NODE_PROBE_FILE,
      script: process.env.PDPP_ARTIFACT_NODE_PROBE_SCRIPT,
    }
  : createNodeProbe(tempRoot);
const expectedNodeVersion = process.env.PDPP_ARTIFACT_EXPECTED_NODE_VERSION;
const expectedNodeExecPath = process.env.PDPP_ARTIFACT_EXPECTED_NODE_EXEC_PATH;
const expectedGitHeadSha = process.env.PDPP_ARTIFACT_EXPECTED_GIT_HEAD_SHA;
const expectedContentSha256 = process.env.PDPP_ARTIFACT_EXPECTED_CONTENT_SHA256;
const packageEnv = {
  ...process.env,
  HOME: join(tempRoot, "home"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
};
const env = addNodeProbeToEnvironment(bindNodeEnvironment(packageEnv, process.execPath), probe);

interface ExecFileOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  [key: string]: unknown;
}

function run(command: string, args: string[], options: ExecFileOptions = {}): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: labelChildEnvironment(env, `${command} ${args.join(" ")}`),
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function runFailure(command: string, args: string[], options: ExecFileOptions = {}): string {
  try {
    run(command, args, options);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`${command} ${args.join(" ")} unexpectedly succeeded`);
}

try {
  mkdirSync(consumerRoot, { recursive: true });
  mkdirSync(packRoot, { recursive: true });
  const [packResult] = parseNpmPackOutput(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], {
      cwd: packageRoot,
    })
  );
  const tarball = join(packRoot, packResult.filename);

  run("npm", ["init", "-y"], { cwd: consumerRoot });
  run("npm", ["install", "--ignore-scripts", "--offline", tarball], { cwd: consumerRoot });

  const tree = JSON.parse(run("npm", ["ls", "--all", "--json"], { cwd: consumerRoot })) as {
    dependencies?: { [key: string]: { version: string } };
  };
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
  assert.equal(tree.dependencies?.["@pdpp/cli"]?.version, manifest.version, "consumer resolved the candidate CLI");
  assert.equal(
    existsSync(join(consumerRoot, "node_modules", "@pdpp", "local-collector")),
    false,
    "CLI-only consumer must not contain the optional collector"
  );

  const exportSpecifiers = Object.keys(manifest.exports).map((subpath) =>
    subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(exportSpecifiers)}.map((specifier) => import(specifier)));`,
    ],
    { cwd: consumerRoot }
  );

  const resolvedRoot = run(
    process.execPath,
    ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(manifest.name)}));`],
    { cwd: consumerRoot }
  ).trim();
  assert.match(resolvedRoot, /node_modules\/@pdpp\/cli\/dist\/src\/index\.js$/, "consumer must resolve emitted CLI JS");

  const help = run("npx", ["--no-install", "pdpp", "--help"], { cwd: consumerRoot });
  assert.match(help, /PDPP CLI/, "installed pdpp help must run through npx without download");

  const collectorFailure = runFailure("npx", ["--no-install", "pdpp", "collector", "advertise"], {
    cwd: consumerRoot,
  });
  assert.match(collectorFailure, /@pdpp\/local-collector/, "CLI-only collector failure must name the optional package");
  assert.match(collectorFailure, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
  assert.doesNotMatch(collectorFailure, /not distributed with @pdpp\/cli yet/);

  interface Receipt {
    environment: {
      path: string;
      npmConfig: {
        audit: string;
        fund: string;
        offline: string;
        updateNotifier: string;
      };
    };
    gitHeadSha: string;
    nodeExecPath: string;
    nodeVersion: string;
    packageContentSha256: string;
    subprocesses: Array<{ label: string; version: string; execPath: string }>;
    tarballSha256: string;
  }

  const receipt: Receipt = {
    nodeVersion: process.version,
    nodeExecPath: process.execPath,
    environment: {
      path: env.PATH || "",
      npmConfig: {
        audit: (env.npm_config_audit as string) || "",
        fund: (env.npm_config_fund as string) || "",
        offline: (env.npm_config_offline as string) || "",
        updateNotifier: (env.npm_config_update_notifier as string) || "",
      },
    },
    gitHeadSha: gitHeadSha(packageRoot),
    packageContentSha256: packageContentSha256(packageRoot),
    tarballSha256: fileSha256(tarball),
    subprocesses: readNodeProbe(probe.file),
  };
  assertArtifactReceipt(receipt, {
    nodeVersion: expectedNodeVersion,
    nodeExecPath: expectedNodeExecPath,
    gitHeadSha: expectedGitHeadSha,
    packageContentSha256: expectedContentSha256,
  });
  process.stdout.write(`ARTIFACT_RECEIPT ${JSON.stringify(receipt)}\n`);
  process.stdout.write(
    `Installed CLI consumer passed: ${exportSpecifiers.length} exports, pdpp --help, offline collector failure.\n`
  );
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
