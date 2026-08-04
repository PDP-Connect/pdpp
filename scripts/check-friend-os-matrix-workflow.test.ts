#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards findWorkflowDocBindingIssues against synthetic fixtures (so a real
// drift case is provable without editing the live workflow/doc), then
// asserts the live friend-os-matrix.yml currently agrees with the live
// docs/operator/selfhost-quickstart.md.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findWorkflowDocBindingIssues } from "./check-friend-os-matrix-workflow.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STABLE_RELEASE_BUNDLE_URL = "https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml";

const VALID_WORKFLOW = `on:
  pull_request:
    paths:
      - ".github/workflows/friend-os-matrix.yml"
      - ".github/workflows/semantic-release.yml"
      - "package.json"
      - "pnpm-lock.yaml"
      - "apps/site/**"
      - "deploy/docker/**"
      - "docs/operator/selfhost-quickstart.md"
      - "docs/operator/friend-journey-acceptance.md"
      - "docs/operator/hosted-mcp-setup.md"
      - "docs/operator/self-service-gmail-mcp.md"
      - "reference-implementation/README.md"
      - "scripts/extract-doc-command-block.ts"
      - "scripts/extract-doc-command-block.test.ts"
      - "scripts/generate-selfhost-bundle.ts"
      - "scripts/generate-selfhost-bundle.test.ts"
      - "scripts/check-docker-release-matrix.ts"
      - "scripts/check-docker-release-matrix.test.ts"
      - "scripts/verify-published-docker-images.ts"
      - "scripts/verify-selfhost-bundle-published.ts"
      - "scripts/verify-selfhost-bundle-published.test.ts"
      - "scripts/publish-selfhost-bundle-asset.ts"
      - "scripts/publish-selfhost-bundle-asset.test.ts"
      - "scripts/check-friend-journey-acceptance.ts"
      - "scripts/check-friend-os-matrix-workflow.ts"
      - "scripts/check-friend-os-matrix-workflow.test.ts"
      - "scripts/friend-os-matrix/**"
      - "scripts/friend-journey-acceptance/**"

permissions:
  contents: read

workflow_run:
  workflows: ["semantic-release"]
  types: [completed]
  branches: [main]

jobs:
  extract-doc-commands:
    name: extract documented commands (once, shared across OSes and modes)
    runs-on: ubuntu-latest
    steps:
      - name: Install frozen dependencies
        run: pnpm install --frozen-lockfile

      - name: Run friend-readiness tests
        run: |
          set -euo pipefail
          pnpm docker:release-matrix:check
          pnpm docker:release-matrix:check:test
          node --test --import tsx scripts/check-friend-os-matrix-workflow.test.ts
          node --test --import tsx scripts/extract-doc-command-block.test.ts
          pnpm docker:release-bundle:test
          pnpm docker:release-bundle:verify-published:test
          pnpm docker:release-bundle:publish-asset:test
          pnpm --filter @pdpp/mcp-server build
          pnpm --filter pdpp-site test
          pnpm friend-journey:acceptance:test

      - name: Extract the exact documented command blocks
        id: extract
        run: |
          echo "posix_secret_block<<POSIX_EOF"
          echo "POSIX_EOF"

  prerelease-validate:
    name: prerelease candidate validation
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - name: Probe for a usable Linux container daemon
        id: docker_probe
        shell: bash
        run: docker info --format 'OSType'
`;

const SH_FETCH_BLOCK = ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${STABLE_RELEASE_BUNDLE_URL}`, "```"].join("\n");
const POWERSHELL_FETCH_BLOCK = [
  "```powershell",
  "mkdir pdpp; cd pdpp",
  `curl.exe -fsSLO ${STABLE_RELEASE_BUNDLE_URL}`,
  "```",
].join("\n");

const VALID_DOC = `# Friend Self-Host Quickstart

### Prerequisites

#### macOS and Linux (bash or zsh):

${SH_FETCH_BLOCK}

#### Windows PowerShell (the block above cannot work there

${POWERSHELL_FETCH_BLOCK}

### 1. Fetch the released compose bundle

${SH_FETCH_BLOCK}

On **Windows PowerShell**, bare

${POWERSHELL_FETCH_BLOCK}
`;

const DROPPED_OS_PATTERN = /no longer runs on "windows-latest"/;
const MISSING_DOC_ANCHOR_PATTERN = /missing from docs\/operator\/selfhost-quickstart\.md/;
const MISSING_DOCKER_PROBE_PATTERN = /no longer probes for a real Linux container daemon/;
const MISSING_SH_FETCH_URL_PATTERN = /missing the sh Compose-fetch URL/;
const MISSING_POWERSHELL_FETCH_URL_PATTERN = /missing the powershell Compose-fetch URL/;
const SH_NOT_STABLE_URL_PATTERN = /sh fetch URL .* is not the one stable release-asset URL/;
const POWERSHELL_NOT_STABLE_URL_PATTERN = /powershell fetch URL .* is not the one stable release-asset URL/;
const MISSING_TEST_STEP_PATTERN = /missing the 'Run friend-readiness-tests' step/;
const MISSING_TEST_COMMAND_PATTERN = /test step is not running/;

test("findWorkflowDocBindingIssues is silent when workflow and doc agree", () => {
  assert.deepEqual(findWorkflowDocBindingIssues(VALID_WORKFLOW, VALID_DOC), []);
});

test("findWorkflowDocBindingIssues reports a dropped OS from the matrix", () => {
  const workflow = VALID_WORKFLOW.replace(
    "os: [ubuntu-latest, macos-latest, windows-latest]",
    "os: [ubuntu-latest, macos-latest]"
  );
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  const hasDroppedOs = findings.some((f) => DROPPED_OS_PATTERN.test(f.detail));
  assert.ok(hasDroppedOs, "should report dropped OS");
});

test("findWorkflowDocBindingIssues reports a renamed doc anchor the workflow still depends on", () => {
  const doc = VALID_DOC.replace("macOS and Linux (bash or zsh):", "macOS and Linux, bash or zsh:");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  const hasMissingAnchor = findings.some((f) => MISSING_DOC_ANCHOR_PATTERN.test(f.detail));
  assert.ok(hasMissingAnchor, "should report missing doc anchor");
});

test("findWorkflowDocBindingIssues reports a dropped Docker-daemon probe", () => {
  const workflow = VALID_WORKFLOW.replace("docker info --format", "");
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  const hasMissingProbe = findings.some((f) => MISSING_DOCKER_PROBE_PATTERN.test(f.detail));
  assert.ok(hasMissingProbe, "should report missing docker daemon probe");
});

test("findWorkflowDocBindingIssues reports a missing sh Compose-fetch URL", () => {
  const doc = VALID_DOC.replace(SH_FETCH_BLOCK, "");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  const hasMissingUrl = findings.some((f) => MISSING_SH_FETCH_URL_PATTERN.test(f.detail));
  assert.ok(hasMissingUrl, "should report missing sh compose-fetch URL");
});

test("findWorkflowDocBindingIssues reports a missing powershell Compose-fetch URL", () => {
  const doc = VALID_DOC.replace(POWERSHELL_FETCH_BLOCK, "");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  const hasMissingUrl = findings.some((f) => MISSING_POWERSHELL_FETCH_URL_PATTERN.test(f.detail));
  assert.ok(hasMissingUrl, "should report missing powershell compose-fetch URL");
});

test("findWorkflowDocBindingIssues reports the sh fetch URL drifting off the stable release URL", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = VALID_DOC.replace(
    SH_FETCH_BLOCK,
    ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  const hasDriftedUrl = findings.some((f) => SH_NOT_STABLE_URL_PATTERN.test(f.detail));
  assert.ok(hasDriftedUrl, "should report sh fetch URL drifting off stable release URL");
});

test("findWorkflowDocBindingIssues reports the powershell fetch URL drifting off the stable release URL", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = VALID_DOC.replace(
    POWERSHELL_FETCH_BLOCK,
    ["```powershell", "mkdir pdpp; cd pdpp", `curl.exe -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  const hasDriftedUrl = findings.some((f) => POWERSHELL_NOT_STABLE_URL_PATTERN.test(f.detail));
  assert.ok(hasDriftedUrl, "should report powershell fetch URL drifting off stable release URL");
});

test("findWorkflowDocBindingIssues reports both fetch URLs drifting to the SAME wrong URL (mutual agreement is not enough)", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = VALID_DOC.replace(
    SH_FETCH_BLOCK,
    ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${driftedUrl}`, "```"].join("\n")
  ).replace(
    POWERSHELL_FETCH_BLOCK,
    ["```powershell", "mkdir pdpp; cd pdpp", `curl.exe -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  const shDrifted = findings.some((f) => SH_NOT_STABLE_URL_PATTERN.test(f.detail));
  const pwshDrifted = findings.some((f) => POWERSHELL_NOT_STABLE_URL_PATTERN.test(f.detail));
  assert.ok(shDrifted && pwshDrifted, "should report both URLs drifting");
});

test("block-level discrimination: required path in comment but not in pull_request.paths block is caught", () => {
  // A required path moved into a comment or different block should be detected
  const workflow = VALID_WORKFLOW.replace(
    '- "docs/operator/selfhost-quickstart.md"',
    '# - "docs/operator/selfhost-quickstart.md" (commented out)'
  );
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  const hasMissingPath = findings.some((f) => f.detail.includes('pull_request.paths is missing required path'));
  assert.ok(hasMissingPath, "should detect path removed from pull_request.paths block");
});

test("block-level discrimination: required test command in comment but not in test step is caught", () => {
  // A required command moved into a comment or different job should be detected
  const workflow = VALID_WORKFLOW.replace(
    "pnpm docker:release-matrix:check",
    "# pnpm docker:release-matrix:check (commented out)"
  );
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  const hasMissingCommand = findings.some((f) => MISSING_TEST_COMMAND_PATTERN.test(f.detail));
  assert.ok(hasMissingCommand, "should detect test command removed from test step");
});

test("block-level discrimination: permissions in comment but not in permissions block is caught", () => {
  // Permissions moved elsewhere should be detected
  const workflow = VALID_WORKFLOW.replace(
    "contents: read",
    "# contents: read (documented elsewhere)"
  );
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  const hasMissingPermission = findings.some((f) => f.detail.includes("permissions block is missing"));
  assert.ok(hasMissingPermission, "should detect permission removed from permissions block");
});

test("live repo: friend-os-matrix.yml agrees with docs/operator/selfhost-quickstart.md", () => {
  const workflowSource = readFileSync(join(REPO_ROOT, ".github/workflows/friend-os-matrix.yml"), "utf8");
  const quickstartDocSource = readFileSync(join(REPO_ROOT, "docs/operator/selfhost-quickstart.md"), "utf8");
  assert.deepEqual(findWorkflowDocBindingIssues(workflowSource, quickstartDocSource), []);
});
