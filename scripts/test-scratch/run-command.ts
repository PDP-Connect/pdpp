// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  allocateScratchOwnership,
  type CleanupHooks,
  cleanupScratchOwnership,
  inheritedScratchOwnership,
  markScratchLaunching,
  markScratchRunning,
  markScratchUnlaunched,
  type RecoveryLimits,
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
  groupStopped = true,
  control?: SignalControl,
  cleanupHooks?: CleanupHooks
): Promise<CommandResult> {
  if (!groupStopped) {
    process.stderr.write("test scratch cleanup failed: group-still-live\n");
    const signalResult = control && latchedSignalResult(control);
    return signalResult ?? (result.code === 0 ? { code: INFRASTRUCTURE_EXIT_CODE, signal: null } : result);
  }
  try {
    await cleanupScratchOwnership(ownership, cleanupHooks);
    return (control && latchedSignalResult(control)) ?? result;
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed";
    process.stderr.write(`test scratch cleanup failed: ${reason}\n`);
    const signalResult = control && latchedSignalResult(control);
    return signalResult ?? (result.code === 0 ? { code: INFRASTRUCTURE_EXIT_CODE, signal: null } : result);
  }
}

export interface RunScratchCommandOptions {
  /** Test seam after allocation but before durable launch or child spawn. */
  afterAllocationBeforeSpawn?: () => Promise<void>;
  /** Test seam after latching signals but before recovery starts. */
  afterSignalHandlersInstalled?: () => Promise<void>;
  /** Test seam after spawn and before the running PGID becomes durable. */
  afterSpawnBeforeRunning?: () => Promise<void>;
  /** Test seam for signals arriving during asynchronous cleanup. */
  cleanupHooks?: CleanupHooks;
  /** Fixed startup-recovery limits, exposed only for deterministic lifecycle tests. */
  recoveryLimits?: Partial<RecoveryLimits>;
  /** Test seam for the fail-closed path after a process-group shutdown attempt. */
  stopGroup?: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>;
}

interface SignalControl {
  activateRunningGroup: (pgid: number) => void;
  pgid: () => number | undefined;
  receivedAt: () => number | undefined;
  release: () => void;
  setPgid: (pgid: number) => void;
  shutdown: () => Promise<boolean> | undefined;
  signal: () => Signal | undefined;
}

function installSignalControl(
  stopGroup: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>
): SignalControl {
  let firstSignal: Signal | undefined;
  let pgid: number | undefined;
  let runningGroupActive = false;
  let signalReceivedAt: number | undefined;
  let signalShutdown: Promise<boolean> | undefined;
  const startSignalShutdown = () => {
    if (firstSignal && pgid !== undefined && runningGroupActive && !signalShutdown) {
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
  return {
    activateRunningGroup: (value) => {
      pgid = value;
      runningGroupActive = true;
      startSignalShutdown();
    },
    pgid: () => pgid,
    receivedAt: () => signalReceivedAt,
    release: () => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    },
    shutdown: () => signalShutdown,
    signal: () => firstSignal,
    setPgid: (value) => {
      pgid = value;
    },
  };
}

function latchedSignalResult(control: SignalControl): CommandResult | undefined {
  const signal = control.signal();
  return signal ? { code: null, signal } : undefined;
}

function stopTrackedGroup(
  control: SignalControl,
  stopGroup: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>
): Promise<boolean> {
  const pgid = control.pgid();
  if (pgid === undefined) {
    return Promise.resolve(true);
  }
  const shutdown = control.shutdown();
  return shutdown ?? stopGroup(pgid, control.receivedAt(), control.signal());
}

async function stopTrackedGroupSafely(
  control: SignalControl,
  stopGroup: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>
): Promise<boolean> {
  try {
    return await stopTrackedGroup(control, stopGroup);
  } catch {
    // A rejected shutdown proof is the same fail-closed outcome as a live group:
    // retain the root, but preserve the child's already-observed result.
    process.stderr.write("test scratch cleanup failed: group-shutdown-failed\n");
    return false;
  }
}

async function runLaunchedCommand(
  command: string[],
  ownership: ScratchOwnership,
  control: SignalControl,
  options: RunScratchCommandOptions,
  stopGroup: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>
): Promise<CommandResult> {
  let runningRecorded = false;
  let result: CommandResult | undefined;
  try {
    const [file, ...args] = command;
    if (!file) {
      return cleanupWithResult(
        ownership,
        { code: INFRASTRUCTURE_EXIT_CODE, signal: null },
        true,
        control,
        options.cleanupHooks
      );
    }
    const child = spawn(file, args, {
      cwd: process.cwd(),
      detached: true,
      env: ownership.env,
      shell: false,
      stdio: "inherit",
    });
    const observed = observeChild(child);
    if (!child.pid) {
      await markScratchUnlaunched(ownership);
      throw new ScratchOwnershipError("spawn-failed");
    }
    control.setPgid(child.pid);
    if (options.afterSpawnBeforeRunning) {
      await options.afterSpawnBeforeRunning();
    }
    await markScratchRunning(ownership, child.pid);
    runningRecorded = true;
    control.activateRunningGroup(child.pid);
    result = await observed.close;
    if (observed.launchError()) {
      throw observed.launchError();
    }
    const groupStopped = await stopTrackedGroupSafely(control, stopGroup);
    const signalResult = latchedSignalResult(control);
    return cleanupWithResult(ownership, signalResult ?? result, groupStopped, control, options.cleanupHooks);
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "spawn-failed";
    process.stderr.write(`test scratch command failed: ${reason}\n`);
    const pgid = control.pgid();
    const groupStopped = await stopTrackedGroupSafely(control, stopGroup);
    const signalResult = latchedSignalResult(control);
    if (!runningRecorded) {
      process.stderr.write("test scratch cleanup failed: launch-unknown\n");
      if (signalResult) {
        return signalResult;
      }
      return pgid === undefined
        ? cleanupWithResult(
            ownership,
            { code: INFRASTRUCTURE_EXIT_CODE, signal: null },
            true,
            control,
            options.cleanupHooks
          )
        : { code: INFRASTRUCTURE_EXIT_CODE, signal: null };
    }
    return cleanupWithResult(
      ownership,
      signalResult ?? result ?? { code: INFRASTRUCTURE_EXIT_CODE, signal: null },
      groupStopped,
      control,
      options.cleanupHooks
    );
  }
}

async function runAllocatedCommand(
  command: string[],
  ownership: ScratchOwnership,
  control: SignalControl,
  options: RunScratchCommandOptions,
  stopGroup: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>
): Promise<CommandResult> {
  // Once the durable transition has been attempted, its on-disk outcome is
  // ambiguous on failure. Preserve the launching root rather than guessing.
  let launchTransitionAttempted = false;
  try {
    const signalBeforeLaunch = latchedSignalResult(control);
    if (signalBeforeLaunch) {
      return cleanupWithResult(ownership, signalBeforeLaunch, true, control, options.cleanupHooks);
    }
    await options.afterAllocationBeforeSpawn?.();
    const signalBeforeSpawn = latchedSignalResult(control);
    if (signalBeforeSpawn) {
      return cleanupWithResult(ownership, signalBeforeSpawn, true, control, options.cleanupHooks);
    }
    launchTransitionAttempted = true;
    await markScratchLaunching(ownership);
    const signalAfterLaunching = latchedSignalResult(control);
    if (signalAfterLaunching) {
      await markScratchUnlaunched(ownership);
      return cleanupWithResult(ownership, signalAfterLaunching, true, control, options.cleanupHooks);
    }
    return await runLaunchedCommand(command, ownership, control, options, stopGroup);
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "launch-failed";
    process.stderr.write(`test scratch launch failed: ${reason}\n`);
    const signalResult = latchedSignalResult(control);
    if (signalResult) {
      return launchTransitionAttempted
        ? signalResult
        : cleanupWithResult(ownership, signalResult, true, control, options.cleanupHooks);
    }
    return cleanupWithResult(
      ownership,
      { code: INFRASTRUCTURE_EXIT_CODE, signal: null },
      true,
      control,
      options.cleanupHooks
    );
  }
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
  const stopGroup = options.stopGroup ?? terminateRemainingGroup;
  const control = installSignalControl(stopGroup);
  try {
    await options.afterSignalHandlersInstalled?.();
    // Recovery is intentionally opportunistic; malformed and live candidates remain.
    await recoverStaleScratch(options.recoveryLimits === undefined ? {} : { limits: options.recoveryLimits });
    const signalResult = latchedSignalResult(control);
    if (signalResult) {
      return signalResult;
    }
    let ownership: ScratchOwnership;
    try {
      ownership = await allocateScratchOwnership();
    } catch (error) {
      const latched = latchedSignalResult(control);
      if (latched) {
        return latched;
      }
      const reason = error instanceof ScratchOwnershipError ? error.reason : "allocation-failed";
      process.stderr.write(`test scratch allocation failed: ${reason}\n`);
      return { code: INFRASTRUCTURE_EXIT_CODE, signal: null };
    }
    return await runAllocatedCommand(command, ownership, control, options, stopGroup);
  } catch (error) {
    const signalResult = latchedSignalResult(control);
    if (signalResult) {
      return signalResult;
    }
    const reason = error instanceof ScratchOwnershipError ? error.reason : "recovery-failed";
    process.stderr.write(`test scratch recovery failed: ${reason}\n`);
    return { code: INFRASTRUCTURE_EXIT_CODE, signal: null };
  } finally {
    control.release();
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
