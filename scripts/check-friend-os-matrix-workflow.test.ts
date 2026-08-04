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

// Load the real workflow and doc as the baseline for all synthetic tests
const REAL_WORKFLOW = readFileSync(join(REPO_ROOT, ".github/workflows/friend-os-matrix.yml"), "utf8");
const REAL_DOC = readFileSync(join(REPO_ROOT, "docs/operator/selfhost-quickstart.md"), "utf8");

const SH_FETCH_BLOCK = ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${STABLE_RELEASE_BUNDLE_URL}`, "```"].join("\n");
const POWERSHELL_FETCH_BLOCK = [
  "```powershell",
  "mkdir pdpp; cd pdpp",
  `curl.exe -fsSLO ${STABLE_RELEASE_BUNDLE_URL}`,
  "```",
].join("\n");

const DROPPED_OS_PATTERN = /no longer runs on "windows-latest"/;
const MISSING_DOC_ANCHOR_PATTERN = /missing from docs\/operator\/selfhost-quickstart\.md/;
const MISSING_DOCKER_PROBE_PATTERN = /no longer probes for a real Linux container daemon/;
const MISSING_SH_FETCH_URL_PATTERN = /missing the sh Compose-fetch URL/;
const MISSING_POWERSHELL_FETCH_URL_PATTERN = /missing the powershell Compose-fetch URL/;
const SH_NOT_STABLE_URL_PATTERN = /sh fetch URL .* is not the one stable release-asset URL/;
const POWERSHELL_NOT_STABLE_URL_PATTERN = /powershell fetch URL .* is not the one stable release-asset URL/;
const MISSING_PULL_REQUEST_PATH = /pull_request\.paths is missing required path/;
const MISSING_TEST_COMMAND = /test step is not running/;
const MISSING_PERMISSIONS = /permissions block is missing/;

test("findWorkflowDocBindingIssues is silent when real workflow and doc agree", () => {
  assert.deepEqual(findWorkflowDocBindingIssues(REAL_WORKFLOW, REAL_DOC), []);
});

test("synthetic: dropped OS from matrix is caught", () => {
  const workflow = REAL_WORKFLOW.replace(
    "os: [ubuntu-latest, macos-latest, windows-latest]",
    "os: [ubuntu-latest, macos-latest]"
  );
  const findings = findWorkflowDocBindingIssues(workflow, REAL_DOC);
  const hasDrop = findings.some((f) => DROPPED_OS_PATTERN.test(f.detail));
  assert.ok(hasDrop, "should report dropped OS");
});

test("synthetic: renamed doc anchor that workflow depends on is caught", () => {
  const doc = REAL_DOC.replace("macOS and Linux (bash or zsh):", "macOS and Linux, bash or zsh:");
  const findings = findWorkflowDocBindingIssues(REAL_WORKFLOW, doc);
  const hasMissing = findings.some((f) => MISSING_DOC_ANCHOR_PATTERN.test(f.detail));
  assert.ok(hasMissing, "should report missing doc anchor");
});

test("synthetic: missing Docker daemon probe is caught", () => {
  const workflow = REAL_WORKFLOW.replace("docker info --format", "");
  const findings = findWorkflowDocBindingIssues(workflow, REAL_DOC);
  const hasMissing = findings.some((f) => MISSING_DOCKER_PROBE_PATTERN.test(f.detail));
  assert.ok(hasMissing, "should report missing Docker probe");
});

test("synthetic: missing sh Compose-fetch URL entirely is caught", () => {
  const doc = REAL_DOC.replace(SH_FETCH_BLOCK, "");
  const findings = findWorkflowDocBindingIssues(REAL_WORKFLOW, doc);
  const hasMissing = findings.some((f) => MISSING_SH_FETCH_URL_PATTERN.test(f.detail));
  assert.ok(hasMissing, "should report missing sh Compose-fetch URL");
});

test("synthetic: missing powershell Compose-fetch URL entirely is caught", () => {
  const doc = REAL_DOC.replace(POWERSHELL_FETCH_BLOCK, "");
  const findings = findWorkflowDocBindingIssues(REAL_WORKFLOW, doc);
  const hasMissing = findings.some((f) => MISSING_POWERSHELL_FETCH_URL_PATTERN.test(f.detail));
  assert.ok(hasMissing, "should report missing powershell Compose-fetch URL");
});

test("synthetic: sh fetch URL drifting off stable URL is caught", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = REAL_DOC.replace(
    SH_FETCH_BLOCK,
    ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(REAL_WORKFLOW, doc);
  const hasDrift = findings.some((f) => SH_NOT_STABLE_URL_PATTERN.test(f.detail));
  assert.ok(hasDrift, "should report sh URL drift");
});

test("synthetic: powershell fetch URL drifting off stable URL is caught", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = REAL_DOC.replace(
    POWERSHELL_FETCH_BLOCK,
    ["```powershell", "mkdir pdpp; cd pdpp", `curl.exe -fsSLO ${driftedUrl}`, "```"].join("\n")
  );
  const findings = findWorkflowDocBindingIssues(REAL_WORKFLOW, doc);
  const hasDrift = findings.some((f) => POWERSHELL_NOT_STABLE_URL_PATTERN.test(f.detail));
  assert.ok(hasDrift, "should report powershell URL drift");
});

test("synthetic: both URLs drifting to same wrong URL is caught (even with mutual agreement)", () => {
  const driftedUrl = "https://raw.githubusercontent.com/PDP-Connect/pdpp/def456/deploy/docker/docker-compose.yml";
  const doc = REAL_DOC.replace(SH_FETCH_BLOCK, ["```sh", "mkdir pdpp && cd pdpp", `curl -fsSLO ${driftedUrl}`, "```"].join("\n"))
    .replace(POWERSHELL_FETCH_BLOCK, ["```powershell", "mkdir pdpp; cd pdpp", `curl.exe -fsSLO ${driftedUrl}`, "```"].join("\n"));
  const findings = findWorkflowDocBindingIssues(REAL_WORKFLOW, doc);
  const shDrift = findings.some((f) => SH_NOT_STABLE_URL_PATTERN.test(f.detail));
  const pwshDrift = findings.some((f) => POWERSHELL_NOT_STABLE_URL_PATTERN.test(f.detail));
  assert.ok(shDrift && pwshDrift, "should report both URLs drifting");
});

test("discriminating: required path in comment but not in pull_request.paths block is caught", () => {
  const workflow = REAL_WORKFLOW.replace(
    '- "docs/operator/selfhost-quickstart.md"',
    '# - "docs/operator/selfhost-quickstart.md" (was commented out)'
  );
  const findings = findWorkflowDocBindingIssues(workflow, REAL_DOC);
  const hasMissing = findings.some((f) => MISSING_PULL_REQUEST_PATH.test(f.detail));
  assert.ok(hasMissing, "should detect path removed from pull_request.paths block");
});

test("discriminating: required test command in comment but not in test step is caught", () => {
  const workflow = REAL_WORKFLOW.replace(
    "pnpm docker:release-matrix:check",
    "# pnpm docker:release-matrix:check (was removed from test step)"
  );
  const findings = findWorkflowDocBindingIssues(workflow, REAL_DOC);
  const hasMissing = findings.some((f) => MISSING_TEST_COMMAND.test(f.detail));
  assert.ok(hasMissing, "should detect test command removed from test step");
});

test("discriminating: permissions in comment but not in permissions block is caught", () => {
  const workflow = REAL_WORKFLOW.replace(
    "contents: read",
    "# contents: read (was removed)"
  );
  const findings = findWorkflowDocBindingIssues(workflow, REAL_DOC);
  const hasMissing = findings.some((f) => MISSING_PERMISSIONS.test(f.detail));
  assert.ok(hasMissing, "should detect permission removed from permissions block");
});

