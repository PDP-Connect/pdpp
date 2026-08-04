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

const VALID_WORKFLOW = [
  "os: [ubuntu-latest, macos-latest, windows-latest]",
  "macOS and Linux (bash or zsh):",
  "Windows PowerShell (the block above cannot work there",
  "### 1. Fetch the released compose bundle",
  "On **Windows PowerShell**, bare",
  "docker info --format",
].join("\n");

const SH_FETCH_BLOCK = ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${STABLE_RELEASE_BUNDLE_URL}`, "```"].join("\n");
const POWERSHELL_FETCH_BLOCK = [
  "```powershell",
  "mkdir pdpp; cd pdpp",
  `curl.exe -fsSLO ${STABLE_RELEASE_BUNDLE_URL}`,
  "```",
].join("\n");

const VALID_DOC = [
  "macOS and Linux (bash or zsh):",
  "Windows PowerShell (the block above cannot work there",
  "### 1. Fetch the released compose bundle",
  SH_FETCH_BLOCK,
  "On **Windows PowerShell**, bare",
  POWERSHELL_FETCH_BLOCK,
].join("\n");

const DROPPED_OS_PATTERN = /no longer runs on "windows-latest"/;
const MISSING_DOC_ANCHOR_PATTERN = /missing from docs\/operator\/selfhost-quickstart\.md/;
const MISSING_DOCKER_PROBE_PATTERN = /no longer probes for a real Linux container daemon/;
const MISSING_SH_FETCH_URL_PATTERN = /missing the sh Compose-fetch URL/;
const MISSING_POWERSHELL_FETCH_URL_PATTERN = /missing the powershell Compose-fetch URL/;
const SH_NOT_STABLE_URL_PATTERN = /sh fetch URL .* is not the one stable release-asset URL/;
const POWERSHELL_NOT_STABLE_URL_PATTERN = /powershell fetch URL .* is not the one stable release-asset URL/;

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

test("findWorkflowDocBindingIssues reports a missing sh Compose-fetch URL", () => {
  const doc = VALID_DOC.replace(SH_FETCH_BLOCK, "");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", MISSING_SH_FETCH_URL_PATTERN);
});

test("findWorkflowDocBindingIssues reports a missing powershell Compose-fetch URL", () => {
  const doc = VALID_DOC.replace(POWERSHELL_FETCH_BLOCK, "");
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", MISSING_POWERSHELL_FETCH_URL_PATTERN);
});

test("findWorkflowDocBindingIssues reports the sh fetch URL drifting off the stable release URL", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = VALID_DOC.replace(
    SH_FETCH_BLOCK,
    ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", SH_NOT_STABLE_URL_PATTERN);
});

test("findWorkflowDocBindingIssues reports the powershell fetch URL drifting off the stable release URL", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = VALID_DOC.replace(
    POWERSHELL_FETCH_BLOCK,
    ["```powershell", "mkdir pdpp; cd pdpp", `curl.exe -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(VALID_WORKFLOW, doc);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", POWERSHELL_NOT_STABLE_URL_PATTERN);
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
  assert.equal(findings.length, 2);
  assert.match(findings[0]?.detail ?? "", SH_NOT_STABLE_URL_PATTERN);
  assert.match(findings[1]?.detail ?? "", POWERSHELL_NOT_STABLE_URL_PATTERN);
});

test("live repo: friend-os-matrix.yml agrees with docs/operator/selfhost-quickstart.md", () => {
  const workflowSource = readFileSync(join(REPO_ROOT, ".github/workflows/friend-os-matrix.yml"), "utf8");
  const quickstartDocSource = readFileSync(join(REPO_ROOT, "docs/operator/selfhost-quickstart.md"), "utf8");
  assert.deepEqual(findWorkflowDocBindingIssues(workflowSource, quickstartDocSource), []);
});
