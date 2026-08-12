// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  allocateScratchOwnership,
  cleanupScratchOwnership,
  inheritedScratchOwnership,
  markScratchRunning,
  recoverStaleScratch,
  type ScratchOwnership,
  ScratchOwnershipError,
} from "./ownership.ts";

const INFRASTRUCTURE_EXIT_CODE = 74;
const GROUP_GRACE_MS = 3000;
type Signal = "SIGINT" | "SIGTERM";

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function parseCommand(argv: string[]): string[] {
  if (argv[0] !== "--" || argv.length < 2) {
    throw new ScratchOwnershipError("usage", "usage: pnpm test:scratch -- <command> [args...]");
  }
  return argv.slice(1);
}

interface ObservedChild {
  close: Promise<CommandResult>;
  launchError: () => unknown;
}

/** Attach error handling before any asynchronous marker work can yield. */
function observeChild(child: ReturnType<typeof spawn>): ObservedChild {
  let error: unknown;
  const close = new Promise<CommandResult>((resolve) => {
    child.once("error", (launchError) => {
      error = launchError;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { close, launchError: () => error };
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForGroup(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pgid) && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling observes process-group quiescence.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !groupExists(pgid);
}

/**
 * Stop the exact group and prove that it is gone before its scratch can be
 * removed. `startedAt` is the time the wrapper received its signal, rather
 * than the time its direct child eventually closes.
 */
async function terminateRemainingGroup(
  pgid: number,
  startedAt = Date.now(),
  initiatingSignal: Signal = "SIGTERM"
): Promise<boolean> {
  if (!groupExists(pgid)) {
    return true;
  }
  signalGroup(pgid, initiatingSignal);
  const termGraceRemaining = Math.max(0, GROUP_GRACE_MS - (Date.now() - startedAt));
  if (await waitForGroup(pgid, termGraceRemaining)) {
    return true;
  }
  signalGroup(pgid, "SIGKILL");
  return waitForGroup(pgid, GROUP_GRACE_MS);
}

function runParticipant(command: string[]): Promise<CommandResult> {
  const [file, ...args] = command;
  if (!file) {
    throw new ScratchOwnershipError("usage");
  }
  const observed = observeChild(
    spawn(file, args, { cwd: process.cwd(), env: process.env, shell: false, stdio: "inherit" })
  );
  return observed.close.then((result) => {
    if (observed.launchError()) {
      throw observed.launchError();
    }
    return result;
  });
}

async function cleanupWithResult(
  ownership: ScratchOwnership,
  result: CommandResult,
  groupStopped = true
): Promise<CommandResult> {
  if (!groupStopped) {
    process.stderr.write("test scratch cleanup failed: group-still-live\n");
    return result.code === 0 ? { code: INFRASTRUCTURE_EXIT_CODE, signal: null } : result;
  }
  try {
    await cleanupScratchOwnership(ownership);
    return result;
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed";
    process.stderr.write(`test scratch cleanup failed: ${reason}\n`);
    return result.code === 0 ? { code: INFRASTRUCTURE_EXIT_CODE, signal: null } : result;
  }
}

export interface RunScratchCommandOptions {
  /** Test seam for the signal window before the child PID is latched as PGID. */
  beforePgidAssignment?: () => Promise<void>;
  /** Test seam for the fail-closed path after a process-group shutdown attempt. */
  stopGroup?: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>;
}

export async function runScratchCommand(
  argv: string[],
  options: RunScratchCommandOptions = {}
): Promise<CommandResult> {
  const command = parseCommand(argv);
  const participant = await inheritedScratchOwnership();
  if (participant) {
    return runParticipant(command);
  }
  let ownership: ScratchOwnership;
  try {
    // Recovery is intentionally opportunistic; malformed and live candidates remain.
    await recoverStaleScratch();
    ownership = await allocateScratchOwnership();
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "allocation-failed";
    process.stderr.write(`test scratch allocation failed: ${reason}\n`);
    return { code: INFRASTRUCTURE_EXIT_CODE, signal: null };
  }
  const [file, ...args] = command;
  if (!file) {
    return cleanupWithResult(ownership, { code: INFRASTRUCTURE_EXIT_CODE, signal: null });
  }
  let firstSignal: Signal | undefined;
  let pgid: number | undefined;
  let signalReceivedAt: number | undefined;
  let signalShutdown: Promise<boolean> | undefined;
  const stopGroup = options.stopGroup ?? terminateRemainingGroup;
  const startSignalShutdown = () => {
    if (firstSignal && pgid !== undefined && !signalShutdown) {
      signalShutdown = stopGroup(pgid, signalReceivedAt, firstSignal);
    }
  };
  const forwardSignal = (signal: Signal) => {
    firstSignal ??= signal;
    signalReceivedAt ??= Date.now();
    startSignalShutdown();
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  try {
    const child = spawn(file, args, {
      cwd: process.cwd(),
      detached: true,
      env: ownership.env,
      shell: false,
      stdio: "inherit",
    });
    const observed = observeChild(child);
    if (!child.pid) {
      throw new ScratchOwnershipError("spawn-failed");
    }
    await options.beforePgidAssignment?.();
    pgid = child.pid;
    startSignalShutdown();
    await markScratchRunning(ownership, pgid);
    let result = await observed.close;
    if (observed.launchError()) {
      throw observed.launchError();
    }
    const groupStopped = signalShutdown ? await signalShutdown : await stopGroup(pgid);
    if (firstSignal) {
      result = { code: null, signal: firstSignal };
    }
    return await cleanupWithResult(ownership, result, groupStopped);
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "spawn-failed";
    process.stderr.write(`test scratch command failed: ${reason}\n`);
    let groupStopped = true;
    if (pgid !== undefined) {
      groupStopped = signalShutdown ? await signalShutdown : await stopGroup(pgid, signalReceivedAt, firstSignal);
    }
    return await cleanupWithResult(ownership, { code: INFRASTRUCTURE_EXIT_CODE, signal: null }, groupStopped);
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

async function main(): Promise<void> {
  const result = await runScratchCommand(process.argv.slice(2));
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? INFRASTRUCTURE_EXIT_CODE;
}

if (import.meta.main) {
  await main();
}
