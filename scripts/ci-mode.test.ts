#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CI_GATE_SELF_PATHS,
  changeTouchesCiGateSelf,
  ciModeSelfTestRequired,
  detectCiMode,
  getRequiredStatusContexts,
  HOSTED_CONTEXT,
  LOCAL_CONTEXT,
  rulesetWithRequiredStatusContexts,
  workflowUpdatesForMode,
} from "./ci-mode.ts";

const CI_MODE_SCRIPT = fileURLToPath(new URL("./ci-mode.ts", import.meta.url));
const REPOSITORY_ROOT = dirname(dirname(CI_MODE_SCRIPT));

const UNCOMMITTED_OR_UNPUSHED_PATTERN = /uncommitted or unpushed changes/;
const DOES_NOT_MATCH_HEAD_PATTERN = /does not match HEAD/;

function fixtureRuleset() {
  return {
    bypass_actors: [] as unknown[],
    conditions: { ref_name: { exclude: [] as string[], include: ["refs/heads/main"] } },
    enforcement: "active",
    id: 17_916_203,
    name: "main: require PR + reference-implementation check",
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
          required_reviewers: [] as unknown[],
        },
        type: "pull_request",
      },
      {
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: HOSTED_CONTEXT }],
          strict_required_status_checks_policy: false,
        },
        type: "required_status_checks",
      },
    ],
    target: "branch",
  };
}

test("detectCiMode recognizes hosted and local modes", () => {
  assert.equal(detectCiMode([HOSTED_CONTEXT]), "hosted");
  assert.equal(detectCiMode([LOCAL_CONTEXT]), "local");
  assert.equal(detectCiMode(["other"]), "custom");
});

test("rulesetWithRequiredStatusContexts replaces only required status contexts", () => {
  const ruleset = fixtureRuleset();
  const next = rulesetWithRequiredStatusContexts(ruleset, [LOCAL_CONTEXT]);

  assert.deepEqual(getRequiredStatusContexts(next), [LOCAL_CONTEXT]);
  assert.deepEqual(next.conditions, ruleset.conditions);
  assert.equal(next.enforcement, ruleset.enforcement);
  assert.equal(next.name, ruleset.name);
  assert.equal(next.target, ruleset.target);
  assert.deepEqual(next.bypass_actors, []);
  assert.deepEqual(next.rules?.[0], ruleset.rules[0]);
  assert.deepEqual(next.rules?.[1], ruleset.rules[1]);
  assert.deepEqual(next.rules?.[2], ruleset.rules[2]);
  assert.equal(
    (next.rules?.[3]?.parameters as { do_not_enforce_on_create?: boolean } | undefined)?.do_not_enforce_on_create,
    false
  );
  assert.equal(
    (next.rules?.[3]?.parameters as { strict_required_status_checks_policy?: boolean } | undefined)
      ?.strict_required_status_checks_policy,
    false
  );
});

test("rulesetWithRequiredStatusContexts can add a required status rule if absent", () => {
  const ruleset = fixtureRuleset();
  const withoutStatusRule = {
    ...ruleset,
    rules: ruleset.rules.filter((rule) => rule.type !== "required_status_checks"),
  };
  const next = rulesetWithRequiredStatusContexts(withoutStatusRule, [LOCAL_CONTEXT]);

  assert.deepEqual(getRequiredStatusContexts(next), [LOCAL_CONTEXT]);
  assert.equal(next.rules?.length, withoutStatusRule.rules.length + 1);
});

test("workflowUpdatesForMode disables only active managed workflows in local mode", () => {
  const updates = workflowUpdatesForMode(
    [
      { id: 1, path: ".github/workflows/reference-implementation.yml", state: "active" },
      { id: 2, path: ".github/workflows/spec-check.yml", state: "disabled_manually" },
      { id: 3, path: ".github/workflows/other.yml", state: "active" },
    ],
    "local",
    [".github/workflows/reference-implementation.yml", ".github/workflows/spec-check.yml"]
  );

  assert.deepEqual(
    updates.map((update) => ({
      action: update.action,
      missing: update.missing,
      needsChange: update.needsChange,
      path: update.path,
      state: update.state,
    })),
    [
      {
        action: "disable",
        missing: false,
        needsChange: true,
        path: ".github/workflows/reference-implementation.yml",
        state: "active",
      },
      {
        action: "disable",
        missing: false,
        needsChange: false,
        path: ".github/workflows/spec-check.yml",
        state: "disabled_manually",
      },
    ]
  );
});

test("workflowUpdatesForMode enables non-active managed workflows in hosted mode", () => {
  const updates = workflowUpdatesForMode(
    [
      { id: 1, path: ".github/workflows/reference-implementation.yml", state: "disabled_manually" },
      { id: 2, path: ".github/workflows/spec-check.yml", state: "active" },
    ],
    "hosted",
    [".github/workflows/reference-implementation.yml", ".github/workflows/spec-check.yml"]
  );

  assert.deepEqual(
    updates.map((update) => ({
      action: update.action,
      missing: update.missing,
      needsChange: update.needsChange,
      path: update.path,
      state: update.state,
    })),
    [
      {
        action: "enable",
        missing: false,
        needsChange: true,
        path: ".github/workflows/reference-implementation.yml",
        state: "disabled_manually",
      },
      {
        action: "enable",
        missing: false,
        needsChange: false,
        path: ".github/workflows/spec-check.yml",
        state: "active",
      },
    ]
  );
});

test("changeTouchesCiGateSelf pins the gate implementation paths", () => {
  const expectedSelfPaths = ["scripts/ci-mode.ts", "scripts/ci-mode.test.ts", "package.json"];
  assert.deepEqual(CI_GATE_SELF_PATHS, expectedSelfPaths);
  for (const path of expectedSelfPaths) {
    assert.equal(changeTouchesCiGateSelf([path]), true);
    assert.equal(ciModeSelfTestRequired([path]), true);
  }
  assert.equal(changeTouchesCiGateSelf(["scripts/other-script.ts"]), false);
  assert.equal(changeTouchesCiGateSelf([]), false);
});

test("ciModeSelfTestRequired does not over-trigger outside the pinned gate paths", () => {
  assert.equal(ciModeSelfTestRequired(["CONTRIBUTING.md"]), false);
});

/**
 * Build an isolated temp git repo containing only the files signoff's
 * pre-flight checks need (this script, so `main` can run; a real bare
 * "origin" remote so isCleanAndPushed's @{push} + --base origin/main both
 * resolve honestly instead of faking a ref). Never touches the real repo's
 * git state — no stash, no shared worktree risk.
 */
function initSignoffFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "ci-mode-signoff-test-"));
  const bareDir = join(root, "origin.git");
  const dir = join(root, "work");
  execFileSync("git", ["init", "--bare", "--quiet", bareDir]);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["clone", "--quiet", bareDir, dir], { stdio: ["ignore", "ignore", "ignore"] });
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "ci-mode test"]);
  run(["checkout", "-b", "main", "--quiet"]);
  // The signoff CLI runs under `node --import tsx`; Node resolves that loader
  // specifier from the nearest package.json, so an isolated fixture repo
  // needs its own minimal one plus the real node_modules symlinked in.
  writeFileSync(join(dir, "package.json"), '{"name":"ci-mode-signoff-fixture","private":true,"type":"module"}\n');
  symlinkSync(join(REPOSITORY_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, ".gitignore"), "node_modules\nbin/\ngh-status-posted.txt\n");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  run(["add", "."]);
  run(["commit", "--quiet", "-m", "initial"]);
  run(["push", "--quiet", "-u", "origin", "main"]);
  run(["checkout", "-b", "feature", "--quiet"]);
  run(["push", "--quiet", "-u", "origin", "feature"]);
  return { dir, root, run };
}

function cleanupSignoffFixtureRepo({ root }: { root: string }) {
  rmSync(root, { recursive: true, force: true });
}

function runSignoffCli(dir: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync("node", ["--import", "tsx", CI_MODE_SCRIPT, "signoff", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
  });
}

test("signoff CLI rejects a dirty worktree before any gh call", () => {
  const fixture = initSignoffFixtureRepo();
  try {
    writeFileSync(join(fixture.dir, "README.md"), "dirty\n");
    assert.throws(() => runSignoffCli(fixture.dir, []), UNCOMMITTED_OR_UNPUSHED_PATTERN);
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test("signoff CLI rejects --sha that does not match HEAD", () => {
  const fixture = initSignoffFixtureRepo();
  try {
    const firstSha = fixture.run(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(fixture.dir, "other.txt"), "x\n");
    fixture.run(["add", "other.txt"]);
    fixture.run(["commit", "--quiet", "-m", "second"]);
    fixture.run(["push", "--quiet"]);
    assert.throws(() => runSignoffCli(fixture.dir, ["--sha", firstSha]), DOES_NOT_MATCH_HEAD_PATTERN);
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test("signoff CLI fails closed when --base cannot be resolved", () => {
  const fixture = initSignoffFixtureRepo();
  try {
    assert.throws(() => runSignoffCli(fixture.dir, ["--base", "origin/does-not-exist"]));
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test("workflowUpdatesForMode reports missing managed workflows", () => {
  const updates = workflowUpdatesForMode([], "local", [".github/workflows/reference-implementation.yml"]);

  assert.deepEqual(
    updates.map((update) => ({
      action: update.action,
      missing: update.missing,
      needsChange: update.needsChange,
      path: update.path,
      state: update.state,
    })),
    [
      {
        action: "disable",
        missing: true,
        needsChange: false,
        path: ".github/workflows/reference-implementation.yml",
        state: "missing",
      },
    ]
  );
});
