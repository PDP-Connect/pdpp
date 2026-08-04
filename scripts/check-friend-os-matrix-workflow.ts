#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Structural checks binding .github/workflows/friend-os-matrix.yml to the
// self-host docs it exists to verify.
//
// The workflow proves the quickstart by running the SAME commands the docs
// tell an operator to run. That guarantee only holds if the workflow keeps
// pointing at the real doc anchors, keeps running on all three OSes this
// repo claims to support, and keeps executing the friend-readiness tests
// that guard the binding — a silent edit to any of those (a renamed anchor,
// a dropped matrix entry, a removed test step) would make the workflow
// either fail opaquely or, worse, keep passing while testing something
// other than what the docs say. This check fails fast and specifically instead.
//
// The doc converged on ONE stable release-asset URL
// (https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml,
// see docs/operator/selfhost-quickstart.md history) instead of a
// hand-copied commit-SHA-pinned raw URL — there is no longer a
// PDPP_QUICKSTART_COMMIT pin to bind here; the binding this check enforces
// instead is that both platform fetch blocks target that exact same stable
// URL, so a future edit that lets one block drift onto a different URL
// (a stale raw-fetch, a mistyped release path) fails loudly.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/friend-os-matrix.yml");
const QUICKSTART_DOC_PATH = join(REPO_ROOT, "docs/operator/selfhost-quickstart.md");

export interface Finding {
  detail: string;
}

const REQUIRED_MATRIX_OSES = ["ubuntu-latest", "macos-latest", "windows-latest"];
const MATRIX_OS_LIST_PATTERNS = new Map(
  REQUIRED_MATRIX_OSES.map((os) => [os, new RegExp(`^\\s*os:\\s*\\[[^\\]]*\\b${os}\\b`, "m")])
);
const STABLE_RELEASE_BUNDLE_URL = "https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml";
const SH_FETCH_URL_PATTERN = /```sh\nmkdir pdpp && cd pdpp\ncurl -fsSLO (\S+)\n```/;
const POWERSHELL_FETCH_URL_PATTERN = /```powershell\nmkdir pdpp; cd pdpp\ncurl\.exe -fsSLO (\S+)\n```/;

const REQUIRED_PULL_REQUEST_PATHS = [
  ".github/workflows/friend-os-matrix.yml",
  ".github/workflows/semantic-release.yml",
  "package.json",
  "pnpm-lock.yaml",
  "apps/site/**",
  "deploy/docker/**",
  "docs/operator/selfhost-quickstart.md",
  "docs/operator/friend-journey-acceptance.md",
  "docs/operator/hosted-mcp-setup.md",
  "docs/operator/self-service-gmail-mcp.md",
  "reference-implementation/README.md",
  "scripts/extract-doc-command-block.ts",
  "scripts/extract-doc-command-block.test.ts",
  "scripts/generate-selfhost-bundle.ts",
  "scripts/generate-selfhost-bundle.test.ts",
  "scripts/check-docker-release-matrix.ts",
  "scripts/check-docker-release-matrix.test.ts",
  "scripts/verify-published-docker-images.ts",
  "scripts/verify-selfhost-bundle-published.ts",
  "scripts/verify-selfhost-bundle-published.test.ts",
  "scripts/publish-selfhost-bundle-asset.ts",
  "scripts/publish-selfhost-bundle-asset.test.ts",
  "scripts/check-friend-journey-acceptance.ts",
  "scripts/check-friend-os-matrix-workflow.ts",
  "scripts/check-friend-os-matrix-workflow.test.ts",
  "scripts/friend-os-matrix/**",
  "scripts/friend-journey-acceptance/**",
];

const REQUIRED_TEST_COMMANDS = [
  "pnpm docker:release-matrix:check",
  "pnpm docker:release-matrix:check:test",
  "node --test --import tsx scripts/check-friend-os-matrix-workflow.test.ts",
  "node --test --import tsx scripts/extract-doc-command-block.test.ts",
  "pnpm docker:release-bundle:test",
  "pnpm docker:release-bundle:verify-published:test",
  "pnpm docker:release-bundle:publish-asset:test",
  "pnpm --filter @pdpp/mcp-server build",
  "pnpm --filter pdpp-site test",
  "pnpm friend-journey:acceptance:test",
];

// Extract pull_request.paths block from YAML
function extractPullRequestPaths(workflowSource: string): string[] {
  const match = workflowSource.match(/pull_request:\s*paths:\s*([\s\S]*?)(?=\n  \w|$)/);
  if (!match || !match[1]) return [];
  const pathsBlock = match[1];
  const paths: string[] = [];
  const pathMatches = pathsBlock.matchAll(/- "([^"]+)"/g);
  for (const m of pathMatches) {
    if (m[1]) paths.push(m[1]);
  }
  return paths;
}

// Extract the run step from extract-doc-commands job
function extractTestRunStep(workflowSource: string): string {
  const match = workflowSource.match(
    /- name: Run friend-readiness tests\s+run:\s+\|\s*([\s\S]*?)(?=\n\s{2,6}- name:|\n\n\s{2}[\w]|$)/
  );
  return match?.[1] ?? "";
}

// Extract permissions block
function extractPermissionsBlock(workflowSource: string): string {
  const match = workflowSource.match(/^permissions:\s*([\s\S]*?)(?=\n\w|$)/m);
  return match?.[1] ?? "";
}

// Extract workflow_run block
function extractWorkflowRunBlock(workflowSource: string): string {
  const match = workflowSource.match(/workflow_run:\s*([\s\S]*?)(?=\npermissions:|$)/);
  return match?.[1] ?? "";
}

export function findWorkflowDocBindingIssues(workflowSource: string, quickstartDocSource: string): Finding[] {
  const findings: Finding[] = [];

  // Check required pull_request paths (block-level)
  const prPaths = extractPullRequestPaths(workflowSource);
  for (const path of REQUIRED_PULL_REQUEST_PATHS) {
    if (!prPaths.includes(path)) {
      findings.push({ detail: `pull_request.paths is missing required path: "${path}"` });
    }
  }

  // Check workflow-level permissions (block-level)
  const permissionsBlock = extractPermissionsBlock(workflowSource);
  if (!permissionsBlock) {
    findings.push({ detail: "missing workflow-level permissions: block" });
  } else if (!permissionsBlock.includes("contents: read")) {
    findings.push({ detail: "permissions block is missing 'contents: read'" });
  }

  // Check workflow_run scoping (block-level)
  const workflowRunBlock = extractWorkflowRunBlock(workflowSource);
  if (!workflowRunBlock) {
    findings.push({ detail: "missing workflow_run block" });
  } else {
    if (!workflowRunBlock.includes("workflows: [\"semantic-release\"]")) {
      findings.push({ detail: "workflow_run block is missing workflows: [\"semantic-release\"]" });
    }
    if (!workflowRunBlock.includes("types: [completed]")) {
      findings.push({ detail: "workflow_run block is missing types: [completed]" });
    }
    if (!workflowRunBlock.includes("branches: [main]")) {
      findings.push({
        detail: "workflow_run block is not scoped to branches: [main]; post-release verification should only run on main",
      });
    }
  }

  // Check required test step exists
  const testRunStep = extractTestRunStep(workflowSource);
  if (!testRunStep) {
    findings.push({ detail: "extract-doc-commands job is missing the 'Run friend-readiness tests' step" });
  } else {
    // Check all required test commands within test step
    for (const testCommand of REQUIRED_TEST_COMMANDS) {
      if (!testRunStep.includes(testCommand)) {
        findings.push({
          detail: `test step is not running: "${testCommand}"`,
        });
      }
    }
  }

  // Check frozen lockfile install exists before test step (separate check)
  if (!workflowSource.includes("pnpm install --frozen-lockfile")) {
    findings.push({ detail: "extract-doc-commands job is not installing frozen dependencies" });
  }

  for (const os of REQUIRED_MATRIX_OSES) {
    const matrixListPattern = MATRIX_OS_LIST_PATTERNS.get(os);
    if (!(matrixListPattern?.test(workflowSource) || workflowSource.includes(os))) {
      findings.push({ detail: `workflow no longer runs on "${os}"` });
    }
  }

  const requiredAnchors = [
    "macOS and Linux (bash or zsh):",
    "Windows PowerShell (the block above cannot work there",
    "### 1. Fetch the released compose bundle",
    "On **Windows PowerShell**, bare",
  ];
  for (const anchor of requiredAnchors) {
    if (!workflowSource.includes(anchor)) {
      findings.push({ detail: `workflow no longer references doc anchor ${JSON.stringify(anchor)}` });
    }
    if (!quickstartDocSource.includes(anchor)) {
      findings.push({
        detail: `doc anchor ${JSON.stringify(anchor)} is missing from docs/operator/selfhost-quickstart.md`,
      });
    }
  }

  if (!workflowSource.includes("docker info --format")) {
    findings.push({
      detail:
        "workflow no longer probes for a real Linux container daemon before claiming a Docker-backed pass",
    });
  }

  const shFetchMatch = quickstartDocSource.match(SH_FETCH_URL_PATTERN);
  const powershellFetchMatch = quickstartDocSource.match(POWERSHELL_FETCH_URL_PATTERN);
  if (!shFetchMatch) {
    findings.push({ detail: "docs/operator/selfhost-quickstart.md is missing the sh Compose-fetch URL under step 1" });
  } else if (shFetchMatch[1] !== STABLE_RELEASE_BUNDLE_URL) {
    findings.push({
      detail: `docs/operator/selfhost-quickstart.md sh fetch URL (${shFetchMatch[1]}) is not the one stable release-asset URL (${STABLE_RELEASE_BUNDLE_URL})`,
    });
  }
  if (!powershellFetchMatch) {
    findings.push({
      detail: "docs/operator/selfhost-quickstart.md is missing the powershell Compose-fetch URL under step 1",
    });
  } else if (powershellFetchMatch[1] !== STABLE_RELEASE_BUNDLE_URL) {
    findings.push({
      detail: `docs/operator/selfhost-quickstart.md powershell fetch URL (${powershellFetchMatch[1]}) is not the one stable release-asset URL (${STABLE_RELEASE_BUNDLE_URL})`,
    });
  }

  return findings;
}

function main(): void {
  const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");
  const quickstartDocSource = readFileSync(QUICKSTART_DOC_PATH, "utf8");
  const findings = findWorkflowDocBindingIssues(workflowSource, quickstartDocSource);
  if (findings.length > 0) {
    console.error("check-friend-os-matrix-workflow: found issues:");
    for (const finding of findings) {
      console.error(`  - ${finding.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("check-friend-os-matrix-workflow: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
