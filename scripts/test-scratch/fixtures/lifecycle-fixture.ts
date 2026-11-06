// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one place the lifecycle oracle creates temporary directories for, launches,
// and cleans up after a command that runs through the scratch wrapper.
//
// Two mistakes broke this suite on a runner image that ships bubblewrap, and this
// fixture makes both of them impossible rather than something each test remembers:
//
// 1. Path visibility. `scripts/test-sandbox/test-sandbox` gives the command a
//    private /tmp and binds back only the top directory of its scratch root. A
//    helper file in any other directory under /tmp is invisible to the command.
//    The fixture hands out paths only inside `runnerTemp` (the scratch root's top
//    directory) and `spawn` rejects any argument or environment value that names
//    another path under a host temporary directory.
// 2. Leaked groups. A test that kills an owner on purpose leaves the command's
//    process group running if an assertion then fails. That group still holds the
//    stdout/stderr pipes of the wrapper, so the test process never exits and the
//    CI step hangs instead of ending red. The fixture closes every pipe it opened,
//    kills every wrapper it started, and kills every process group recorded under
//    its scratch root when the test ends, whatever the outcome.

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TestContext } from "node:test";

export interface LifecycleFixture {
  /** Point this process's `RUNNER_TEMP` at `runnerTemp` until the test ends, for in-process `runScratchCommand`. */
  adoptAsRunnerTemp: () => void;
  /** Create `name` inside `runnerTemp` and return its path. */
  dir: (name: string) => Promise<string>;
  /** `process.env` with `RUNNER_TEMP` pointing at `runnerTemp`, plus `overrides`. */
  env: (overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** A path inside `runnerTemp`; throws for anything that would resolve outside it. */
  path: (...segments: string[]) => string;
  /** The only directory tree a command launched through this fixture may name. */
  readonly runnerTemp: string;
  /** Where the wrapper allocates its per-run scratch roots. */
  readonly scratchParent: string;
  /**
   * Start a process that runs the wrapper, or a stand-in for it. The process is
   * guarded (see `assertCommandSeesOnlyBoundPaths`) and killed with its pipes
   * closed when the test ends.
   */
  spawn: (file: string, args: readonly string[], spawnOptions?: SpawnOptions) => ChildProcess;
}

// Host directories whose contents a bwrap-private /tmp hides. A value that names
// one of these but is not inside `runnerTemp` is the mistake the guard rejects.
function hostTemporaryRoots(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/var/tmp"].map((root) => resolve(root)))];
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

/** Absolute-path tokens in one argument or value: a PATH-style list or `--flag=/path` yields each path. */
const PATH_TOKEN_SEPARATOR = /[:=]/;

function pathTokens(value: string): string[] {
  return value.split(PATH_TOKEN_SEPARATOR).filter((token) => token.startsWith("/"));
}

/**
 * Throw if any argument or non-inherited environment value names a path under a
 * host temporary directory that is outside `runnerTemp`. The sandbox would hide
 * that path from the command, so a test using it fails by timing out.
 */
export function assertCommandSeesOnlyBoundPaths(
  runnerTemp: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): void {
  const inherited = process.env;
  const values = [
    ...args,
    ...Object.entries(env)
      .filter(([key, value]) => value !== undefined && value !== inherited[key])
      .map(([, value]) => value as string),
  ];
  const roots = hostTemporaryRoots();
  for (const value of values) {
    for (const token of pathTokens(value)) {
      const path = resolve(token);
      if (roots.some((root) => isInside(root, path)) && !isInside(runnerTemp, path)) {
        throw new Error(
          `${token} is outside the bound runner temp ${runnerTemp}; the sandbox's private /tmp hides it from the command. ` +
            "Create it with fixture.dir() or fixture.path()."
        );
      }
    }
  }
}

async function recordedGroups(scratchParent: string): Promise<number[]> {
  const roots = (await readdir(scratchParent).catch(() => [] as string[])).map((entry) => join(scratchParent, entry));
  const texts = await Promise.all(
    roots.flatMap((root) => [
      readFile(join(root, ".pdpp-test-scratch.json"), "utf8")
        .then((text) => String((JSON.parse(text) as { pgid?: unknown }).pgid))
        .catch(() => ""),
      readFile(join(root, ".sandbox-child-group"), "utf8").catch(() => ""),
    ])
  );
  return texts
    .map((text) => Number(text.trim()))
    .filter((pgid) => Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid && pgid !== process.ppid);
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

/** Create a fixture for one test; everything it handed out is cleaned up in the test's `after` hook. */
export async function lifecycleFixture(
  t: TestContext,
  options: { /** Parent of `runnerTemp`; defaults to the host temporary directory. */ under?: string } = {}
): Promise<LifecycleFixture> {
  const runnerTemp = await mkdtemp(join(options.under ?? tmpdir(), "pdpp-test-scratch-test-"));
  const scratchParent = join(runnerTemp, "pdpp-test-scratch");
  const children: ChildProcess[] = [];
  const restoreEnv: Array<() => void> = [];

  const path = (...segments: string[]): string => {
    const resolved = resolve(runnerTemp, ...segments);
    if (!isInside(runnerTemp, resolved)) {
      throw new Error(`${resolved} is outside the bound runner temp ${runnerTemp}`);
    }
    return resolved;
  };
  const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    ...overrides,
    RUNNER_TEMP: runnerTemp,
  });

  t.after(async () => {
    for (const restore of restoreEnv.reverse()) {
      restore();
    }
    for (const proc of children) {
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
        killQuietly(proc.pid);
      }
    }
    for (const pgid of await recordedGroups(scratchParent)) {
      killQuietly(-pgid);
    }
    await rm(runnerTemp, { force: true, recursive: true });
  });

  return {
    runnerTemp,
    scratchParent,
    path,
    env,
    async dir(name) {
      const target = path(name);
      await mkdir(target, { recursive: true });
      return target;
    },
    spawn(file, args, spawnOptions = {}) {
      const launchEnv = spawnOptions.env ?? env();
      if (launchEnv.RUNNER_TEMP !== runnerTemp) {
        throw new Error(`RUNNER_TEMP must be the fixture's runner temp ${runnerTemp}; got ${launchEnv.RUNNER_TEMP}`);
      }
      assertCommandSeesOnlyBoundPaths(runnerTemp, args, launchEnv);
      const proc = nodeSpawn(file, args, { ...spawnOptions, env: launchEnv });
      children.push(proc);
      return proc;
    },
    adoptAsRunnerTemp() {
      const previous = process.env.RUNNER_TEMP;
      process.env.RUNNER_TEMP = runnerTemp;
      restoreEnv.push(() => {
        if (previous === undefined) {
          delete process.env.RUNNER_TEMP;
        } else {
          process.env.RUNNER_TEMP = previous;
        }
      });
    },
  };
}
