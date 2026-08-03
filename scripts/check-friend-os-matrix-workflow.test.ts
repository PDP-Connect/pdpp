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

const VALID_WORKFLOW = [
  "os: [ubuntu-latest, macos-latest, windows-latest]",
  "PDPP_QUICKSTART_COMMIT: abc123",
  "macOS and Linux (bash or zsh):",
  "Windows PowerShell (the block above cannot work there",
  "### 1. Fetch the blessed compose stack",
  "docker info --format",
].join("\n");

const VALID_DOC = [
  "abc123",
  "macOS and Linux (bash or zsh):",
  "Windows PowerShell (the block above cannot work there",
  "### 1. Fetch the blessed compose stack",
].join("\n");

const DROPPED_OS_PATTERN = /no longer runs on "windows-latest"/;
const DRIFTED_COMMIT_PIN_PATTERN = /pins commit abc123.*no longer appears/;
const MISSING_DOC_ANCHOR_PATTERN = /missing from docs\/operator\/selfhost-quickstart\.md/;
const MISSING_DOCKER_PROBE_PATTERN = /no longer probes for a real Linux container daemon/;

test("findWorkflowDocBindingIssues is silent when workflow and doc agree", () => {
  assert.deepEqual(findWorkflowDocBindingIssues(VALID_WORKFLOW, VALID_DOC), []);
});

test("findWorkflowDocBindingIssues reports a dropped OS from the matrix", () => {
  const workflow = VALID_WORKFLOW.replace(
    "os: [ubuntu-latest, macos-latest, windows-latest]",
    "os: [ubuntu-latest, macos-latest]"
  );
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", DROPPED_OS_PATTERN);
});

test("findWorkflowDocBindingIssues reports a pinned commit that no longer appears in the doc", () => {
  const doc = VALID_DOC.replace("abc123", "def456");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", DRIFTED_COMMIT_PIN_PATTERN);
});

test("findWorkflowDocBindingIssues reports a renamed doc anchor the workflow still depends on", () => {
  const doc = VALID_DOC.replace("macOS and Linux (bash or zsh):", "macOS and Linux, bash or zsh:");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", MISSING_DOC_ANCHOR_PATTERN);
});

test("findWorkflowDocBindingIssues reports a dropped Docker-daemon probe", () => {
  const workflow = VALID_WORKFLOW.replace("docker info --format", "");
  const findings = findWorkflowDocBindingIssues(workflow, VALID_DOC);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", MISSING_DOCKER_PROBE_PATTERN);
});

test("live repo: friend-os-matrix.yml agrees with docs/operator/selfhost-quickstart.md", () => {
  const workflowSource = readFileSync(join(REPO_ROOT, ".github/workflows/friend-os-matrix.yml"), "utf8");
  const quickstartDocSource = readFileSync(join(REPO_ROOT, "docs/operator/selfhost-quickstart.md"), "utf8");
  assert.deepEqual(findWorkflowDocBindingIssues(workflowSource, quickstartDocSource), []);
});
