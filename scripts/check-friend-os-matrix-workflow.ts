#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Structural checks binding .github/workflows/friend-os-matrix.yml to the
// self-host docs it exists to verify.
//
// The workflow proves the quickstart by running the SAME commands the docs
// tell an operator to run. That guarantee only holds if the workflow keeps
// pointing at the real doc anchors/pinned commit and keeps running on all
// three OSes this repo claims to support — a silent edit to any of those
// (a renamed anchor, a dropped matrix entry, an unbumped pinned SHA) would
// make the workflow either fail opaquely or, worse, keep passing while
// testing something other than what the docs say. This check fails fast and
// specifically instead.

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
const QUICKSTART_COMMIT_PATTERN = /PDPP_QUICKSTART_COMMIT:\s*(\S+)/;

export function findWorkflowDocBindingIssues(workflowSource: string, quickstartDocSource: string): Finding[] {
  const findings: Finding[] = [];

  for (const os of REQUIRED_MATRIX_OSES) {
    const matrixListPattern = MATRIX_OS_LIST_PATTERNS.get(os);
    if (!(matrixListPattern?.test(workflowSource) || workflowSource.includes(os))) {
      findings.push({ detail: `friend-os-matrix.yml no longer runs on "${os}"` });
    }
  }

  const commitMatch = workflowSource.match(QUICKSTART_COMMIT_PATTERN);
  if (commitMatch) {
    const [, pinnedCommit] = commitMatch;
    if (!quickstartDocSource.includes(String(pinnedCommit))) {
      findings.push({
        detail: `friend-os-matrix.yml pins commit ${pinnedCommit}, which no longer appears in docs/operator/selfhost-quickstart.md — the workflow's pin has drifted from the doc's pin`,
      });
    }
  } else {
    findings.push({ detail: "friend-os-matrix.yml is missing the PDPP_QUICKSTART_COMMIT pin" });
  }

  const requiredAnchors = [
    "macOS and Linux (bash or zsh):",
    "Windows PowerShell (the block above cannot work there",
    "### 1. Fetch the blessed compose stack",
  ];
  for (const anchor of requiredAnchors) {
    if (!workflowSource.includes(anchor)) {
      findings.push({ detail: `friend-os-matrix.yml no longer references doc anchor ${JSON.stringify(anchor)}` });
    }
    if (!quickstartDocSource.includes(anchor)) {
      findings.push({
        detail: `doc anchor ${JSON.stringify(anchor)} that friend-os-matrix.yml depends on is missing from docs/operator/selfhost-quickstart.md`,
      });
    }
  }

  if (!workflowSource.includes("docker info --format")) {
    findings.push({
      detail:
        "friend-os-matrix.yml no longer probes for a real Linux container daemon before claiming a Docker-backed pass",
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
