#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_RULESET_NAME = "main: require PR + reference-implementation check";
export const HOSTED_CONTEXT = "typecheck + full test suite";
export const LOCAL_CONTEXT = "signoff/reference-implementation";
export const MANAGED_WORKFLOW_PATHS = [
  ".github/workflows/reference-implementation.yml",
  ".github/workflows/react-doctor.yml",
  ".github/workflows/docker-images.yml",
  ".github/workflows/spec-check.yml",
  ".github/workflows/polyfill-connectors.yml",
  ".github/workflows/remote-surface.yml",
  ".github/workflows/semantic-release.yml",
];

// Path prefixes whose change makes the connector-conformance gate (below)
// part of the local signoff gate. The suite audits both the bundled polyfill
// manifests and reference manifests, so either manifest source must trigger
// it. `.github/workflows/polyfill-connectors.yml` runs the full suite on
// every PR but is explicitly non-blocking (see its file header) — this closes
// the resulting merge-gate gap for local-mode signoff without touching
// hosted CI.
//
// Also includes this gate's OWN implementation (this file, its test file,
// and the connector-conformance test files it runs) plus package.json (where
// the gate's scripts are wired) — a change to the gate itself must exercise
// the gate, so it cannot be weakened without proving the weakened version
// still passes ci:mode:test and the connector-conformance run.
export const CONNECTOR_SURFACE_PATH_PREFIXES = ["packages/polyfill-connectors/", "reference-implementation/manifests/"];

// The specific, fast, deterministic tests that catch a scaffolded/dishonest
// connector manifest — not the full polyfill-connectors package suite (which
// also runs slow browser/integration connector tests unrelated to this gate).
// Paths are relative to packages/polyfill-connectors.
export const CONNECTOR_CONFORMANCE_TEST_FILES = [
  "src/stream-evidence-strategy-manifest.test.ts",
  "src/coverage-policy-manifest-honesty.test.ts",
  "src/connector-conformance.test.ts",
];

export const CI_GATE_SELF_PATHS = [
  "scripts/ci-mode.mjs",
  "scripts/ci-mode.test.mjs",
  "package.json",
  ...CONNECTOR_CONFORMANCE_TEST_FILES.map((path) => `packages/polyfill-connectors/${path}`),
];

// The generated inventory is source-derived evidence over both shipped
// manifest roots. A manifest edit must prove the committed rendering is still
// current; changing the generator or generated artifact must prove the same
// fact, otherwise a local signoff could bless an intentionally stale render.
export const STREAM_EVIDENCE_INVENTORY_PATHS = [
  "scripts/stream-evidence-inventory.mjs",
  "docs/reference/stream-evidence-inventory.md",
];

export function changeTouchesConnectorSurface(changedFiles) {
  return changedFiles.some((path) => CONNECTOR_SURFACE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

export function changeTouchesCiGateSelf(changedFiles) {
  return changedFiles.some((path) => CI_GATE_SELF_PATHS.includes(path));
}

export function streamEvidenceInventoryGateRequired(changedFiles) {
  return (
    changeTouchesConnectorSurface(changedFiles) ||
    changedFiles.some((path) => STREAM_EVIDENCE_INVENTORY_PATHS.includes(path))
  );
}

const modeContexts = {
  hosted: [HOSTED_CONTEXT],
  local: [LOCAL_CONTEXT],
};

function usage() {
  return `Usage:
  node scripts/ci-mode.mjs status
  node scripts/ci-mode.mjs hosted
  node scripts/ci-mode.mjs local
  node scripts/ci-mode.mjs signoff [--sha <sha>] [--description <text>] [--target-url <url>] [--base <ref>]

Modes:
  hosted   Require the GitHub Actions check: ${HOSTED_CONTEXT}
  local    Require the local signoff status: ${LOCAL_CONTEXT}

The script updates only the repository ruleset required-status-check contexts
and the managed GitHub Actions workflow states. It preserves the existing
pull-request, deletion, and non-fast-forward rules.

signoff always tests the exact commit it signs: the worktree must be clean
and pushed (there is no --force / dirty-tree override), and --sha, if given,
must equal HEAD — signoff refuses to post a status for a commit whose code
it did not just test. It diffs HEAD against --base (default origin/main);
it gets changed paths with --no-renames and NUL delimiters; if that diff
touches either shipped manifest root
(${CONNECTOR_SURFACE_PATH_PREFIXES.join(", ")}), it runs the connector-conformance
suite (${CONNECTOR_CONFORMANCE_TEST_FILES.join(", ")}) and the source-derived
stream-evidence inventory check. Changes to the inventory producer/artifact
(${STREAM_EVIDENCE_INVENTORY_PATHS.join(", ")}) also run that inventory check.
For a gate-self change (${CI_GATE_SELF_PATHS.join(", ")}), signoff also runs
ci:mode:test — failing closed if any required check does not pass. There is no
opt-out: if the diff cannot be computed (missing base ref, shallow clone),
signoff fails outright rather than silently skipping the gate.`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    input: options.input,
  }).trim();
}

function runJson(command, args, options = {}) {
  const out = run(command, args, options);
  return out ? JSON.parse(out) : null;
}

function gh(args, options = {}) {
  return run("gh", args, options);
}

function ghJson(args, options = {}) {
  return runJson("gh", args, options);
}

function git(args) {
  return run("git", args);
}

function gitBuffer(args) {
  return execFileSync("git", args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function getRequiredStatusContexts(ruleset) {
  const rule = ruleset.rules?.find((candidate) => candidate.type === "required_status_checks");
  return rule?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
}

export function detectCiMode(contexts) {
  const normalized = [...contexts].sort();
  for (const [mode, expected] of Object.entries(modeContexts)) {
    if (JSON.stringify(normalized) === JSON.stringify([...expected].sort())) {
      return mode;
    }
  }
  return "custom";
}

export function rulesetWithRequiredStatusContexts(ruleset, contexts) {
  let replaced = false;
  const nextRules = (ruleset.rules ?? []).map((rule) => {
    if (rule.type !== "required_status_checks") {
      return rule;
    }
    replaced = true;
    return {
      ...rule,
      parameters: {
        ...(rule.parameters ?? {}),
        required_status_checks: contexts.map((context) => ({ context })),
      },
    };
  });
  if (!replaced) {
    nextRules.push({
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: false,
        required_status_checks: contexts.map((context) => ({ context })),
        strict_required_status_checks_policy: false,
      },
    });
  }
  return {
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions: ruleset.conditions,
    enforcement: ruleset.enforcement,
    name: ruleset.name,
    rules: nextRules,
    target: ruleset.target,
  };
}

export function workflowUpdatesForMode(workflows, mode, managedPaths = MANAGED_WORKFLOW_PATHS) {
  if (mode !== "hosted" && mode !== "local") {
    throw new Error(`unknown mode: ${mode}`);
  }
  const workflowsByPath = new Map(workflows.map((workflow) => [workflow.path, workflow]));
  return managedPaths.map((path) => {
    const workflow = workflowsByPath.get(path) ?? null;
    const action = mode === "hosted" ? "enable" : "disable";
    return {
      action,
      missing: workflow === null,
      needsChange: workflow ? (mode === "hosted" ? workflow.state !== "active" : workflow.state === "active") : false,
      path,
      state: workflow?.state ?? "missing",
      workflow,
    };
  });
}

function repoApiPath(suffix = "") {
  return `repos/:owner/:repo${suffix}`;
}

function getManagedWorkflowPaths(mode, workflows) {
  const configured = process.env.PDPP_CI_MANAGED_WORKFLOWS;
  let paths;
  if (configured) {
    paths = configured
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } else if (mode === "local") {
    paths = workflows.map((workflow) => workflow.path);
  } else {
    paths = MANAGED_WORKFLOW_PATHS;
  }
  return [...new Set(paths)];
}

function loadRuleset() {
  const configuredId = process.env.PDPP_CI_RULESET_ID;
  if (configuredId) {
    return ghJson(["api", repoApiPath(`/rulesets/${configuredId}`)]);
  }
  const name = process.env.PDPP_CI_RULESET_NAME || DEFAULT_RULESET_NAME;
  const rulesets = ghJson(["api", repoApiPath("/rulesets")]) ?? [];
  const summary = rulesets.find((ruleset) => ruleset.name === name);
  if (!summary) {
    throw new Error(`ruleset not found: ${name}`);
  }
  return ghJson(["api", repoApiPath(`/rulesets/${summary.id}`)]);
}

function writeRuleset(ruleset, contexts) {
  const body = JSON.stringify(rulesetWithRequiredStatusContexts(ruleset, contexts), null, 2);
  return ghJson(
    [
      "api",
      "--method",
      "PUT",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      repoApiPath(`/rulesets/${ruleset.id}`),
      "--input",
      "-",
    ],
    { input: body }
  );
}

function loadWorkflows() {
  const response = ghJson(["api", repoApiPath("/actions/workflows?per_page=100")]);
  return response?.workflows ?? [];
}

function applyManagedWorkflowMode(mode) {
  const workflows = loadWorkflows();
  const updates = workflowUpdatesForMode(workflows, mode, getManagedWorkflowPaths(mode, workflows));
  const missing = updates.filter((update) => update.missing);
  if (missing.length > 0) {
    throw new Error(`managed workflow not found: ${missing.map((update) => update.path).join(", ")}`);
  }
  const changed = updates.filter((update) => update.needsChange);
  for (const update of changed) {
    gh(["api", "--method", "PUT", repoApiPath(`/actions/workflows/${update.workflow.id}/${update.action}`)]);
  }
  console.log(`managed workflows: ${mode === "hosted" ? "enabled" : "disabled"} (${changed.length} changed)`);
  for (const update of updates) {
    const marker = update.needsChange ? update.action : "unchanged";
    console.log(`- ${update.path}: ${update.state} -> ${marker}`);
  }
}

function printStatus() {
  const ruleset = loadRuleset();
  const contexts = getRequiredStatusContexts(ruleset);
  const mode = detectCiMode(contexts);
  console.log(`ruleset: ${ruleset.name} (#${ruleset.id})`);
  console.log(`mode: ${mode}`);
  console.log("required status checks:");
  for (const context of contexts) {
    console.log(`- ${context}`);
  }
  console.log("managed workflows:");
  const workflows = loadWorkflows();
  const statusMode = mode === "custom" ? "hosted" : mode;
  for (const update of workflowUpdatesForMode(workflows, statusMode, getManagedWorkflowPaths(statusMode, workflows))) {
    console.log(`- ${update.path}: ${update.state}`);
  }
}

function setMode(mode) {
  const contexts = modeContexts[mode];
  if (!contexts) {
    throw new Error(`unknown mode: ${mode}`);
  }
  if (mode === "hosted") {
    applyManagedWorkflowMode(mode);
  }
  const before = loadRuleset();
  const previous = getRequiredStatusContexts(before);
  const after = writeRuleset(before, contexts);
  const current = getRequiredStatusContexts(after);
  if (mode === "local") {
    applyManagedWorkflowMode(mode);
  }
  console.log(`mode: ${mode}`);
  console.log(`ruleset: ${after.name} (#${after.id})`);
  console.log(`previous required status checks: ${previous.join(", ") || "(none)"}`);
  console.log(`current required status checks: ${current.join(", ") || "(none)"}`);
}

function isCleanAndPushed() {
  if (git(["status", "--porcelain"])) {
    return false;
  }
  git(["rev-parse", "--abbrev-ref", "@{push}"]);
  return git(["log", "@{push}.."]) === "";
}

/**
 * List of files changed since `base` diverged from `HEAD`. Git path names may
 * contain Unicode or newlines, so request and parse its NUL-delimited form.
 * Disable rename detection so a protected source path cannot disappear when
 * a file is moved to an unprotected destination. Never parse Git's
 * display-oriented, potentially quoted text form. Throws (fails closed)
 * rather than returning a fallback when the diff cannot be computed — a
 * shallow clone or missing `base` ref must not be silently treated as
 * "nothing changed."
 */
function changedFilesAgainstBase(base) {
  const mergeBase = git(["merge-base", base, "HEAD"]);
  const diff = gitBuffer(["diff", "--no-renames", "--name-only", "-z", `${mergeBase}..HEAD`]);
  if (diff.length === 0) {
    return [];
  }
  const paths = diff.toString("utf8").split("\0");
  paths.pop();
  return paths;
}

function parseSignoffArgs(args) {
  const out = {
    base: "origin/main",
    context: LOCAL_CONTEXT,
    description: "Local reference-implementation gate signed off",
    sha: null,
    targetUrl: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--base") {
      out.base = args[++i];
    } else if (arg === "--context") {
      out.context = args[++i];
    } else if (arg === "--description") {
      out.description = args[++i];
    } else if (arg === "--sha") {
      out.sha = args[++i];
    } else if (arg === "--target-url") {
      out.targetUrl = args[++i];
    } else {
      throw new Error(`unknown signoff option: ${arg}`);
    }
  }
  if (!out.context) {
    throw new Error("signoff context cannot be empty");
  }
  return out;
}

/**
 * Decide whether the connector-conformance gate must pass before this
 * signoff can post success. Required when the connector surface changed OR
 * when the gate's own implementation changed — a change to
 * scripts/ci-mode.mjs itself must prove the conformance suite it runs still
 * passes, not just that ci:mode:test passes. There is no opt-out: a caller
 * that cannot determine what changed (e.g. `changedFilesAgainstBase` threw)
 * must treat the gate as required, not skip it.
 */
export function connectorGateRequired(changedFiles) {
  return changeTouchesConnectorSurface(changedFiles) || changeTouchesCiGateSelf(changedFiles);
}

/**
 * Decide whether ci:mode:test must pass before this signoff can post
 * success — required whenever the gate's own implementation changed, so a
 * weakened gate cannot sign itself off without exercising its own tests.
 */
export function ciModeSelfTestRequired(changedFiles) {
  return changeTouchesCiGateSelf(changedFiles);
}

function runConnectorConformanceGate() {
  console.log("a shipped manifest root or this gate changed — running the connector-conformance gate...");
  execFileSync("node", ["--test", "--test-timeout=30000", "--import", "tsx", ...CONNECTOR_CONFORMANCE_TEST_FILES], {
    cwd: "packages/polyfill-connectors",
    stdio: "inherit",
  });
}

function runStreamEvidenceInventoryGate() {
  console.log("a shipped manifest root or stream-evidence inventory input changed — running the inventory check...");
  execFileSync("node", ["scripts/stream-evidence-inventory.mjs", "--check"], { stdio: "inherit" });
}

function runCiModeSelfTest() {
  console.log("this gate changed — running ci:mode:test...");
  execFileSync("node", ["--test", "scripts/ci-mode.test.mjs"], { stdio: "inherit" });
}

function signoff(args) {
  const options = parseSignoffArgs(args);
  if (!isCleanAndPushed()) {
    throw new Error(
      "repository has uncommitted or unpushed changes; signoff always tests and signs the exact pushed HEAD, so there is no dirty-tree override"
    );
  }
  const headSha = git(["rev-parse", "HEAD"]);
  if (options.sha && options.sha !== headSha) {
    throw new Error(
      `--sha ${options.sha} does not match HEAD ${headSha}; signoff can only post a status for the commit it just tested`
    );
  }
  const sha = headSha;
  const changedFiles = changedFilesAgainstBase(options.base);
  if (streamEvidenceInventoryGateRequired(changedFiles)) {
    runStreamEvidenceInventoryGate();
  }
  if (connectorGateRequired(changedFiles)) {
    runConnectorConformanceGate();
  }
  if (ciModeSelfTestRequired(changedFiles)) {
    runCiModeSelfTest();
  }
  const body = {
    context: options.context,
    description: options.description,
    state: "success",
  };
  if (options.targetUrl) {
    body.target_url = options.targetUrl;
  }
  ghJson(["api", "--method", "POST", repoApiPath(`/statuses/${sha}`), "--input", "-"], {
    input: JSON.stringify(body),
  });
  console.log(`signed off ${sha} with ${options.context}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "status") {
    printStatus();
    return;
  }
  if (command === "hosted" || command === "local") {
    setMode(command);
    return;
  }
  if (command === "signoff") {
    signoff(args);
    return;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
