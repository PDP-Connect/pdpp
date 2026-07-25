// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertReceipt,
  assertReplayMatches,
  assertRepositoryRuntimeConfiguration,
  type MatrixRow,
  NODE_MATRIX,
  PACKAGE_NAMES,
  type Receipt,
  receiptDigest,
  type Snapshot,
} from "./release-package-matrix.ts";

const snapshot: Snapshot = {
  baseSha: "base",
  headSha: "head",
  sourceClosure: { files: ["package.json"], sha256: "closure" },
  packageManager: { name: "pnpm", version: "10.33.0", integrity: "sha512-test" },
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REPLAYED_OR_DRIFTED_PATTERN = /replayed or drifted/;
const MUTATED_OR_DRIFTED_PATTERN = /mutated or drifted/;
const DRIFTED_PATTERN = /drifted/;
const PNPM_VERSION_DRIFTED_PATTERN = /pnpm version drifted/;
const NETWORKING_DISABLED_PATTERN = /networking disabled/;
const TARBALL_HASH_PATTERN = /tarball hash/;
const ACROSS_RUNTIME_ROWS_PATTERN = /across runtime rows/;
const PNPM_BYTES_DRIFTED_PATTERN = /pnpm bytes drifted/;
const PROBE_PACKAGE_SET_DRIFTED_PATTERN = /probe package set drifted/;
const EXPORT_PROBE_DRIFTED_PATTERN = /export probe drifted/;
const BIN_PROBE_DRIFTED_PATTERN = /bin probe drifted/;
const EXPORT_BIN_CONTRACT_DRIFTED_PATTERN = /export\/bin contract drifted/;
const EXECUTED_COMMANDS_PATTERN = /executed commands/;
const COMMAND_SEQUENCE_OR_SUCCESS_PATTERN = /(command sequence drifted|must bind successful command results)/;
const DIGEST_MISMATCH_PATTERN = /digest mismatch/;
const DETERMINISTIC_REPLAY_DIFFERS_PATTERN = /deterministic replay differs/;
const DOCKERFILE_NODE_BASE_PATTERN = /Dockerfile Node base/;
const MUST_MATCH_NVMRC_PATTERN = /must match \.nvmrc/;
const DOCKERFILE_PNPM_VERSION_PATTERN = /Dockerfile pnpm version/;
const PNPM_INTEGRITY_PATTERN = /pnpm integrity/;
const COREPACK_MESSAGE_PATTERN = /Corepack/;

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function candidateContract(name: string) {
  const manifestPath = join(repositoryRoot, "packages", name.slice("@pdpp/".length), "package.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  return {
    name,
    version: manifest.version as string,
    contract: {
      exportSubpaths: (Object.keys(manifest.exports ?? {}) as string[]).sort(compareStrings),
      bins: (Object.keys(manifest.bin ?? {}) as string[]).sort(compareStrings),
    },
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

function buildRow(matrixRow: MatrixRow): Receipt["rows"][number] {
  const candidates = PACKAGE_NAMES.map((name, index) => ({
    ...candidateContract(name),
    source: {
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      sourceClosureSha256: snapshot.sourceClosure.sha256,
    },
    tarball: {
      filename: `${name.slice("@pdpp/".length)}-0.0.0.tgz`,
      sha256: String.fromCharCode(98 + index).repeat(64),
      files: ["package.json"],
    },
  }));
  const commands: { command: string[]; cwd: string }[] = [
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
      cwd: "/workspace",
    },
    ...PACKAGE_NAMES.map((name) => ({ command: ["pnpm", "--filter", name, "run", "build"], cwd: "/workspace" })),
    ...candidates.map(({ name }) => ({
      command: [
        "npm",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        "/workspace/.release-matrix/candidates",
      ],
      cwd: `/workspace/packages/${name.slice("@pdpp/".length)}`,
    })),
    { command: ["npm", "init", "--yes"], cwd: "/workspace/.release-matrix/consumer" },
    {
      command: [
        "npm",
        "install",
        "--ignore-scripts",
        "--offline",
        "--force",
        ...candidates.map(({ tarball }) => `/workspace/.release-matrix/candidates/${tarball.filename}`),
      ],
      cwd: "/workspace/.release-matrix/consumer",
    },
    { command: ["npm", "ls", "--all", "--json"], cwd: "/workspace/.release-matrix/consumer" },
    {
      command: ["/usr/local/bin/node", "/workspace/.release-matrix/consumer/candidate-probe.mjs"],
      cwd: "/workspace/.release-matrix/consumer",
    },
  ];
  if (matrixRow.exactFloor) {
    commands.splice(
      1,
      0,
      { command: ["pnpm", "--filter", "@pdpp/cli", "run", "pack-install-run:node-22.14"], cwd: "/workspace" },
      { command: ["pnpm", "--filter", "@pdpp/read-core", "run", "verify:node-22.14"], cwd: "/workspace" }
    );
  }
  const recordedCommands = commands.map((command) => ({
    ...command,
    exitCode: 0,
    resultSha256: "a".repeat(64),
  }));
  return {
    row: matrixRow,
    runner: {
      tag: `pdpp-release-matrix-${matrixRow.id}-head`,
      imageId: `sha256:${"c".repeat(64)}`,
      identity: "f".repeat(64),
    },
    runtime: {
      nodeVersion: matrixRow.nodeVersion,
      nodePath: "/usr/local/bin/node",
      npmVersion: "10.9.2",
      npmPath: "/usr/local/bin/npm",
    },
    packageManager: {
      path: "/usr/local/bin/pnpm",
      realpath: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
      sha256: "b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9",
      version: "10.33.0",
      integrity: "sha512-test",
    },
    candidates,
    consumer: {
      network: "none",
      npmConfig: { offline: "true", registry: "https://registry.npmjs.org" },
      tree: {
        dependencies: Object.fromEntries(
          candidates.map((candidate) => [
            candidate.name,
            {
              version: candidate.version,
              resolved: `file:/workspace/.release-matrix/candidates/${candidate.tarball.filename}`,
            },
          ])
        ),
      },
      probe: candidates.map((candidate) => ({
        name: candidate.name,
        root: `node_modules/${candidate.name}`,
        resolutions: candidate.contract.exportSubpaths.map((subpath) => ({
          specifier: subpath === "." ? candidate.name : `${candidate.name}/${subpath.slice(2)}`,
          resolved: `node_modules/${candidate.name}/dist/index.js`,
          exports: [] as string[],
        })),
        bins: candidate.contract.bins.map((bin) => ({
          bin,
          executable: `node_modules/${candidate.name}/dist/bin/${bin}.js`,
          helpSha256: "e".repeat(64),
        })),
      })),
    },
    commands: recordedCommands,
  };
}

function buildReceipt(): Receipt {
  const value = { version: 2, snapshot, endSnapshot: snapshot, rows: NODE_MATRIX.map(buildRow), runId: "test-run" };
  return { ...value, receiptSha256: receiptDigest(value as Receipt) };
}

function reseal(value: Receipt): void {
  value.receiptSha256 = receiptDigest(value);
}

test("receipt accepts the complete pinned matrix", () => {
  assert.doesNotThrow(() => assertReceipt(buildReceipt(), snapshot));
});

test("receipt rejects source-closure replay or mutation", () => {
  const value = buildReceipt();
  value.snapshot = { ...snapshot, sourceClosure: { ...snapshot.sourceClosure, sha256: "replayed" } };
  reseal(value);
  assert.throws(() => assertReceipt(value, snapshot), REPLAYED_OR_DRIFTED_PATTERN);
  const mutated = buildReceipt();
  mutated.endSnapshot = { ...snapshot, headSha: "mutated" };
  reseal(mutated);
  assert.throws(() => assertReceipt(mutated, snapshot), MUTATED_OR_DRIFTED_PATTERN);
});

test("receipt rejects image, package-manager, consumer, and tarball drift", () => {
  const image = buildReceipt();
  const [firstImageRow] = image.rows;
  assert.ok(firstImageRow);
  firstImageRow.row = { ...firstImageRow.row, image: "node:latest" };
  reseal(image);
  assert.throws(() => assertReceipt(image, snapshot), DRIFTED_PATTERN);

  const manager = buildReceipt();
  const [firstManagerRow] = manager.rows;
  assert.ok(firstManagerRow);
  firstManagerRow.packageManager.version = "10.34.0";
  reseal(manager);
  assert.throws(() => assertReceipt(manager, snapshot), PNPM_VERSION_DRIFTED_PATTERN);

  const network = buildReceipt();
  const [firstNetworkRow] = network.rows;
  assert.ok(firstNetworkRow);
  firstNetworkRow.consumer.network = "bridge";
  reseal(network);
  assert.throws(() => assertReceipt(network, snapshot), NETWORKING_DISABLED_PATTERN);

  const tarball = buildReceipt();
  const [firstTarballRow] = tarball.rows;
  assert.ok(firstTarballRow?.candidates[0]);
  firstTarballRow.candidates[0].tarball.sha256 = "not-a-hash";
  reseal(tarball);
  assert.throws(() => assertReceipt(tarball, snapshot), TARBALL_HASH_PATTERN);

  const tarballReplay = buildReceipt();
  const [firstTarballReplayRow] = tarballReplay.rows;
  assert.ok(firstTarballReplayRow?.candidates[0]);
  firstTarballReplayRow.candidates[0].tarball.sha256 = "f".repeat(64);
  reseal(tarballReplay);
  assert.throws(() => assertReceipt(tarballReplay, snapshot), ACROSS_RUNTIME_ROWS_PATTERN);

  const pnpmBytes = buildReceipt();
  const [firstPnpmBytesRow] = pnpmBytes.rows;
  assert.ok(firstPnpmBytesRow);
  firstPnpmBytesRow.packageManager.sha256 = "f".repeat(64);
  reseal(pnpmBytes);
  assert.throws(() => assertReceipt(pnpmBytes, snapshot), PNPM_BYTES_DRIFTED_PATTERN);

  const probe = buildReceipt();
  const [firstProbeRow] = probe.rows;
  assert.ok(firstProbeRow);
  firstProbeRow.consumer.probe = [];
  reseal(probe);
  assert.throws(() => assertReceipt(probe, snapshot), PROBE_PACKAGE_SET_DRIFTED_PATTERN);

  const exportProbe = buildReceipt();
  const [firstExportProbeRow] = exportProbe.rows;
  assert.ok(firstExportProbeRow);
  assert.ok(firstExportProbeRow.consumer.probe[0]);
  firstExportProbeRow.consumer.probe[0].resolutions = [];
  reseal(exportProbe);
  assert.throws(() => assertReceipt(exportProbe, snapshot), EXPORT_PROBE_DRIFTED_PATTERN);

  const binProbe = buildReceipt();
  const [firstBinProbeRow] = binProbe.rows;
  assert.ok(firstBinProbeRow);
  assert.ok(firstBinProbeRow.consumer.probe[0]);
  firstBinProbeRow.consumer.probe[0].bins = [];
  reseal(binProbe);
  assert.throws(() => assertReceipt(binProbe, snapshot), BIN_PROBE_DRIFTED_PATTERN);

  const contractAndProbe = buildReceipt();
  const [firstContractAndProbeRow] = contractAndProbe.rows;
  assert.ok(firstContractAndProbeRow?.candidates[0] && firstContractAndProbeRow.consumer.probe[0]);
  firstContractAndProbeRow.candidates[0].contract.bins = [];
  firstContractAndProbeRow.consumer.probe[0].bins = [];
  reseal(contractAndProbe);
  assert.throws(() => assertReceipt(contractAndProbe, snapshot), EXPORT_BIN_CONTRACT_DRIFTED_PATTERN);

  const command = buildReceipt();
  const [firstCommandRow] = command.rows;
  assert.ok(firstCommandRow);
  firstCommandRow.commands = [];
  reseal(command);
  assert.throws(() => assertReceipt(command, snapshot), EXECUTED_COMMANDS_PATTERN);

  const commandOrder = buildReceipt();
  const [firstCommandOrderRow] = commandOrder.rows;
  assert.ok(firstCommandOrderRow);
  firstCommandOrderRow.commands.push({
    command: ["echo", "unbound"],
    cwd: "/workspace",
    exitCode: 0,
    resultSha256: "a".repeat(64),
  });
  reseal(commandOrder);
  assert.throws(() => assertReceipt(commandOrder, snapshot), COMMAND_SEQUENCE_OR_SUCCESS_PATTERN);

  const digest = buildReceipt();
  const [firstDigestRow] = digest.rows;
  assert.ok(firstDigestRow);
  firstDigestRow.consumer.network = "bridge";
  assert.throws(() => assertReceipt(digest, snapshot), DIGEST_MISMATCH_PATTERN);
});

test("replay comparison rejects resealed command, runtime, file-list, and cross-row tarball forgeries", () => {
  const expected = buildReceipt();

  const command = buildReceipt();
  const [firstCommandRow] = command.rows;
  assert.ok(firstCommandRow?.commands[0]);
  firstCommandRow.commands[0].resultSha256 = "f".repeat(64);
  reseal(command);
  assert.throws(() => assertReplayMatches(command, expected), DETERMINISTIC_REPLAY_DIFFERS_PATTERN);

  const runtime = buildReceipt();
  const [firstRuntimeRow] = runtime.rows;
  assert.ok(firstRuntimeRow);
  firstRuntimeRow.runtime.npmVersion = "99.99.99";
  reseal(runtime);
  assert.throws(() => assertReplayMatches(runtime, expected), DETERMINISTIC_REPLAY_DIFFERS_PATTERN);

  const fileList = buildReceipt();
  const [firstFileListRow] = fileList.rows;
  assert.ok(firstFileListRow?.candidates[0]);
  firstFileListRow.candidates[0].tarball.files = ["forged.js"];
  reseal(fileList);
  assert.throws(() => assertReplayMatches(fileList, expected), DETERMINISTIC_REPLAY_DIFFERS_PATTERN);

  const tarball = buildReceipt();
  for (const matrixRow of tarball.rows) {
    const [firstCandidate] = matrixRow.candidates;
    assert.ok(firstCandidate);
    firstCandidate.tarball.sha256 = "f".repeat(64);
  }
  reseal(tarball);
  assert.throws(() => assertReplayMatches(tarball, expected), DETERMINISTIC_REPLAY_DIFFERS_PATTERN);
});

test("repository Docker runtime must stay digest- and package-manager-pinned", () => {
  const dockerfile = [
    "ARG NODE_VERSION=25.8.2-bookworm-slim@sha256:71be4054ee7a5fc8d0b2a66060705988b09a782025d70ba9318b29ff1a931fc0",
    "ARG PNPM_VERSION=10.33.0",
    "ARG PNPM_INTEGRITY=sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Dockerfile shell `${PNPM_VERSION}` variable expansion, not JS interpolation.
    'RUN npm pack --ignore-scripts --loglevel=error --pack-destination /tmp "pnpm@${PNPM_VERSION}" && pnpm integrity drift',
  ].join("\n");
  assert.deepEqual(
    assertRepositoryRuntimeConfiguration({ dockerfile, nvmrc: "v25.8.2\n", packageManager: "pnpm@10.33.0" }),
    {
      name: "pnpm",
      version: "10.33.0",
      integrity: "sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==",
    }
  );
  assert.throws(
    () =>
      assertRepositoryRuntimeConfiguration({
        dockerfile: dockerfile.replace("71be", "dead"),
        nvmrc: "v25.8.2",
        packageManager: "pnpm@10.33.0",
      }),
    DOCKERFILE_NODE_BASE_PATTERN
  );
  assert.throws(
    () => assertRepositoryRuntimeConfiguration({ dockerfile, nvmrc: "v25.8.3", packageManager: "pnpm@10.33.0" }),
    MUST_MATCH_NVMRC_PATTERN
  );
  assert.throws(
    () => assertRepositoryRuntimeConfiguration({ dockerfile, nvmrc: "v25.8.2", packageManager: "pnpm@10.34.0" }),
    DOCKERFILE_PNPM_VERSION_PATTERN
  );
  assert.throws(
    () =>
      assertRepositoryRuntimeConfiguration({
        dockerfile: dockerfile.replace("EFaL", "dead"),
        nvmrc: "v25.8.2",
        packageManager: "pnpm@10.33.0",
      }),
    PNPM_INTEGRITY_PATTERN
  );
  assert.throws(
    () =>
      assertRepositoryRuntimeConfiguration({
        dockerfile: `${dockerfile}\nRUN npm install -g corepack`,
        nvmrc: "v25.8.2",
        packageManager: "pnpm@10.33.0",
      }),
    COREPACK_MESSAGE_PATTERN
  );
});
