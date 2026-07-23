// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_RECEIPT_SCHEMA,
  SIBLING_CANDIDATE_SCHEMA,
  assertArtifactReceipt,
  assertCleanWorkingTree,
  assertReceiptPathOutsideWorktree,
  assertReceiptFresh,
  assertSiblingCandidateEvidence,
  currentSourceIdentity,
  currentReceiptIdentity,
  fileSha256,
  gitSha,
  readNpmVersion,
  readPnpmVersion,
} from "./artifact-receipt.mjs";
import { runInstalledStdioProbe } from "./installed-stdio-probe.mjs";
import { declaredExportSpecifiers, parseNpmPackOutput } from "./package-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const pnpmExecutable = join(dirname(process.execPath), "pnpm");
const EMITTED_MCP_RESOLUTION = /node_modules\/@pdpp\/mcp-server\/dist\//;
const MCP_BIN_HELP = /pdpp-mcp-server/;
const PACKAGE_RELATIVE_PATH = /^\.\//;
const siblingSources = {
  "@pdpp/cli": resolve(packageRoot, "..", "cli"),
  "@pdpp/read-core": resolve(packageRoot, "..", "read-core"),
};

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!(name === "--receipt" && value)) {
      throw new Error("Usage: pack-install-run.mjs [--receipt <path>]");
    }
    options[name.slice(2)] = resolve(value);
  }
  return options;
}

function assertNoSymlinkPath(path) {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let current = root;
  for (const component of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      assert.equal(lstatSync(current).isSymbolicLink(), false, "receipt output path must not traverse a symlink");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

export function resolveReceiptOutputPath(path) {
  const absolutePath = resolve(path);
  assertNoSymlinkPath(absolutePath);
  return join(realpathSync(dirname(absolutePath)), basename(absolutePath));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function tarballManifest(tarball) {
  return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]));
}

function tarballFileHashes(tarball) {
  const entries = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length))
    .sort();
  return new Map(entries.map((entry) => [entry, fileSha256FromTar(tarball, `package/${entry}`)]));
}

function fileSha256FromTar(tarball, entry) {
  return createHash("sha256")
    .update(execFileSync("tar", ["-xOf", tarball, entry]))
    .digest("hex");
}

function directoryFileHashes(root) {
  const hashes = new Map();
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      }
      if (entry.isFile()) {
        hashes.set(relative(root, path), fileSha256(path));
      }
    }
  }
  visit(root);
  return hashes;
}

export function assertInstalledPackageMatchesTarball({ consumerRoot, packageName, tarball }) {
  const installedRoot = join(consumerRoot, "node_modules", ...packageName.split("/"));
  assert.equal(existsSync(installedRoot), true, `candidate ${packageName} is not installed`);
  const resolvedRoot = realpathSync(installedRoot);
  const relativeResolvedRoot = relative(consumerRoot, resolvedRoot);
  assert.equal(
    relativeResolvedRoot === "node_modules" || relativeResolvedRoot.startsWith("node_modules/"),
    true,
    `candidate ${packageName} resolved from source instead of the offline consumer`
  );
  const expected = tarballFileHashes(tarball);
  const actual = directoryFileHashes(resolvedRoot);
  assert.deepEqual([...actual], [...expected], `installed ${packageName} differs from exact candidate tarball`);
  return resolvedRoot;
}

function assertCandidateTarball(tarball, expectedName) {
  assert.equal(existsSync(tarball), true, `candidate tarball is missing: ${tarball}`);
  assert.equal(tarballManifest(tarball).name, expectedName, `candidate tarball must be ${expectedName}`);
}

function candidateVersion(packageName) {
  const range = manifest.dependencies[packageName];
  const match = /^>=([0-9]+\.[0-9]+\.[0-9]+)/.exec(range ?? "");
  assert.ok(match, `MCP dependency ${packageName} must declare a lower-bounded release version`);
  return match[1];
}

function packPackage(root, outputRoot) {
  const [packed] = parseNpmPackOutput(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outputRoot], { cwd: root })
  );
  return join(outputRoot, packed.filename);
}

function buildCurrentSiblingCandidate({ packageName, candidateRoot }) {
  const sourceRoot = siblingSources[packageName];
  const sourcePackRoot = join(candidateRoot, "source-pack");
  const stagedRoot = join(candidateRoot, "staged");
  const releasePackRoot = join(candidateRoot, "release-pack");
  mkdirSync(sourcePackRoot, { recursive: true });
  mkdirSync(stagedRoot, { recursive: true });
  mkdirSync(releasePackRoot, { recursive: true });

  assertCleanWorkingTree(sourceRoot);
  run(pnpmExecutable, ["build"], { cwd: sourceRoot });
  const sourceIdentity = currentSourceIdentity(sourceRoot);
  const sourceTarball = packPackage(sourceRoot, sourcePackRoot);
  assertCandidateTarball(sourceTarball, packageName);
  run("tar", ["-xzf", sourceTarball, "-C", stagedRoot]);

  const stagedPackageRoot = join(stagedRoot, "package");
  const stagedManifestPath = join(stagedPackageRoot, "package.json");
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8"));
  stagedManifest.version = candidateVersion(packageName);
  writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
  const tarball = packPackage(stagedPackageRoot, releasePackRoot);
  assertCandidateTarball(tarball, packageName);

  const evidence = {
    schema: SIBLING_CANDIDATE_SCHEMA,
    packageName,
    ...sourceIdentity,
    sourceTarballSha256: fileSha256(sourceTarball),
    tarballSha256: fileSha256(tarball),
    releaseCandidateVersion: stagedManifest.version,
  };
  assertSiblingCandidateEvidence(evidence, {
    packageName,
    sourceIdentity: currentSourceIdentity(sourceRoot),
    sourceTarballSha256: fileSha256(sourceTarball),
    tarballPath: tarball,
  });
  return { evidence, sourceTarball, tarball };
}

function assertCurrentSiblingCandidate(candidate, packageName) {
  const sourceRoot = siblingSources[packageName];
  assertCleanWorkingTree(sourceRoot);
  assertSiblingCandidateEvidence(candidate.evidence, {
    packageName,
    sourceIdentity: currentSourceIdentity(sourceRoot),
    sourceTarballSha256: fileSha256(candidate.sourceTarball),
    tarballPath: candidate.tarball,
  });
}

function importAllExports(consumerRoot) {
  const exportSpecifiers = declaredExportSpecifiers(manifest);
  const source = `await Promise.all(${JSON.stringify(exportSpecifiers)}.map((specifier) => import(specifier)));`;
  run(process.execPath, ["--input-type=module", "--eval", source], { cwd: consumerRoot });
  return exportSpecifiers;
}

function resolveSpecifier(consumerRoot, specifier) {
  return run(
    process.execPath,
    ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(specifier)}));`],
    { cwd: consumerRoot }
  ).trim();
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.receipt) {
    options.receipt = resolveReceiptOutputPath(options.receipt);
    assertReceiptPathOutsideWorktree(options.receipt, gitSha(packageRoot, ["rev-parse", "--show-toplevel"]));
  }
  assertCleanWorkingTree(packageRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), "pdpp-mcp-consumer-"));
  const consumerRoot = join(tempRoot, "consumer");
  const packRoot = join(tempRoot, "pack");
  const candidateRoot = join(tempRoot, "candidates");

  try {
    mkdirSync(consumerRoot, { recursive: true });
    mkdirSync(packRoot, { recursive: true });
    mkdirSync(candidateRoot, { recursive: true });
    const cliCandidate = buildCurrentSiblingCandidate({
      packageName: "@pdpp/cli",
      candidateRoot: join(candidateRoot, "cli"),
    });
    const readCoreCandidate = buildCurrentSiblingCandidate({
      packageName: "@pdpp/read-core",
      candidateRoot: join(candidateRoot, "read-core"),
    });
    const [pack] = parseNpmPackOutput(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], { cwd: packageRoot })
    );
    const mcpTarball = join(packRoot, pack.filename);
    const cliTarball = cliCandidate.tarball;
    const readCoreTarball = readCoreCandidate.tarball;

    run("npm", ["init", "--yes"], { cwd: consumerRoot });
    const consumerName = JSON.parse(readFileSync(join(consumerRoot, "package.json"), "utf8")).name;
    writeFileSync(
      join(consumerRoot, "pnpm-workspace.yaml"),
      `packages:\n  - .\noverrides:\n  "@pdpp/cli": "file:${cliTarball}"\n  "@pdpp/read-core": "file:${readCoreTarball}"\n`
    );
    assertCleanWorkingTree(packageRoot);
    assertCurrentSiblingCandidate(cliCandidate, "@pdpp/cli");
    assertCurrentSiblingCandidate(readCoreCandidate, "@pdpp/read-core");
    const installEnv = {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    };
    run(pnpmExecutable, ["add", "--ignore-scripts", "--offline", cliTarball, readCoreTarball, mcpTarball], {
      cwd: consumerRoot,
      env: installEnv,
    });
    const [dependencyTree] = JSON.parse(
      run(pnpmExecutable, ["list", "--json", "--depth", "-1"], { cwd: consumerRoot, env: installEnv })
    );
    assert.equal(dependencyTree?.name, consumerName, "consumer dependency tree is missing");

    const installedRoots = {
      "@pdpp/cli": assertInstalledPackageMatchesTarball({
        consumerRoot,
        packageName: "@pdpp/cli",
        tarball: cliTarball,
      }),
      "@pdpp/read-core": assertInstalledPackageMatchesTarball({
        consumerRoot,
        packageName: "@pdpp/read-core",
        tarball: readCoreTarball,
      }),
      [manifest.name]: assertInstalledPackageMatchesTarball({
        consumerRoot,
        packageName: manifest.name,
        tarball: mcpTarball,
      }),
    };
    const exportSpecifiers = importAllExports(consumerRoot);
    const resolved = Object.fromEntries(
      exportSpecifiers.map((specifier) => [specifier, resolveSpecifier(consumerRoot, specifier)])
    );
    for (const path of Object.values(resolved)) {
      assert.match(path, EMITTED_MCP_RESOLUTION, `export resolved outside installed emitted MCP artifact: ${path}`);
    }
    const helpResult = spawnSync("npx", ["--no-install", "pdpp-mcp-server", "--help"], {
      cwd: consumerRoot,
      encoding: "utf8",
      env: installEnv,
    });
    assert.equal(helpResult.status, 0, `installed MCP bin failed: ${helpResult.stderr}`);
    const help = helpResult.stderr;
    assert.match(help, MCP_BIN_HELP, "installed MCP bin must execute without a download");
    const stdio = await runInstalledStdioProbe({
      consumerRoot,
      binPath: join(installedRoots[manifest.name], manifest.bin["pdpp-mcp-server"].replace(PACKAGE_RELATIVE_PATH, "")),
    });

    assertCleanWorkingTree(packageRoot);
    const receipt = {
      schema: ARTIFACT_RECEIPT_SCHEMA,
      ...currentReceiptIdentity(packageRoot, mcpTarball),
      workingTreeClean: true,
      node: { version: process.version, execPath: process.execPath },
      packageManager: { npmVersion: readNpmVersion(), pnpmVersion: readPnpmVersion(pnpmExecutable) },
      tarballFiles: pack.files.map((file) => file.path).sort(),
      exports: Object.entries(resolved).map(([specifier, path]) => ({ specifier, path })),
      bins: [{ name: "pdpp-mcp-server", command: "npx --no-install pdpp-mcp-server --help", output: help.trim() }],
      candidates: {
        "@pdpp/cli": { ...cliCandidate.evidence, installedRoot: installedRoots["@pdpp/cli"] },
        "@pdpp/read-core": { ...readCoreCandidate.evidence, installedRoot: installedRoots["@pdpp/read-core"] },
        [manifest.name]: { sha256: fileSha256(mcpTarball), installedRoot: installedRoots[manifest.name] },
      },
      dependencyTree,
      commands: [
        "pnpm build",
        "pnpm build @pdpp/cli and @pdpp/read-core from the clean reviewed tree",
        "npm pack --json --ignore-scripts each sibling, then stamp an isolated release-candidate version",
        "repack and bind each sibling candidate to current base, head, source closure, source tarball, and candidate tarball",
        "pnpm add --ignore-scripts --offline <fresh exact candidate tarballs>",
        "pnpm overrides pin @pdpp/cli and @pdpp/read-core to the verified candidate tarballs",
        "pnpm list --json --depth -1",
        "import every declared export",
        "npx --no-install pdpp-mcp-server --help",
        "MCP initialize + tools/call schema",
      ],
      stdio,
    };
    assertReceiptFresh(receipt, packageRoot, mcpTarball, {
      "@pdpp/cli": cliCandidate.evidence,
      "@pdpp/read-core": readCoreCandidate.evidence,
    });
    assertArtifactReceipt(receipt);
    if (options.receipt) {
      const outputPath = resolveReceiptOutputPath(options.receipt);
      assertReceiptPathOutsideWorktree(outputPath, gitSha(packageRoot, ["rev-parse", "--show-toplevel"]));
      writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    }
    process.stdout.write(`ARTIFACT_RECEIPT ${JSON.stringify(receipt)}\n`);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
