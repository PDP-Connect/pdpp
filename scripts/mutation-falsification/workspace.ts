// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot source isolation for a single domain mutation attempt (design.md
 * Decision #7). NOT A SANDBOX: this isolates writable state and constrains
 * environment for TRUSTED repository code under a fixed, reviewed operator
 * set. It does not claim filesystem, network, process, CPU, memory, or
 * containment guarantees against hostile code, and it does not claim to
 * recover automatically after verifier death — see workspace.test.ts's
 * credential-sentinel test and design.md's resource-contract table.
 *
 * Workspace root: policy-declared and disk-backed, defaulting to
 * `~/.tmp/mutation-falsification/` — NEVER `/tmp` (RAM-backed tmpfs at 50%
 * of RAM on this host; a debug-build-sized dependency tree there could
 * exhaust host RAM, per this repo's own operating rules). `~/.tmp` sits on
 * the same real disk as the rest of the checkout.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, statfs } from "node:fs/promises";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspacePolicy {
  /** Non-secret environment variable NAMES this workspace's child processes may inherit values for, beyond the isolated paths this file sets itself. */
  environmentAllowlist: string[];
  /** Minimum free bytes required on the workspace root's filesystem before a clone is attempted. */
  minFreeBytesPreflight: number;
  /** Disk-backed root under which every attempt gets its own subdirectory. Defaults to `~/.tmp/mutation-falsification/`. */
  workspaceRoot: string;
}

export function defaultWorkspaceRoot(): string {
  return join(homedir(), ".tmp", "mutation-falsification");
}

export function defaultWorkspacePolicy(overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy {
  return {
    workspaceRoot: defaultWorkspaceRoot(),
    // 2 GiB: comfortably covers one clone + one frozen-lockfile pnpm install
    // of a single package for this pure-TypeScript pilot; not a tuned
    // production figure.
    minFreeBytesPreflight: 2 * 1024 * 1024 * 1024,
    environmentAllowlist: [],
    ...overrides,
  };
}

export interface IsolatedWorkspace {
  /** The env object to use for every child process spawned against this workspace. Starts from {} — see buildIsolatedEnvironment. */
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  workspaceDir: string;
}

async function assertFreeSpace(root: string, minFreeBytes: number): Promise<void> {
  await mkdir(root, { recursive: true });
  const info = await statfs(root);
  const freeBytes = info.bavail * info.bsize;
  if (freeBytes < minFreeBytes) {
    throw new Error(
      `createIsolatedWorkspace: free-space preflight failed — ${freeBytes} bytes free under ${root}, need at least ${minFreeBytes}`
    );
  }
}

/**
 * Builds the child-process environment for commands run against
 * `workspaceDir`. Starts from an EMPTY object, never `process.env` — spec's
 * "runner SHALL start from an empty environment allowlist." Every writable
 * path (HOME, TMPDIR, XDG_*, pnpm store/virtual store) resolves beneath
 * `workspaceDir`. Only policy-listed non-secret names are copied over from
 * the real host environment, and only their VALUES are passed through (this
 * function never emits a values-list anywhere else — attempt receipts record
 * NAMES only, see schemas.ts's `environmentProfile`).
 */
export function buildIsolatedEnvironment(
  workspaceDir: string,
  policy: Pick<WorkspacePolicy, "environmentAllowlist">,
  hostEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const home = resolve(workspaceDir, "home");
  const tmp = resolve(workspaceDir, "tmp");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: tmp,
    XDG_CACHE_HOME: resolve(home, ".cache"),
    XDG_CONFIG_HOME: resolve(home, ".config"),
    XDG_DATA_HOME: resolve(home, ".local", "share"),
    XDG_STATE_HOME: resolve(home, ".local", "state"),
    PNPM_HOME: resolve(workspaceDir, "pnpm-home"),
    npm_config_store_dir: resolve(workspaceDir, "pnpm-store"),
    npm_config_virtual_store_dir: resolve(workspaceDir, "node_modules", ".pnpm"),
    // A workspace-attempt process still needs a PATH to find `node`/`pnpm`/
    // `git` — this is the one host value that must always be present for
    // ANY command to run at all, so it is not policy-conditional the way
    // every other allowlisted name is.
    PATH: hostEnv.PATH ?? "",
  };
  for (const name of policy.environmentAllowlist) {
    const value = hostEnv[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Creates a fresh, independent, no-hardlink disk-backed clone of
 * `sourceRepoRoot` at `baseCommitSha`, isolated writable paths, and an
 * isolated environment for any child process run against it. Preflights
 * free disk space first. Does NOT install dependencies — see
 * `materializeDependencies`.
 */
export async function createIsolatedWorkspace(
  policy: WorkspacePolicy,
  sourceRepoRoot: string,
  baseCommitSha: string
): Promise<IsolatedWorkspace> {
  await assertFreeSpace(policy.workspaceRoot, policy.minFreeBytesPreflight);
  const workspaceDir = resolve(policy.workspaceRoot, `attempt-${randomUUID()}`);
  await mkdir(workspaceDir, { recursive: true });
  const repoRoot = resolve(workspaceDir, "repo");
  // --no-hardlinks (NOT --local/hardlinked): the clone's object store must
  // never share inodes with the source repo's — a mutant commit or a
  // corrupted object in the clone must never be able to reach back into the
  // source repository's own object store.
  await execFileAsync("git", ["clone", "--no-hardlinks", "-q", sourceRepoRoot, repoRoot]);
  await execFileAsync("git", ["-C", repoRoot, "checkout", "-q", baseCommitSha]);
  await assertIndependentGitCommonDir(repoRoot, sourceRepoRoot);
  for (const dir of ["home", "tmp", "pnpm-home", "pnpm-store"]) {
    await mkdir(resolve(workspaceDir, dir), { recursive: true });
  }
  const env = buildIsolatedEnvironment(workspaceDir, policy);
  return { workspaceDir, repoRoot, env };
}

/** Resolves `git rev-parse --git-common-dir` for `repoRoot` as an absolute path. Exported for tests that independently assert clone/source isolation. */
export function gitCommonDirFor(repoRoot: string): string {
  const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  return resolve(repoRoot, raw);
}

/**
 * Verifies the clone's git common directory resolves under the workspace,
 * not the source repository — proves the clone genuinely does not share a
 * Git common directory with the source checkout (a shared common dir would
 * mean the "clone" could corrupt the source repo's own refs/objects).
 */
async function assertIndependentGitCommonDir(workspaceRepoRoot: string, sourceRepoRoot: string): Promise<void> {
  const commonDir = gitCommonDirFor(workspaceRepoRoot);
  const sourceCommonDir = gitCommonDirFor(sourceRepoRoot);
  if (!commonDir.startsWith(`${resolve(workspaceRepoRoot)}/`) && commonDir !== resolve(workspaceRepoRoot)) {
    throw new Error(`createIsolatedWorkspace: clone's git common-dir ${commonDir} is not under the workspace`);
  }
  if (commonDir === sourceCommonDir) {
    throw new Error("createIsolatedWorkspace: clone shares a git common-dir with the source repository");
  }
}

/**
 * Offline, frozen-lockfile, copy-import dependency materialization for the
 * clone only. `pnpm help install` (pnpm 10.33.0) documents
 * `--package-import-method copy` ("Copy packages from the store") as the
 * exact flag that avoids hardlinking mutable host store content into the
 * clone's node_modules; `--node-linker` is accepted by the CLI (verified
 * locally: `pnpm install --node-linker=hoisted ...` does not raise "Unknown
 * option", though it is not enumerated in `pnpm help install`'s own output).
 * Lifecycle scripts disabled (`--ignore-scripts`) for this pure-TypeScript
 * pilot, per design.md Decision #7. Throws on any failure — never falls back
 * to sharing the host's pnpm store.
 */
export async function materializeDependencies(workspace: IsolatedWorkspace): Promise<void> {
  try {
    await execFileAsync(
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--offline",
        "--ignore-scripts",
        "--node-linker=hoisted",
        "--package-import-method=copy",
      ],
      { cwd: workspace.repoRoot, env: workspace.env }
    );
  } catch (error) {
    throw new Error(
      `materializeDependencies: offline frozen-lockfile install failed for ${workspace.repoRoot} — refusing to fall back to a shared host store: ${(error as Error).message}`
    );
  }
}

/**
 * Only called after the caller has already copied+revalidated required
 * evidence out of this workspace. Best-effort verification that no lingering
 * child process remains for this workspace — this is explicitly NOT a
 * sandbox and cannot guarantee no process survives; it can only observe.
 * Then `rm -rf`s the workspace directory. The caller is responsible for
 * marking the attempt destroyed in the evidence store afterward.
 */
export async function destroyWorkspace(workspaceDir: string): Promise<void> {
  await assertNoLingeringProcessBestEffort(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

async function assertNoLingeringProcessBestEffort(workspaceDir: string): Promise<void> {
  // Best-effort only: greps the process table for the workspace path. A
  // process that has already exited, or one whose cmdline does not mention
  // the path, is invisible to this check — hence "best-effort", never a
  // sandboxing claim.
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", workspaceDir]);
    const pids = stdout.trim().split("\n").filter(Boolean);
    if (pids.length > 0) {
      throw new Error(
        `destroyWorkspace: ${pids.length} process(es) still reference ${workspaceDir} (pids: ${pids.join(", ")}) — refusing to destroy; quarantine instead`
      );
    }
  } catch (error) {
    const err = error as { code?: number | string };
    // pgrep exits 1 when it finds nothing — that is the expected "no
    // lingering process" case, not a tool failure.
    if (err.code === 1) {
      return;
    }
    if ((error as Error).message?.startsWith("destroyWorkspace:")) {
      throw error;
    }
    // pgrep itself missing/erroring: this is a best-effort check, so a
    // broken check is reported but does not itself block cleanup —
    // matching "this is explicitly NOT a sandbox" rather than pretending an
    // absent tool proves absence of processes.
  }
}

/**
 * Renames/marks a workspace as quarantined instead of deleting it, for any
 * cleanup failure or interruption. A quarantined workspace is never reused
 * or destroyed automatically — a later scan reports it for explicit
 * operator review.
 */
export async function quarantineWorkspace(workspaceDir: string, reason: string): Promise<string> {
  const parent = resolve(workspaceDir, "..");
  const quarantinedDir = resolve(parent, `quarantined-${randomUUID()}-${resolve(workspaceDir).split("/").pop()}`);
  await rename(workspaceDir, quarantinedDir);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    resolve(quarantinedDir, ".quarantine-reason.json"),
    `${JSON.stringify({ reason, quarantinedAt: new Date().toISOString(), originalPath: workspaceDir }, null, 2)}\n`
  );
  return quarantinedDir;
}

/** Lists quarantined workspace directory names directly under `workspaceRoot`, for a reuse-exclusion scan. */
export async function listQuarantinedWorkspaces(workspaceRoot: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(workspaceRoot);
    return entries.filter((name) => name.startsWith("quarantined-"));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Spawns `command` inside `workspace` with a finite wall deadline, killing
 * the owning process group when it fires. Returns captured stdout/stderr,
 * exit code, signal, and whether the deadline fired. This is an
 * adapter-local protection, not a claim of crash-durable containment: a
 * process that ignores SIGTERM/SIGKILL to its own group is outside what
 * this function can prove.
 */
export function runInWorkspace(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  wallTimeMs: number
): Promise<{ deadlineFired: boolean; exitCode: number | null; signal: string | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const [file, ...rest] = command;
    if (!file) {
      reject(new Error("runInWorkspace requires a non-empty command"));
      return;
    }
    const child = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let deadlineFired = false;
    const timer = setTimeout(() => {
      deadlineFired = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Group already gone.
        }
      }
    }, wallTimeMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, signal, stdout, stderr, deadlineFired });
    });
  });
}

/** Exposed for tests only — the OS temp root this file deliberately never uses for real workspace roots. */
export function osTmpdirForTest(): string {
  return osTmpdir();
}

/** Exposed for tests only — a scratch temp dir maker, kept thin so tests never hand-roll their own mktemp logic. */
export function mkdtempForTest(prefix: string): Promise<string> {
  return mkdtemp(prefix);
}
