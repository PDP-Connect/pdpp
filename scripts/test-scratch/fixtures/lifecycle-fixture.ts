// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one place the lifecycle oracle creates directories for, launches, and cleans up
// after a command that runs through the scratch wrapper. It makes two mistakes that hung
// CI on a runner image with bubblewrap impossible rather than something each test remembers:
//
// 1. A helper the command cannot see. `scripts/test-sandbox/test-sandbox` gives the command
//    a private /tmp and binds back only the top directory of its scratch root. `path` and
//    `dir` hand out paths only inside `runnerTemp`, and `spawn` rejects a declared helper
//    outside it.
// 2. A process the test leaves behind. A leftover command group keeps the wrapper's pipes
//    open, so the test process never exits. Teardown closes the pipes and kills what the
//    fixture launched.
//
// Ownership is the launch environment: `spawn` requires `RUNNER_TEMP` to be this fixture's
// unique `runnerTemp`, and every descendant, including one in the sandbox, inherits it.
// Teardown kills exactly the processes carrying that value. It never signals a recorded
// pid or group id, so a stale or reused id cannot name an unrelated process.

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TestContext } from "node:test";

export interface LifecycleFixture {
  /** Create `name` inside `runnerTemp` and return its path. */
  dir: (name: string) => Promise<string>;
  /** `process.env` with `RUNNER_TEMP` pointing at `runnerTemp`, plus `overrides`. */
  env: (overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** A path inside `runnerTemp`; throws for anything that would resolve outside it. */
  path: (...segments: string[]) => string;
  /** The only directory tree a helper handed to a launched command may live in. */
  readonly runnerTemp: string;
  /** Where the wrapper allocates its per-run scratch roots. */
  readonly scratchParent: string;
  /** Start a process, killed with its pipes closed when the test ends. Each of `helpers` (files the command uses) must be inside `runnerTemp`. */
  spawn: (
    file: string,
    args: readonly string[],
    options?: SpawnOptions & { helpers?: readonly string[] }
  ) => ChildProcess;
  /** Point this process's `RUNNER_TEMP` at `runnerTemp` until the test ends; repeated calls change nothing. */
  useRunnerTempForThisTest: () => void;
}

const DIGITS = /^\d+$/;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

/** Pids other than this process whose environment carries `entry`; undefined when `/proc` is unreadable. */
async function pidsCarrying(entry: string): Promise<number[] | undefined> {
  const names = await readdir("/proc").catch(() => undefined);
  if (names === undefined) {
    return;
  }
  const pids = await Promise.all(
    names
      .filter((name) => DIGITS.test(name))
      .map(async (name) => {
        const environment = await readFile(`/proc/${name}/environ`, "utf8").catch(() => "");
        return environment.split("\0").includes(entry) ? Number(name) : 0;
      })
  );
  return pids.filter((pid) => pid > 0 && pid !== process.pid);
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

/**
 * Kill every process whose environment carries `entry`, scanning again because a parent may
 * fork once more before it dies. False when ownership cannot be established (no `/proc`).
 */
async function killCarriers(entry: string, passesLeft = 5): Promise<boolean> {
  const pids = await pidsCarrying(entry);
  if (pids === undefined) {
    return false;
  }
  if (pids.length === 0 || passesLeft === 0) {
    return true;
  }
  for (const pid of pids) {
    killQuietly(pid);
  }
  return killCarriers(entry, passesLeft - 1);
}

/** Create a fixture for one test; everything it handed out is cleaned up in the test's `after` hook. */
export async function lifecycleFixture(
  t: TestContext,
  options: { /** Parent of `runnerTemp`; defaults to the host temporary directory. */ under?: string } = {}
): Promise<LifecycleFixture> {
  const runnerTemp = await mkdtemp(join(options.under ?? tmpdir(), "pdpp-test-scratch-test-"));
  const children: ChildProcess[] = [];
  let restoreRunnerTemp: (() => void) | undefined;

  const inside = (candidate: string): string => {
    if (!isInside(runnerTemp, candidate)) {
      throw new Error(
        `${candidate} is outside the bound runner temp ${runnerTemp}; the sandbox's private /tmp hides it from the command`
      );
    }
    return candidate;
  };
  const path = (...segments: string[]): string => inside(resolve(runnerTemp, ...segments));
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    ...overrides,
    RUNNER_TEMP: runnerTemp,
  });

  t.after(async () => {
    const mayHaveLaunched = children.length > 0 || restoreRunnerTemp !== undefined;
    restoreRunnerTemp?.();
    for (const proc of children) {
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      // An unreaped child still owns its pid, so signalling it by handle cannot hit another process.
      if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
        killQuietly(proc.pid);
      }
    }
    // A test that launched nothing and never adopted RUNNER_TEMP has nothing to reap.
    if (mayHaveLaunched && !(await killCarriers(`RUNNER_TEMP=${runnerTemp}`))) {
      t.diagnostic(`/proc is unreadable, so descendants of ${runnerTemp} cannot be proven ours; none were killed`);
    }
    await rm(runnerTemp, { force: true, recursive: true });
  });

  return {
    runnerTemp,
    scratchParent: join(runnerTemp, "pdpp-test-scratch"),
    path,
    env,
    async dir(name) {
      const target = path(name);
      await mkdir(target, { recursive: true });
      return target;
    },
    spawn(file, args, { helpers = [], ...spawnOptions } = {}) {
      const launchEnv = spawnOptions.env ?? env();
      if (launchEnv.RUNNER_TEMP !== runnerTemp) {
        throw new Error(`RUNNER_TEMP must be the fixture's runner temp ${runnerTemp}; got ${launchEnv.RUNNER_TEMP}`);
      }
      for (const helper of helpers) {
        inside(resolve(helper));
      }
      const proc = nodeSpawn(file, args, { ...spawnOptions, env: launchEnv });
      children.push(proc);
      return proc;
    },
    useRunnerTempForThisTest() {
      if (restoreRunnerTemp) {
        return;
      }
      const previous = process.env.RUNNER_TEMP;
      process.env.RUNNER_TEMP = runnerTemp;
      restoreRunnerTemp = () => {
        if (previous === undefined) {
          delete process.env.RUNNER_TEMP;
        } else {
          process.env.RUNNER_TEMP = previous;
        }
      };
    },
  };
}
