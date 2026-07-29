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
  type ArtifactReceipt,
  assertArtifactReceipt,
  assertCleanWorkingTree,
  assertReceiptFresh,
  assertReceiptPathOutsideWorktree,
  assertSiblingCandidateEvidence,
  type CandidateEvidence,
  currentReceiptIdentity,
  currentSourceIdentity,
  fileSha256,
  gitSha,
  readNpmVersion,
  readPnpmVersion,
  SELF_PACKAGE_NAME,
  SIBLING_CANDIDATE_SCHEMA,
  type SiblingCandidateEvidence,
} from "./artifact-receipt.ts";
import { runInstalledStdioProbe } from "./installed-stdio-probe.ts";
import { declaredExportSpecifiers, type PackageManifest, parseNpmPackOutput } from "./package-contract.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
// assertArtifactReceipt looks up the self-candidate under the fixed
// SELF_PACKAGE_NAME constant; this receipt is written under the manifest's
// own name, so a mismatch here would silently fail that lookup.
assert.equal(manifest.name, SELF_PACKAGE_NAME, "package.json name must match artifact-receipt.ts's SELF_PACKAGE_NAME");
const pnpmExecutable = join(dirname(process.execPath), "pnpm");
const EMITTED_MCP_RESOLUTION = /node_modules\/@pdpp\/mcp-server\/dist\//;
const MCP_BIN_HELP = /pdpp-mcp-server/;
const PACKAGE_RELATIVE_PATH = /^\.\//;
const LOWER_BOUNDED_VERSION_RANGE = /^>=([0-9]+\.[0-9]+\.[0-9]+)/;
const siblingSources: Record<string, string> = {
  "@pdpp/cli": resolve(packageRoot, "..", "cli"),
  "@pdpp/read-core": resolve(packageRoot, "..", "read-core"),
};

interface ParsedArgs {
  receipt?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!(name === "--receipt" && value)) {
      throw new Error("Usage: pack-install-run.ts [--receipt <path>]");
    }
    options.receipt = resolve(value);
  }
  return options;
}

function assertNoSymlinkPath(path: string): void {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  let current = root;
  for (const component of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      assert.equal(lstatSync(current).isSymbolicLink(), false, "receipt output path must not traverse a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

export function resolveReceiptOutputPath(path: string): string {
  const absolutePath = resolve(path);
  assertNoSymlinkPath(absolutePath);
  return join(realpathSync(dirname(absolutePath)), basename(absolutePath));
}

function run(command: string, args: string[], options: Parameters<typeof execFileSync>[2] = {}): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  }) as string;
}

function tarballManifest(tarball: string): { name: string } {
  return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"])) as { name: string };
}

function tarballFileHashes(tarball: string): Map<string, string> {
  const entries = run("tar", ["-tzf", tarball])
    .split("\n")
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length))
    .sort();
  return new Map(entries.map((entry) => [entry, fileSha256FromTar(tarball, `package/${entry}`)]));
}

function fileSha256FromTar(tarball: string, entry: string): string {
  return createHash("sha256")
    .update(execFileSync("tar", ["-xOf", tarball, entry]))
    .digest("hex");
}

function directoryFileHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  function visit(directory: string): void {
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

interface AssertInstalledPackageMatchesTarballOptions {
  consumerRoot: string;
  packageName: string;
  tarball: string;
}

export function assertInstalledPackageMatchesTarball({
  consumerRoot,
  packageName,
  tarball,
}: AssertInstalledPackageMatchesTarballOptions): string {
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

function assertCandidateTarball(tarball: string, expectedName: string): void {
  assert.equal(existsSync(tarball), true, `candidate tarball is missing: ${tarball}`);
  assert.equal(tarballManifest(tarball).name, expectedName, `candidate tarball must be ${expectedName}`);
}

function candidateVersion(packageName: string): string {
  const range = manifest.dependencies?.[packageName];
  const match = LOWER_BOUNDED_VERSION_RANGE.exec(range ?? "");
  assert.ok(match, `MCP dependency ${packageName} must declare a lower-bounded release version`);
  return (match as RegExpExecArray)[1] as string;
}

function packPackage(root: string, outputRoot: string): string {
  const [packed] = parseNpmPackOutput(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outputRoot], { cwd: root })
  );
  assert.ok(packed, `npm pack produced no entries for ${root}`);
  return join(outputRoot, packed.filename);
}

interface SiblingCandidate {
  evidence: SiblingCandidateEvidence;
  sourceTarball: string;
  tarball: string;
}

function buildCurrentSiblingCandidate({
  packageName,
  candidateRoot,
}: {
  candidateRoot: string;
  packageName: string;
}): SiblingCandidate {
  const sourceRoot = siblingSources[packageName] as string;
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
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8")) as { version: string };
  stagedManifest.version = candidateVersion(packageName);
  writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
  const tarball = packPackage(stagedPackageRoot, releasePackRoot);
  assertCandidateTarball(tarball, packageName);

  const evidence: SiblingCandidateEvidence = {
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

function assertCurrentSiblingCandidate(candidate: SiblingCandidate, packageName: string): void {
  const sourceRoot = siblingSources[packageName] as string;
  assertCleanWorkingTree(sourceRoot);
  assertSiblingCandidateEvidence(candidate.evidence, {
    packageName,
    sourceIdentity: currentSourceIdentity(sourceRoot),
    sourceTarballSha256: fileSha256(candidate.sourceTarball),
    tarballPath: candidate.tarball,
  });
}

function importAllExports(consumerRoot: string): string[] {
  const exportSpecifiers = declaredExportSpecifiers(manifest);
  const source = `await Promise.all(${JSON.stringify(exportSpecifiers)}.map((specifier) => import(specifier)));`;
  run(process.execPath, ["--input-type=module", "--eval", source], { cwd: consumerRoot });
  return exportSpecifiers;
}

function resolveSpecifier(consumerRoot: string, specifier: string): string {
  return run(
    process.execPath,
    ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(specifier)}));`],
    { cwd: consumerRoot }
  ).trim();
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let receiptOutputPath: string | undefined;
  if (options.receipt) {
    receiptOutputPath = resolveReceiptOutputPath(options.receipt);
    assertReceiptPathOutsideWorktree(receiptOutputPath, gitSha(packageRoot, ["rev-parse", "--show-toplevel"]));
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
    assert.ok(pack, "npm pack produced no entries for the MCP package");
    const mcpTarball = join(packRoot, pack.filename);
    const cliTarball = cliCandidate.tarball;
    const readCoreTarball = readCoreCandidate.tarball;

    run("npm", ["init", "--yes"], { cwd: consumerRoot });
    const consumerName = (JSON.parse(readFileSync(join(consumerRoot, "package.json"), "utf8")) as { name: string })
      .name;
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
      npm_config_update_notifier: "false",
    };
    // Two-step install, not one blanket `--offline` add. `@pdpp/cli` and
    // `@pdpp/read-core` declare zero external dependencies (verified above by
    // rebuilding them from the clean reviewed tree), so pinning them via
    // `--offline` here proves they resolve from the exact local candidate
    // tarballs with no possibility of reaching the public registry — both
    // packages are also published there under real version numbers, so a
    // silent registry fallback would be a real, not hypothetical, risk.
    // `@pdpp/mcp-server` itself is also installed from a local `file:`-style
    // tarball, but its manifest declares ordinary external dependencies
    // (`@modelcontextprotocol/sdk`, `zod`) that this isolated consumer has
    // never fetched before, so that second step is intentionally online.
    // `overrides` in pnpm-workspace.yaml keeps forcing the two `@pdpp/*`
    // packages to the exact candidate tarballs during the online step too;
    // assertInstalledPackageMatchesTarball below re-verifies by content hash
    // after both steps, independent of which step or network mode installed
    // them, so an override that silently failed to apply would still fail
    // the hash check.
    run(pnpmExecutable, ["add", "--ignore-scripts", "--offline", cliTarball, readCoreTarball], {
      cwd: consumerRoot,
      env: installEnv,
    });
    run(pnpmExecutable, ["add", "--ignore-scripts", mcpTarball], {
      cwd: consumerRoot,
      env: installEnv,
    });
    const [dependencyTree] = JSON.parse(
      run(pnpmExecutable, ["list", "--json", "--depth", "-1"], { cwd: consumerRoot, env: installEnv })
    ) as Array<{ name?: string }>;
    assert.equal(dependencyTree?.name, consumerName, "consumer dependency tree is missing");

    const installedRoots: Record<string, string> = {
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
    const binTarget = (manifest.bin as Record<string, string>)["pdpp-mcp-server"] as string;
    const stdio = await runInstalledStdioProbe({
      consumerRoot,
      binPath: join(installedRoots[manifest.name] as string, binTarget.replace(PACKAGE_RELATIVE_PATH, "")),
    });

    assertCleanWorkingTree(packageRoot);
    const receipt: ArtifactReceipt = {
      schema: ARTIFACT_RECEIPT_SCHEMA,
      ...currentReceiptIdentity(packageRoot, mcpTarball),
      workingTreeClean: true,
      node: { version: process.version, execPath: process.execPath },
      packageManager: { npmVersion: readNpmVersion(), pnpmVersion: readPnpmVersion(pnpmExecutable) },
      tarballFiles: pack.files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
      exports: Object.entries(resolved).map(([specifier, path]) => ({ specifier, path })),
      bins: [{ name: "pdpp-mcp-server", command: "npx --no-install pdpp-mcp-server --help", output: help.trim() }],
      candidates: {
        "@pdpp/cli": { ...cliCandidate.evidence, installedRoot: installedRoots["@pdpp/cli"] as string },
        "@pdpp/read-core": {
          ...readCoreCandidate.evidence,
          installedRoot: installedRoots["@pdpp/read-core"] as string,
        },
        [manifest.name]: {
          sha256: fileSha256(mcpTarball),
          installedRoot: installedRoots[manifest.name] as string,
        } satisfies CandidateEvidence,
      },
      dependencyTree,
      commands: [
        "pnpm build",
        "pnpm build @pdpp/cli and @pdpp/read-core from the clean reviewed tree",
        "npm pack --json --ignore-scripts each sibling, then stamp an isolated release-candidate version",
        "repack and bind each sibling candidate to current base, head, source closure, source tarball, and candidate tarball",
        "pnpm add --ignore-scripts --offline <fresh exact @pdpp/cli and @pdpp/read-core candidate tarballs>",
        "pnpm add --ignore-scripts <mcp-server candidate tarball> (online: resolves ordinary external registry dependencies)",
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
    if (receiptOutputPath) {
      assertReceiptPathOutsideWorktree(receiptOutputPath, gitSha(packageRoot, ["rev-parse", "--show-toplevel"]));
      writeFileSync(receiptOutputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    }
    process.stdout.write(`ARTIFACT_RECEIPT ${JSON.stringify(receipt)}\n`);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
