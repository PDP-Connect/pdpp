// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildIsolatedEnvironment,
  createIsolatedWorkspace,
  defaultWorkspacePolicy,
  destroyWorkspace,
  gitCommonDirFor,
  listQuarantinedWorkspaces,
  quarantineWorkspace,
  runInWorkspace,
  type WorkspacePolicy,
} from "./workspace.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Builds a tiny, real, standalone (non-worktree) git repo to clone from — cheap and fully independent, so this test never touches the real PDPP repository's actual object store. */
async function makeSourceRepo(): Promise<{ headSha: string; sourceRepoRoot: string }> {
  const sourceRepoRoot = await mkdtemp(join(tmpdir(), "mutation-falsification-source-"));
  git(["init", "-q", "-b", "main"], sourceRepoRoot);
  git(["config", "user.email", "test@example.com"], sourceRepoRoot);
  git(["config", "user.name", "Test"], sourceRepoRoot);
  await writeFile(resolve(sourceRepoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(resolve(sourceRepoRoot, "hello.txt"), "hello\n");
  git(["add", "-A"], sourceRepoRoot);
  git(["commit", "-q", "-m", "initial"], sourceRepoRoot);
  const headSha = git(["rev-parse", "HEAD"], sourceRepoRoot);
  return { sourceRepoRoot, headSha };
}

async function withTempWorkspaceRoot(fn: (root: string) => Promise<void>): Promise<void> {
  // Real disk-backed temp dir under the OS temp root, for this test's OWN
  // throwaway workspace policy — production policy defaults to
  // ~/.tmp/mutation-falsification/ (see defaultWorkspaceRoot), but the test
  // must not litter that shared, potentially-real-evidence-adjacent path.
  const root = await mkdtemp(join(tmpdir(), "mutation-falsification-workspace-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("createIsolatedWorkspace: clone's git common-dir is independent of the source repo's", async () => {
  const { sourceRepoRoot, headSha } = await makeSourceRepo();
  try {
    await withTempWorkspaceRoot(async (workspaceRoot) => {
      const policy: WorkspacePolicy = {
        workspaceRoot,
        minFreeBytesPreflight: 1024,
        environmentAllowlist: [],
      };
      const workspace = await createIsolatedWorkspace(policy, sourceRepoRoot, headSha);
      try {
        const sourceCommonDir = gitCommonDirFor(sourceRepoRoot);
        const cloneCommonDir = gitCommonDirFor(workspace.repoRoot);
        assert.notEqual(cloneCommonDir, sourceCommonDir);
        assert.ok(
          cloneCommonDir.startsWith(resolve(workspace.workspaceDir)),
          `clone's git common-dir ${cloneCommonDir} must resolve under the workspace ${workspace.workspaceDir}`
        );
        // Mutating the clone must never touch the source repo.
        await writeFile(resolve(workspace.repoRoot, "hello.txt"), "mutated\n");
        git(["add", "-A"], workspace.repoRoot);
        git(["commit", "-q", "-m", "mutant"], workspace.repoRoot);
        const sourceHeadAfter = git(["rev-parse", "HEAD"], sourceRepoRoot);
        assert.equal(sourceHeadAfter, headSha, "mutating the clone must not affect the source repo's HEAD");
      } finally {
        await destroyWorkspace(workspace.workspaceDir);
      }
    });
  } finally {
    await rm(sourceRepoRoot, { recursive: true, force: true });
  }
});

test("buildIsolatedEnvironment: starts from empty, never inherits an unlisted host var (credential-sentinel)", () => {
  const hostEnv: NodeJS.ProcessEnv = {
    HOME: "/home/real-host-user",
    PATH: "/usr/bin",
    SECRET_API_KEY: "sk-should-never-appear",
    AWS_SECRET_ACCESS_KEY: "also-should-never-appear",
  };
  const env = buildIsolatedEnvironment("/workspace/attempt-1", { environmentAllowlist: [] }, hostEnv);
  // Sentinel host values must be ABSENT or explicitly overridden to the
  // isolated value — never passed through ambiently.
  assert.notEqual(env.HOME, hostEnv.HOME);
  assert.ok(env.HOME?.startsWith("/workspace/attempt-1"));
  assert.equal(env.SECRET_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("buildIsolatedEnvironment: passes through only policy-allowlisted names, with their real values", () => {
  const hostEnv: NodeJS.ProcessEnv = { HOME: "/home/real", NODE_ENV: "test", SECRET_TOKEN: "shh" };
  const env = buildIsolatedEnvironment("/workspace/attempt-2", { environmentAllowlist: ["NODE_ENV"] }, hostEnv);
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.SECRET_TOKEN, undefined);
});

test("buildIsolatedEnvironment: every WRITABLE attempt-local path resolves beneath the workspace directory", () => {
  const env = buildIsolatedEnvironment("/workspace/attempt-3", { environmentAllowlist: [] }, { PATH: "/usr/bin" });
  for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "PNPM_HOME", "npm_config_virtual_store_dir"]) {
    assert.ok(env[key]?.startsWith("/workspace/attempt-3"), `${key} must resolve under the workspace: ${env[key]}`);
  }
});

test("buildIsolatedEnvironment: npm_config_store_dir and COREPACK_HOME deliberately reuse shared READ-ONLY host content, not attempt-local paths", () => {
  const env = buildIsolatedEnvironment(
    "/workspace/attempt-4",
    { environmentAllowlist: [] },
    { PATH: "/usr/bin", npm_config_store_dir: "/host/pnpm-store", COREPACK_HOME: "/host/corepack-cache" }
  );
  // These are the two deliberate exceptions to "every writable path is
  // attempt-local": both point at read-only, content-addressed, pinned
  // host content (a package store and an interpreter shim cache) that this
  // workspace only ever READS from, never writes new content into outside
  // its own attempt-local virtual store/copy-import tree.
  assert.equal(env.npm_config_store_dir, "/host/pnpm-store");
  assert.equal(env.COREPACK_HOME, "/host/corepack-cache");
});

test("defaultWorkspacePolicy: default workspace root is not under /tmp", () => {
  const policy = defaultWorkspacePolicy();
  assert.ok(!policy.workspaceRoot.startsWith("/tmp/"), `workspace root must not be RAM-backed: ${policy.workspaceRoot}`);
});

test("quarantineWorkspace: a quarantined workspace is excluded from a subsequent scan for reuse", async () => {
  await withTempWorkspaceRoot(async (workspaceRoot) => {
    const fakeAttemptDir = resolve(workspaceRoot, "attempt-abc");
    await mkdir(fakeAttemptDir, { recursive: true });
    await writeFile(resolve(fakeAttemptDir, "marker.txt"), "was mid-run\n");
    const quarantinedDir = await quarantineWorkspace(fakeAttemptDir, "cleanup interrupted mid-run");
    const quarantined = await listQuarantinedWorkspaces(workspaceRoot);
    assert.equal(quarantined.length, 1);
    assert.ok(quarantinedDir.includes("quarantined-"));
  });
});

test("runInWorkspace: kills the process group and reports deadlineFired when the wall deadline is exceeded", async () => {
  const result = await runInWorkspace(["sleep", "5"], process.cwd(), { PATH: process.env.PATH ?? "" }, 200);
  assert.equal(result.deadlineFired, true);
  assert.notEqual(result.exitCode, 0);
});

test("runInWorkspace: a command that finishes well within budget reports deadlineFired: false", async () => {
  const result = await runInWorkspace(["true"], process.cwd(), { PATH: process.env.PATH ?? "" }, 5000);
  assert.equal(result.deadlineFired, false);
  assert.equal(result.exitCode, 0);
});
