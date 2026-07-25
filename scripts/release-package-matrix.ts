#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_VERSION = 2;
export const PACKAGE_NAMES = ["@pdpp/cli", "@pdpp/read-core", "@pdpp/local-collector", "@pdpp/mcp-server"];
const PNPM_INTEGRITY =
  "sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==";
const PNPM_ENTRYPOINT_SHA256 = "b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9";
const DOCKER_RUNTIME_IMAGE =
  "node:25.8.2-bookworm-slim@sha256:71be4054ee7a5fc8d0b2a66060705988b09a782025d70ba9318b29ff1a931fc0";

export interface MatrixRow {
  exactFloor: boolean;
  id: string;
  image: string;
  nodeVersion: string;
}

export const NODE_MATRIX: MatrixRow[] = [
  {
    id: "node-22.14.0",
    image: "node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b",
    nodeVersion: "v22.14.0",
    exactFloor: true,
  },
  {
    id: "repository-docker-node-25.8.2",
    image: DOCKER_RUNTIME_IMAGE,
    nodeVersion: "v25.8.2",
    exactFloor: false,
  },
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit";
}

function run(command: string, args: string[], options: RunOptions = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio,
  });
}

const PACKAGE_MANAGER_PATTERN = /^pnpm@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

interface PackageManagerBinding {
  name: "pnpm";
  version: string;
}

function parsePackageManager(value: string | undefined): PackageManagerBinding {
  const match = PACKAGE_MANAGER_PATTERN.exec(value ?? "");
  assert.ok(match, `packageManager must pin pnpm to one exact version; received ${value}`);
  const [, version] = match;
  assert.ok(version, `packageManager must pin pnpm to one exact version; received ${value}`);
  return { name: "pnpm", version };
}

const NVMRC_PATTERN = /^v\d+\.\d+\.\d+$/;
const DOCKER_NODE_VERSION_PATTERN = /^node:(\d+\.\d+\.\d+)/;
const COREPACK_PATTERN = /corepack/;
const PNPM_FETCH_PATTERN =
  /npm pack --ignore-scripts --loglevel=error --pack-destination \/tmp "pnpm@\$\{PNPM_VERSION\}"/;
const PNPM_INTEGRITY_CHECK_PATTERN = /pnpm integrity drift/;

export function assertRepositoryRuntimeConfiguration({
  dockerfile,
  nvmrc,
  packageManager,
}: {
  dockerfile: string;
  nvmrc: string;
  packageManager: string | undefined;
}): PackageManagerBinding & { integrity: string } {
  const manager = parsePackageManager(packageManager);
  const node = nvmrc.trim();
  assert.match(node, NVMRC_PATTERN, `.nvmrc must pin an exact Node version; received ${node}`);
  assert.match(
    dockerfile,
    new RegExp(`^ARG NODE_VERSION=${escapeRegExp(DOCKER_RUNTIME_IMAGE.slice("node:".length))}$`, "m"),
    "Dockerfile Node base must match the repository runtime digest"
  );
  assert.match(
    dockerfile,
    new RegExp(`^ARG PNPM_VERSION=${escapeRegExp(manager.version)}$`, "m"),
    "Dockerfile pnpm version must match packageManager"
  );
  assert.match(
    dockerfile,
    new RegExp(`^ARG PNPM_INTEGRITY=${escapeRegExp(PNPM_INTEGRITY)}$`, "m"),
    "Dockerfile pnpm integrity must match the repository package-manager SRI"
  );
  assert.equal(
    `v${DOCKER_RUNTIME_IMAGE.match(DOCKER_NODE_VERSION_PATTERN)?.[1]}`,
    node,
    "Dockerfile Node version must match .nvmrc"
  );
  assert.doesNotMatch(dockerfile, COREPACK_PATTERN, "Dockerfile must not bootstrap an unpinned Corepack package");
  assert.match(dockerfile, PNPM_FETCH_PATTERN, "Dockerfile must fetch the exact pnpm tarball");
  assert.match(
    dockerfile,
    PNPM_INTEGRITY_CHECK_PATTERN,
    "Dockerfile must verify the pnpm tarball bytes before installation"
  );
  return { ...manager, integrity: PNPM_INTEGRITY };
}

const REGEXP_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_ESCAPE_PATTERN, "\\$&");
}

function trackedFiles(root: string = REPOSITORY_ROOT): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean).sort();
}

export interface SourceClosure {
  files: string[];
  sha256: string;
}

export function sourceClosure(root: string = REPOSITORY_ROOT): SourceClosure {
  const hash = createHash("sha256");
  const files = trackedFiles(root);
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return { files, sha256: hash.digest("hex") };
}

function git(root: string, args: string[]): string {
  return run("git", args, { cwd: root }).trim();
}

function assertClean(root: string = REPOSITORY_ROOT): void {
  assert.equal(git(root, ["status", "--porcelain"]), "", "release matrix requires a clean worktree");
}

export interface Snapshot {
  baseSha: string;
  headSha: string;
  packageManager: PackageManagerBinding & { integrity: string };
  sourceClosure: SourceClosure;
}

export function currentSnapshot(root: string = REPOSITORY_ROOT): Snapshot {
  assertClean(root);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageManager = assertRepositoryRuntimeConfiguration({
    dockerfile: readFileSync(join(root, "Dockerfile"), "utf8"),
    nvmrc: readFileSync(join(root, ".nvmrc"), "utf8"),
    packageManager: packageJson.packageManager,
  });
  return {
    // Integration worktrees can descend from a composed local baseline that
    // shares no history with the archive remote. The immediate committed parent
    // is therefore the deterministic default; a release owner can bind a
    // different reviewed baseline explicitly without relying on remote shape.
    baseSha: git(root, ["rev-parse", `${process.env.PDPP_RELEASE_MATRIX_BASE ?? "HEAD^"}^{commit}`]),
    headSha: git(root, ["rev-parse", "HEAD"]),
    sourceClosure: sourceClosure(root),
    packageManager,
  };
}

function createSourceSnapshot(root: string, target: string, headSha: string): void {
  // Package-local floor gates bind their receipts to Git HEAD. A local shared
  // clone preserves that proof without fetching a remote or trusting a
  // mutable source mount; checkout is pinned to the outer snapshot's HEAD.
  const head = git(root, ["rev-parse", "HEAD"]);
  assert.equal(head, headSha, "matrix source snapshot escaped the bound committed head");
  run("git", ["clone", "--shared", "--no-checkout", root, target], { cwd: dirname(target) });
  run("git", ["checkout", "--detach", headSha], { cwd: target });
  assert.equal(git(target, ["rev-parse", "HEAD"]), headSha, "matrix source checkout drifted");
}

function dockerImageTag(row: MatrixRow, headSha: string): string {
  return `pdpp-release-matrix-${row.id}-${headSha.slice(0, 12)}`;
}

interface RunnerBinding {
  identity: string;
  imageId: string;
  tag: string;
}

function buildRunner(root: string, row: MatrixRow, snapshot: Snapshot): RunnerBinding {
  const tag = dockerImageTag(row, snapshot.headSha);
  run(
    "docker",
    [
      "build",
      "--pull=false",
      "--file",
      "scripts/release-package-matrix.Dockerfile",
      "--tag",
      tag,
      "--build-arg",
      `NODE_IMAGE=${row.image}`,
      "--build-arg",
      `PNPM_VERSION=${snapshot.packageManager.version}`,
      "--build-arg",
      `PNPM_INTEGRITY=${snapshot.packageManager.integrity}`,
      ".",
    ],
    { cwd: root, stdio: "inherit" }
  );
  const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { cwd: root }).trim();
  return {
    imageId,
    identity: sha256(
      JSON.stringify({
        image: row.image,
        dockerfileSha256: sha256File(join(root, "scripts/release-package-matrix.Dockerfile")),
        lockfileSha256: sha256File(join(root, "pnpm-lock.yaml")),
        packageManager: snapshot.packageManager,
        pnpmEntrypointSha256: PNPM_ENTRYPOINT_SHA256,
      })
    ),
    tag,
  };
}

function packagePath(name: string): string {
  return join("packages", name.slice("@pdpp/".length));
}

interface PackageManifest {
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  name: string;
  version: string;
}

function packageManifest(name: string, root: string = REPOSITORY_ROOT): PackageManifest {
  return JSON.parse(readFileSync(join(root, packagePath(name), "package.json"), "utf8"));
}

interface PackageContract {
  bins: string[];
  exportSubpaths: string[];
}

interface PackageContractRecord {
  contract: PackageContract;
  manifestSha256: string;
  name: string;
  version: string;
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function packageContracts(root: string = REPOSITORY_ROOT): PackageContractRecord[] {
  return PACKAGE_NAMES.map((name) => {
    const manifest = packageManifest(name, root);
    return {
      name,
      version: manifest.version,
      manifestSha256: sha256File(join(root, packagePath(name), "package.json")),
      contract: {
        exportSubpaths: Object.keys(manifest.exports ?? {}).sort(compareStrings),
        bins: Object.keys(manifest.bin ?? {}).sort(compareStrings),
      },
    };
  });
}

interface PackedTarball {
  filename: string;
  files: { path: string }[];
}

const NPM_PACK_JSON_PATTERN = /(\[\s*\{[\s\S]*\])\s*$/;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX64_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function packJson(output: string): PackedTarball {
  const match = output.match(NPM_PACK_JSON_PATTERN);
  assert.ok(match, "npm pack did not emit a trailing JSON payload");
  const [, captured] = match;
  assert.ok(captured, "npm pack did not emit a trailing JSON payload");
  return JSON.parse(captured)[0];
}

function consumerProbeSource(manifests: PackageManifest[]): string {
  const values = JSON.stringify(
    manifests.map((manifest) => ({
      name: manifest.name,
      version: manifest.version,
      exports: manifest.exports,
      bin: manifest.bin,
    }))
  );
  return `
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = ${values};
const results = [];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isInside = (path, parent) => { const value = relative(parent, path); return value === '' || (!value.startsWith('..' + sep) && value !== '..'); };
const targets = (value) => typeof value === 'string' ? [value] : Object.values(value).flatMap(targets);
for (const pkg of packages) {
  const root = realpathSync(resolve('node_modules', ...pkg.name.split('/')));
  const installed = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(installed.name, pkg.name);
  assert.equal(installed.version, pkg.version);
  const resolutions = [];
  for (const subpath of Object.keys(pkg.exports)) {
    const specifier = subpath === '.' ? pkg.name : pkg.name + '/' + subpath.slice(2);
    const jsonExport = targets(pkg.exports[subpath]).some((target) => target.endsWith('.json'));
    const imported = await import(specifier, jsonExport ? { with: { type: 'json' } } : undefined);
    const resolved = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
    assert.ok(isInside(resolved, root), specifier + ' escaped candidate node_modules package');
    assert.ok(targets(pkg.exports[subpath]).some((target) => resolved === resolve(root, target)), specifier + ' did not resolve a declared candidate target');
    resolutions.push({ specifier, resolved: relative(process.cwd(), resolved), exports: Object.keys(imported).sort() });
  }
  const bins = [];
  for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
    const executable = realpathSync(resolve('node_modules/.bin', bin));
    assert.equal(executable, resolve(root, target));
    const helpResult = spawnSync('npx', ['--no-install', bin, '--help'], { encoding: 'utf8' });
    assert.equal(helpResult.status, 0, bin + ' did not exit successfully');
    const help = helpResult.stdout || helpResult.stderr || '';
    assert.ok(help.length > 0, bin + ' did not produce help output');
    bins.push({ bin, executable: relative(process.cwd(), executable), helpSha256: sha256(help) });
  }
  results.push({ name: pkg.name, root: relative(process.cwd(), root), resolutions, bins });
}
process.stdout.write(JSON.stringify(results));
`;
}

interface RecordedCommand {
  command: string[];
  cwd: string;
  exitCode: number;
  resultSha256: string;
}

interface RecordedError extends Error {
  status: number | null;
  stderr: string;
  stdout: string;
}

function runRecorded(recorded: RecordedCommand[], command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  recorded.push({
    command: [command, ...args],
    cwd: options.cwd ?? process.cwd(),
    exitCode: result.status ?? 1,
    // Package-manager progress logs contain elapsed-time and cache details.
    // The matrix captures their semantic effects below (tarballs, installed
    // tree, and probes), so bind this command's deterministic outcome rather
    // than pretending those ephemeral logs are reproducible evidence.
    resultSha256: sha256(
      JSON.stringify({ command: [command, ...args], cwd: options.cwd ?? process.cwd(), exitCode: result.status ?? 1 })
    ),
  });
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`) as RecordedError;
    error.stdout = stdout;
    error.stderr = stderr;
    error.status = result.status;
    throw error;
  }
  return stdout;
}

interface MatrixContext {
  baseSha: string;
  headSha: string;
  packageManager: PackageManagerBinding & { integrity: string };
  sourceClosureSha256: string;
}

function runMatrixRow(): void {
  const context: MatrixContext = JSON.parse(
    Buffer.from(process.env.PDPP_RELEASE_MATRIX_CONTEXT ?? "", "base64url").toString("utf8")
  );
  const row = NODE_MATRIX.find((candidate) => candidate.id === process.env.PDPP_RELEASE_MATRIX_ROW);
  assert.ok(row, "matrix row was not selected");
  assert.equal(process.version, row.nodeVersion, `matrix row ${row.id} escaped its Node runtime`);
  assert.equal(
    run("pnpm", ["--version"]).trim(),
    context.packageManager.version,
    "pnpm version drifted from packageManager"
  );
  const pnpmPath = run("sh", ["-lc", "command -v pnpm"]).trim();
  const pnpmRealpath = realpathSync(pnpmPath);
  const commands: RecordedCommand[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    PDPP_ARTIFACT_GIT_HEAD_SHA: context.headSha,
    PDPP_BUILD_TIMESTAMP: "2000-01-01T00:00:00.000Z",
  };

  runRecorded(
    commands,
    "pnpm",
    ["install", "--frozen-lockfile", "--ignore-scripts", "--offline", "--store-dir", "/pdpp-pnpm-store"],
    { env }
  );
  if (row.exactFloor) {
    runRecorded(commands, "pnpm", ["--filter", "@pdpp/cli", "run", "pack-install-run:node-22.14"], { env });
    runRecorded(commands, "pnpm", ["--filter", "@pdpp/read-core", "run", "verify:node-22.14"], { env });
  }
  for (const name of PACKAGE_NAMES) {
    runRecorded(commands, "pnpm", ["--filter", name, "run", "build"], { env });
  }

  const candidates: {
    contract: PackageContract;
    manifestSha256: string;
    name: string;
    source: { baseSha: string; headSha: string; sourceClosureSha256: string };
    tarball: { filename: string; files: string[]; sha256: string };
    version: string;
  }[] = [];
  const manifests = PACKAGE_NAMES.map((name) => packageManifest(name));
  const packRoot = resolve(".release-matrix/candidates");
  run("mkdir", ["-p", packRoot]);
  for (const manifest of manifests) {
    const cwd = resolve(packagePath(manifest.name));
    const packed = packJson(
      runRecorded(commands, "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], { cwd, env })
    );
    const tarballPath = join(packRoot, packed.filename);
    candidates.push({
      name: manifest.name,
      version: manifest.version,
      source: {
        baseSha: context.baseSha,
        headSha: context.headSha,
        sourceClosureSha256: context.sourceClosureSha256,
      },
      contract: {
        exportSubpaths: Object.keys(manifest.exports ?? {}).sort(compareStrings),
        bins: Object.keys(manifest.bin ?? {}).sort(compareStrings),
      },
      manifestSha256: sha256File(join(cwd, "package.json")),
      tarball: {
        filename: packed.filename,
        sha256: sha256File(tarballPath),
        files: packed.files.map(({ path }) => path).sort(compareStrings),
      },
    });
  }

  const consumer = resolve(".release-matrix/consumer");
  const consumerHome = resolve(".release-matrix/consumer-home");
  run("mkdir", ["-p", consumer, consumerHome]);
  const offlineEnv: NodeJS.ProcessEnv = {
    ...env,
    HOME: consumerHome,
    npm_config_cache: "/pdpp-npm-cache",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_update_notifier: "false",
  };
  runRecorded(commands, "npm", ["init", "--yes"], { cwd: consumer, env: offlineEnv });
  const candidatePathsByName = Object.fromEntries(
    candidates.map(({ name, tarball }) => [name, `file:${join(packRoot, tarball.filename)}`])
  );
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "pdpp-release-matrix-consumer",
        version: "0.0.0",
        private: true,
        overrides: {
          "@pdpp/mcp-server": {
            "@pdpp/cli": candidatePathsByName["@pdpp/cli"],
            "@pdpp/read-core": candidatePathsByName["@pdpp/read-core"],
          },
        },
      },
      null,
      2
    )}\n`
  );
  runRecorded(
    commands,
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--force",
      ...candidates.map(({ tarball }) => join(packRoot, tarball.filename)),
    ],
    {
      cwd: consumer,
      env: offlineEnv,
    }
  );
  const tree = JSON.parse(runRecorded(commands, "npm", ["ls", "--all", "--json"], { cwd: consumer, env: offlineEnv }));
  for (const candidate of candidates) {
    const installed = tree.dependencies?.[candidate.name];
    assert.equal(
      installed?.version,
      manifests.find(({ name }) => name === candidate.name)?.version,
      `consumer did not install ${candidate.name} candidate`
    );
    assert.equal(
      installed?.resolved,
      `file:${join(packRoot, candidate.tarball.filename)}`,
      `consumer did not resolve ${candidate.name} from its candidate tarball`
    );
  }
  const probePath = join(consumer, "candidate-probe.mjs");
  writeFileSync(probePath, consumerProbeSource(manifests));
  const probe = JSON.parse(runRecorded(commands, process.execPath, [probePath], { cwd: consumer, env: offlineEnv }));

  const receipt = {
    row,
    runtime: {
      nodeVersion: process.version,
      nodePath: process.execPath,
      npmVersion: run("npm", ["--version"]).trim(),
      npmPath: realpathSync(run("sh", ["-lc", "command -v npm"]).trim()),
    },
    packageManager: {
      path: pnpmPath,
      realpath: pnpmRealpath,
      sha256: sha256File(pnpmRealpath),
      version: context.packageManager.version,
      integrity: context.packageManager.integrity,
    },
    candidates,
    consumer: {
      network: "none",
      npmConfig: { offline: offlineEnv.npm_config_offline, registry: offlineEnv.npm_config_registry },
      tree,
      probe,
    },
    commands,
  };
  writeFileSync(join("/out", `${row.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

interface RowReceipt {
  candidates: {
    contract: PackageContract;
    manifestSha256: string;
    name: string;
    source: { baseSha: string; headSha: string; sourceClosureSha256: string };
    tarball: { filename: string; files: string[]; sha256: string };
    version: string;
  }[];
  commands: RecordedCommand[];
  consumer: {
    network: string;
    npmConfig: { offline: string | undefined; registry: string | undefined };
    probe: {
      bins: { bin: string; executable: string; helpSha256: string }[];
      name: string;
      resolutions: { exports: string[]; resolved: string; specifier: string }[];
      root: string;
    }[];
    tree: { dependencies?: Record<string, { resolved?: string; version?: string }> };
  };
  packageManager: { integrity: string; path: string; realpath: string; sha256: string; version: string };
  row: MatrixRow;
  runner: RunnerBinding;
  runtime: { nodePath: string; nodeVersion: string; npmPath: string; npmVersion: string };
}

function assertRowReceipt(
  rowReceipt: RowReceipt,
  snapshot: Snapshot,
  receiptRows: RowReceipt[],
  expectedContracts: PackageContractRecord[]
): void {
  const configured = NODE_MATRIX.find((row) => row.id === rowReceipt.row.id);
  assert.ok(configured, "receipt contains an unknown matrix row");
  assert.deepEqual(rowReceipt.row, configured, `receipt row ${configured.id} drifted`);
  assert.equal(
    rowReceipt.runner.tag,
    dockerImageTag(configured, snapshot.headSha),
    `receipt row ${configured.id} runner tag drifted`
  );
  assert.match(
    rowReceipt.runner.imageId,
    SHA256_DIGEST_PATTERN,
    `receipt row ${configured.id} must bind the built runner image`
  );
  assert.match(
    rowReceipt.runner.identity,
    HEX64_PATTERN,
    `receipt row ${configured.id} must bind the built runner identity`
  );
  assert.equal(
    rowReceipt.runtime.nodeVersion,
    configured.nodeVersion,
    `receipt row ${configured.id} has the wrong Node version`
  );
  assert.ok(
    rowReceipt.runtime.nodePath.startsWith("/"),
    `receipt row ${configured.id} must bind an absolute Node path`
  );
  assert.match(rowReceipt.runtime.npmVersion, SEMVER_PATTERN, `receipt row ${configured.id} must bind the npm version`);
  assert.ok(rowReceipt.runtime.npmPath.startsWith("/"), `receipt row ${configured.id} must bind an absolute npm path`);
  assert.equal(rowReceipt.packageManager.version, snapshot.packageManager.version, "receipt pnpm version drifted");
  assert.equal(
    rowReceipt.packageManager.integrity,
    snapshot.packageManager.integrity,
    "receipt pnpm integrity drifted"
  );
  assert.ok(rowReceipt.packageManager.path.startsWith("/"), "receipt must bind an absolute pnpm path");
  assert.equal(rowReceipt.packageManager.sha256, PNPM_ENTRYPOINT_SHA256, "receipt pnpm bytes drifted");
  assert.equal(rowReceipt.consumer.network, "none", "consumer must run with Docker networking disabled");
  assert.equal(rowReceipt.consumer.npmConfig.offline, "true", "consumer must use npm offline mode");
  assert.equal(
    rowReceipt.consumer.npmConfig.registry,
    "https://registry.npmjs.org",
    "consumer registry must match the prefetched npm cache identity"
  );
  assert.deepEqual(
    rowReceipt.candidates.map(({ name }) => name).sort(compareStrings),
    [...PACKAGE_NAMES].sort(compareStrings),
    "receipt candidate set drifted"
  );
  const peerRow = receiptRows.find(({ row }) => row.id !== configured.id);
  for (const candidate of rowReceipt.candidates) {
    const expected = expectedContracts.find(({ name }) => name === candidate.name);
    assert.ok(expected, `receipt candidate is not a published contract: ${candidate.name}`);
    assert.equal(candidate.version, expected.version, `${candidate.name} candidate version drifted`);
    assert.deepEqual(
      candidate.source,
      {
        baseSha: snapshot.baseSha,
        headSha: snapshot.headSha,
        sourceClosureSha256: snapshot.sourceClosure.sha256,
      },
      `${candidate.name} source provenance drifted`
    );
    assert.equal(candidate.manifestSha256, expected.manifestSha256, `${candidate.name} manifest drifted`);
    assert.deepEqual(candidate.contract, expected.contract, `${candidate.name} export/bin contract drifted`);
    assert.match(candidate.version, SEMVER_PATTERN, `${candidate.name} candidate version is missing`);
    assert.match(candidate.tarball.sha256, HEX64_PATTERN, `${candidate.name} tarball hash is missing`);
    assert.ok(Array.isArray(candidate.tarball.files), `${candidate.name} tarball file list is missing`);
    assert.deepEqual(
      candidate.tarball.files,
      [...candidate.tarball.files].sort(compareStrings),
      `${candidate.name} tarball file list ordering drifted`
    );
    assert.ok(candidate.tarball.files.length > 0, `${candidate.name} tarball file list is empty`);
    assert.equal(
      peerRow?.candidates.find(({ name }) => name === candidate.name)?.tarball.sha256,
      candidate.tarball.sha256,
      `${candidate.name} tarball hash drifted across runtime rows`
    );
  }
  const { dependencies } = rowReceipt.consumer.tree;
  assert.deepEqual(
    Object.keys(dependencies ?? {}).sort(compareStrings),
    [...PACKAGE_NAMES].sort(compareStrings),
    "consumer dependency tree drifted"
  );
  for (const candidate of rowReceipt.candidates) {
    const installed = dependencies?.[candidate.name];
    assert.equal(installed?.version, candidate.version, `consumer version drifted for ${candidate.name}`);
    assert.equal(
      installed?.resolved,
      `file:${join("/workspace/.release-matrix/candidates", candidate.tarball.filename)}`,
      `consumer source fallback drifted for ${candidate.name}`
    );
  }
  assert.deepEqual(
    rowReceipt.consumer.probe.map(({ name }) => name).sort(compareStrings),
    [...PACKAGE_NAMES].sort(compareStrings),
    "consumer export/bin probe package set drifted"
  );
  for (const probe of rowReceipt.consumer.probe) {
    const candidate = rowReceipt.candidates.find(({ name }) => name === probe.name);
    assert.ok(candidate, `consumer probe candidate is missing for ${probe.name}`);
    const { contract } = candidate;
    assert.ok(contract, `consumer contract is missing for ${probe.name}`);
    assert.equal(
      probe.root,
      join("node_modules", ...probe.name.split("/")),
      `consumer probe root drifted for ${probe.name}`
    );
    assert.deepEqual(
      contract.exportSubpaths,
      [...contract.exportSubpaths].sort(compareStrings),
      `consumer export contract ordering drifted for ${probe.name}`
    );
    assert.deepEqual(
      probe.resolutions.map(({ specifier }) => specifier).sort(compareStrings),
      contract.exportSubpaths
        .map((subpath) => (subpath === "." ? probe.name : `${probe.name}/${subpath.slice(2)}`))
        .sort(compareStrings),
      `consumer export probe drifted for ${probe.name}`
    );
    for (const resolution of probe.resolutions) {
      assert.ok(
        resolution.specifier === probe.name || resolution.specifier.startsWith(`${probe.name}/`),
        `consumer probe specifier drifted for ${probe.name}`
      );
      assert.ok(
        resolution.resolved.startsWith(`${probe.root}/`),
        `consumer probe escaped candidate package for ${probe.name}`
      );
      assert.ok(Array.isArray(resolution.exports), `consumer export surface is missing for ${resolution.specifier}`);
      assert.deepEqual(
        resolution.exports,
        [...resolution.exports].sort(compareStrings),
        `consumer export surface ordering drifted for ${resolution.specifier}`
      );
    }
    assert.deepEqual(
      probe.bins.map(({ bin }) => bin).sort(compareStrings),
      contract.bins,
      `consumer bin probe drifted for ${probe.name}`
    );
    for (const bin of probe.bins) {
      assert.ok(
        bin.executable.startsWith(`${probe.root}/`),
        `consumer bin escaped candidate package for ${probe.name}`
      );
      assert.match(bin.helpSha256, HEX64_PATTERN, `consumer bin proof is missing for ${bin.bin}`);
    }
  }
  assert.ok(rowReceipt.commands.length > 0, "receipt must bind executed commands");
  for (const command of rowReceipt.commands) {
    assert.equal(command.exitCode, 0, "receipt must bind successful command results");
    assert.match(command.resultSha256, HEX64_PATTERN, "receipt command result hash is missing");
  }
  const workspace = "/workspace";
  const consumer = `${workspace}/.release-matrix/consumer`;
  const candidatePaths = rowReceipt.candidates.map(
    ({ tarball }) => `${workspace}/.release-matrix/candidates/${tarball.filename}`
  );
  const expectedCommands = [
    {
      command: [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--offline",
        "--store-dir",
        "/pdpp-pnpm-store",
      ],
      cwd: workspace,
    },
    ...(configured.exactFloor
      ? [
          { command: ["pnpm", "--filter", "@pdpp/cli", "run", "pack-install-run:node-22.14"], cwd: workspace },
          { command: ["pnpm", "--filter", "@pdpp/read-core", "run", "verify:node-22.14"], cwd: workspace },
        ]
      : []),
    ...PACKAGE_NAMES.map((name) => ({ command: ["pnpm", "--filter", name, "run", "build"], cwd: workspace })),
    ...rowReceipt.candidates.map(({ name }) => ({
      command: [
        "npm",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        `${workspace}/.release-matrix/candidates`,
      ],
      cwd: `${workspace}/${packagePath(name)}`,
    })),
    { command: ["npm", "init", "--yes"], cwd: consumer },
    { command: ["npm", "install", "--ignore-scripts", "--offline", "--force", ...candidatePaths], cwd: consumer },
    { command: ["npm", "ls", "--all", "--json"], cwd: consumer },
    { command: [rowReceipt.runtime.nodePath, `${consumer}/candidate-probe.mjs`], cwd: consumer },
  ];
  assert.deepEqual(
    rowReceipt.commands.map(({ command, cwd }) => ({ command, cwd })),
    expectedCommands,
    "receipt runtime command sequence drifted"
  );
}

export interface Receipt {
  endSnapshot: Snapshot;
  receiptSha256: string;
  rows: RowReceipt[];
  runId: string;
  snapshot: Snapshot;
  version: number;
}

export function assertReceipt(receipt: Receipt, snapshot: Snapshot): void {
  assert.equal(receipt.version, RECEIPT_VERSION, "receipt version drifted");
  assert.equal(receipt.receiptSha256, receiptDigest(receipt), "receipt body mutated or digest mismatch");
  assert.deepEqual(receipt.snapshot, snapshot, "receipt base/head/source closure/package manager replayed or drifted");
  assert.deepEqual(receipt.endSnapshot, snapshot, "release matrix mutated or drifted after execution");
  assert.equal(receipt.rows.length, NODE_MATRIX.length, "receipt matrix row count drifted");
  const expectedContracts = packageContracts();
  for (const rowReceipt of receipt.rows) {
    assertRowReceipt(rowReceipt, snapshot, receipt.rows, expectedContracts);
  }
  assert.deepEqual(
    receipt.rows.map(({ row }) => row.id).sort(compareStrings),
    NODE_MATRIX.map(({ id }) => id).sort(compareStrings),
    "receipt matrix row set drifted"
  );
}

export function receiptDigest(receipt: Receipt): string {
  const { receiptSha256, ...body } = receipt;
  return sha256(JSON.stringify(body));
}

export function canonicalEvidence(receipt: Receipt): Omit<Receipt, "receiptSha256" | "runId"> {
  const { receiptSha256, runId, ...evidence } = receipt;
  return evidence;
}

export function assertReplayMatches(receipt: Receipt, replay: Omit<Receipt, "receiptSha256" | "runId">): void {
  assert.deepEqual(
    canonicalEvidence(receipt),
    replay,
    "receipt deterministic replay differs from the bound clean current head"
  );
}

function collectMatrixEvidence(snapshot: Snapshot): Omit<Receipt, "receiptSha256" | "runId"> {
  const temporary = mkdtempSync(join(tmpdir(), "pdpp-release-matrix-"));
  const output = join(temporary, "out");
  const runnerImages: string[] = [];
  try {
    run("mkdir", ["-p", output]);
    const rows: RowReceipt[] = [];
    for (const row of NODE_MATRIX) {
      const source = join(temporary, row.id);
      createSourceSnapshot(REPOSITORY_ROOT, source, snapshot.headSha);
      const runner = buildRunner(REPOSITORY_ROOT, row, snapshot);
      runnerImages.push(runner.tag);
      // The full closure inventory belongs in the outer receipt. Passing it as
      // an environment variable can exceed execve's argument limit on a real
      // repository, while the row only needs the package-manager and commit bindings.
      const encodedContext = Buffer.from(
        JSON.stringify({
          baseSha: snapshot.baseSha,
          headSha: snapshot.headSha,
          sourceClosureSha256: snapshot.sourceClosure.sha256,
          packageManager: snapshot.packageManager,
        })
      ).toString("base64url");
      run(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          `${process.getuid?.()}:${process.getgid?.()}`,
          "--workdir",
          "/workspace",
          "--volume",
          `${source}:/workspace:rw`,
          "--volume",
          `${output}:/out:rw`,
          "--env",
          `PDPP_RELEASE_MATRIX_CONTEXT=${encodedContext}`,
          "--env",
          `PDPP_RELEASE_MATRIX_ROW=${row.id}`,
          runner.tag,
          "node",
          "--import",
          "tsx",
          "scripts/release-package-matrix.ts",
          "--row",
        ],
        { stdio: "inherit" }
      );
      rows.push({
        ...JSON.parse(readFileSync(join(output, `${row.id}.json`), "utf8")),
        runner,
      });
    }
    const endSnapshot = currentSnapshot();
    return { version: RECEIPT_VERSION, snapshot, endSnapshot, rows };
  } finally {
    for (const image of runnerImages) {
      try {
        run("docker", ["image", "rm", "--force", image]);
      } catch {
        /* temporary image cleanup is best-effort */
      }
    }
    rmSync(temporary, { force: true, recursive: true });
  }
}

function runMatrix(receiptFile?: string): void {
  const snapshot = currentSnapshot();
  const receipt: Receipt = { ...collectMatrixEvidence(snapshot), runId: randomUUID(), receiptSha256: "" };
  receipt.receiptSha256 = receiptDigest(receipt);
  assertReceipt(receipt, snapshot);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptFile) {
    const path = resolve(receiptFile);
    writeFileSync(path, serialized);
    process.stdout.write(`Release matrix receipt: ${path}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

function verifyReceipt(file: string | undefined): void {
  assert.ok(file, "usage: release-package-matrix.ts --verify-receipt <file>");
  const snapshot = currentSnapshot();
  const receipt: Receipt = JSON.parse(readFileSync(resolve(file), "utf8"));
  assertReceipt(receipt, snapshot);
  const replay = collectMatrixEvidence(snapshot);
  assertReplayMatches(receipt, replay);
  process.stdout.write(`Release matrix receipt replay is current: ${receipt.runId}\n`);
}

// pnpm's shorthand script form can forward a separator before its arguments.
// Treat it as transport syntax, not a matrix argument, so the documented
// `pnpm ... release:matrix -- --receipt <path>` interface remains stable.
const matrixArguments = process.argv.slice(2).filter((argument) => argument !== "--");

if (matrixArguments[0] === "--row") {
  runMatrixRow();
} else if (matrixArguments[0] === "--verify-receipt") {
  verifyReceipt(matrixArguments[1]);
} else if (matrixArguments[0] === "--receipt") {
  assert.ok(matrixArguments[1], "usage: release-package-matrix.ts --receipt <file>");
  runMatrix(matrixArguments[1]);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMatrix();
}
