// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

export const NODE_22_14_VERSION = 'v22.14.0';

export function bindNodeEnvironment(baseEnv, execPath) {
  const nodeDirectory = dirname(execPath);
  return {
    ...baseEnv,
    PATH: [nodeDirectory, baseEnv.PATH].filter(Boolean).join(delimiter),
  };
}

export function createNodeProbe(tempRoot) {
  const file = join(tempRoot, 'node-subprocesses.ndjson');
  const script = join(tempRoot, 'node-subprocess-probe.cjs');
  writeFileSync(
    script,
    "const { appendFileSync } = require('node:fs');\n" +
      "appendFileSync(process.env.PDPP_ARTIFACT_NODE_PROBE_FILE, JSON.stringify({ label: process.env.PDPP_ARTIFACT_SUBPROCESS_LABEL || 'unlabeled', version: process.version, execPath: process.execPath }) + '\\n');\n",
  );
  return { file, script };
}

export function addNodeProbeToEnvironment(baseEnv, probe) {
  const requireOption = `--require=${probe.script}`;
  const nodeOptions = baseEnv.NODE_OPTIONS ?? '';
  return {
    ...baseEnv,
    NODE_OPTIONS: nodeOptions.includes(requireOption) ? nodeOptions : [nodeOptions, requireOption].filter(Boolean).join(' '),
    PDPP_ARTIFACT_NODE_PROBE_FILE: probe.file,
    PDPP_ARTIFACT_NODE_PROBE_SCRIPT: probe.script,
  };
}

export function labelChildEnvironment(baseEnv, label) {
  return { ...baseEnv, PDPP_ARTIFACT_SUBPROCESS_LABEL: label };
}

export function readNodeProbe(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function packageFiles(packageRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
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

export function packageContentSha256(packageRoot) {
  const hash = createHash('sha256');
  for (const path of packageFiles(packageRoot)) {
    const name = relative(packageRoot, path);
    const contents = readFileSync(path);
    hash.update(name);
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function gitHeadSha(packageRoot) {
  const boundHead = process.env.PDPP_ARTIFACT_GIT_HEAD_SHA;
  if (boundHead) {
    assert.match(boundHead, /^[a-f0-9]{40}$/, 'PDPP_ARTIFACT_GIT_HEAD_SHA must bind one full commit SHA');
    return boundHead;
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
}

export function assertArtifactReceipt(receipt, expected = {}) {
  assert.equal(typeof receipt?.nodeVersion, 'string', 'receipt must record its Node version');
  if (expected.nodeVersion) assert.equal(receipt.nodeVersion, expected.nodeVersion);
  if (expected.nodeExecPath) assert.equal(receipt.nodeExecPath, expected.nodeExecPath, 'receipt Node executable binding changed');
  if (expected.gitHeadSha) assert.equal(receipt.gitHeadSha, expected.gitHeadSha, 'receipt revision binding changed');
  if (expected.packageContentSha256) {
    assert.equal(receipt.packageContentSha256, expected.packageContentSha256, 'receipt content binding changed');
  }
  if (expected.tarballSha256) {
    assert.equal(receipt.tarballSha256, expected.tarballSha256, 'receipt tarball binding changed');
  }

  assert.ok(Array.isArray(receipt.subprocesses), 'receipt must record Node subprocesses');
  assert.ok(receipt.subprocesses.length > 0, 'receipt must record at least one Node subprocess');
  if (expected.nodeVersion) {
    for (const subprocess of receipt.subprocesses) {
      assert.equal(
        subprocess.version,
        expected.nodeVersion,
        `subprocess ${subprocess.label} escaped the pinned Node runtime`,
      );
      if (expected.nodeExecPath) {
        assert.equal(
          subprocess.execPath,
          expected.nodeExecPath,
          `subprocess ${subprocess.label} escaped the bound Node executable`,
        );
      }
    }
  }
}
