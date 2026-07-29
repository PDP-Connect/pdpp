// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";

export const NODE_22_14_VERSION = "v22.14.0";

export function bindNodeEnvironment(baseEnv: NodeJS.ProcessEnv, execPath: string): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(execPath);
  return {
    ...baseEnv,
    PATH: [nodeDirectory, baseEnv.PATH].filter(Boolean).join(delimiter),
  };
}

interface NodeProbe {
  file: string;
  script: string;
}

export function createNodeProbe(tempRoot: string): NodeProbe {
  const file = join(tempRoot, "node-subprocesses.ndjson");
  const script = join(tempRoot, "node-subprocess-probe.cjs");
  writeFileSync(
    script,
    "const { appendFileSync } = require('node:fs');\n" +
      "appendFileSync(process.env.PDPP_ARTIFACT_NODE_PROBE_FILE, JSON.stringify({ label: process.env.PDPP_ARTIFACT_SUBPROCESS_LABEL || 'unlabeled', version: process.version, execPath: process.execPath }) + '\\n');\n"
  );
  return { file, script };
}

export function addNodeProbeToEnvironment(baseEnv: NodeJS.ProcessEnv, probe: NodeProbe): NodeJS.ProcessEnv {
  const requireOption = `--require=${probe.script}`;
  const nodeOptions = baseEnv.NODE_OPTIONS ?? "";
  return {
    ...baseEnv,
    NODE_OPTIONS: nodeOptions.includes(requireOption)
      ? nodeOptions
      : [nodeOptions, requireOption].filter(Boolean).join(" "),
    PDPP_ARTIFACT_NODE_PROBE_FILE: probe.file,
    PDPP_ARTIFACT_NODE_PROBE_SCRIPT: probe.script,
  };
}

export function labelChildEnvironment(baseEnv: NodeJS.ProcessEnv, label: string): NodeJS.ProcessEnv {
  return { ...baseEnv, PDPP_ARTIFACT_SUBPROCESS_LABEL: label };
}

interface NodeProbeResult {
  execPath: string;
  label: string;
  version: string;
}

export function readNodeProbe(file: string): NodeProbeResult[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NodeProbeResult);
}

function packageFiles(packageRoot: string): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  visit(packageRoot);
  return files;
}

export function packageContentSha256(packageRoot: string): string {
  const hash = createHash("sha256");
  for (const path of packageFiles(packageRoot)) {
    const name = relative(packageRoot, path);
    const contents = readFileSync(path);
    hash.update(name);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function gitHeadSha(packageRoot: string): string {
  const boundHead = process.env.PDPP_ARTIFACT_GIT_HEAD_SHA;
  if (boundHead) {
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(boundHead, /^[a-f0-9]{40}$/, "PDPP_ARTIFACT_GIT_HEAD_SHA must bind one full commit SHA");
    return boundHead;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
}

interface AssertArtifactReceiptOptions {
  gitHeadSha?: string;
  nodeExecPath?: string;
  nodeVersion?: string;
  packageContentSha256?: string;
  tarballSha256?: string;
}

interface ArtifactReceipt {
  environment?: Record<string, unknown>;
  gitHeadSha: string;
  nodeExecPath: string;
  nodeVersion: string;
  packageContentSha256: string;
  subprocesses: NodeProbeResult[];
  tarballSha256?: string;
}

export function assertArtifactReceipt(
  receipt: unknown,
  expected: AssertArtifactReceiptOptions = {}
): asserts receipt is ArtifactReceipt {
  const r = receipt as ArtifactReceipt;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
  assert.equal(typeof r?.nodeVersion, "string", "receipt must record its Node version");
  if (expected.nodeVersion) {
    assert.equal(r.nodeVersion, expected.nodeVersion);
  }
  if (expected.nodeExecPath) {
    assert.equal(r.nodeExecPath, expected.nodeExecPath, "receipt Node executable binding changed");
  }
  if (expected.gitHeadSha) {
    assert.equal(r.gitHeadSha, expected.gitHeadSha, "receipt revision binding changed");
  }
  if (expected.packageContentSha256) {
    assert.equal(r.packageContentSha256, expected.packageContentSha256, "receipt content binding changed");
  }
  if (expected.tarballSha256) {
    assert.equal(r.tarballSha256, expected.tarballSha256, "receipt tarball binding changed");
  }

  assert.ok(Array.isArray(r.subprocesses), "receipt must record Node subprocesses");
  assert.ok(r.subprocesses.length > 0, "receipt must record at least one Node subprocess");
  if (expected.nodeVersion) {
    for (const subprocess of r.subprocesses) {
      assert.equal(
        subprocess.version,
        expected.nodeVersion,
        `subprocess ${subprocess.label} escaped the pinned Node runtime`
      );
      if (expected.nodeExecPath) {
        assert.equal(
          subprocess.execPath,
          expected.nodeExecPath,
          `subprocess ${subprocess.label} escaped the bound Node executable`
        );
      }
    }
  }
}
