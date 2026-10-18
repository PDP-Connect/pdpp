// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const SANDBOX = fileURLToPath(new URL("../test-sandbox/test-sandbox", import.meta.url));
const SANDBOX_CHILD = fileURLToPath(new URL("./sandbox-child.ts", import.meta.url));
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

async function publishedSandboxGroup(path: string): Promise<number | undefined> {
  const deadline = Date.now() + GROUP_GRACE_MS;
  let waitingReported = false;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: the sidecar publishes the group after spawning the command.
    const value = await readFile(path, "utf8").catch(() => "");
    const published = value.trim();
    const pgid = Number(published);
    if (published === "0") {
      return 0;
    }
    if (Number.isSafeInteger(pgid) && pgid > 0) {
      return pgid;
    }
    if (!waitingReported && process.env.PDPP_TEST_SANDBOX_GROUP_PUBLISH_BARRIER === "1") {
      await writeFile(`${path}.barrier.waiting`, "waiting\n");
      waitingReported = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
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
  sandboxGroupPath: () => string | undefined;
  setPgid: (pgid: number) => void;
  setSandboxGroupPath: (path: string) => void;
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
  let sandboxGroupPath: string | undefined;
  const startSignalShutdown = () => {
    if (firstSignal && pgid !== undefined && runningGroupActive && !signalShutdown) {
      const signal = firstSignal;
      const sandboxPgid = pgid;
      signalShutdown = (async () => {
        let commandGroupStopped = true;
        if (sandboxGroupPath) {
          const commandPgid = await publishedSandboxGroup(sandboxGroupPath);
          if (commandPgid === 0) {
            commandGroupStopped = true;
          } else if (commandPgid) {
            commandGroupStopped = await terminateRemainingGroup(commandPgid, signalReceivedAt, signal).catch(
              () => false
            );
          } else {
            // The command may have spawned without publishing its group yet.
            // Stop the scope, but retain scratch when that group is unknown.
            commandGroupStopped = false;
          }
        }
        const sandboxGroupStopped = await stopGroup(sandboxPgid, signalReceivedAt, signal);
        return commandGroupStopped && sandboxGroupStopped;
      })();
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
    sandboxGroupPath: () => sandboxGroupPath,
    shutdown: () => signalShutdown,
    signal: () => firstSignal,
    setPgid: (value) => {
      pgid = value;
    },
    setSandboxGroupPath: (path) => {
      sandboxGroupPath = path;
    },
  };
}

function latchedSignalResult(control: SignalControl): CommandResult | undefined {
  const signal = control.signal();
  return signal ? { code: null, signal } : undefined;
}

async function stopTrackedGroup(
  control: SignalControl,
  stopGroup: (pgid: number, startedAt?: number, initiatingSignal?: Signal) => Promise<boolean>
): Promise<boolean> {
  const pgid = control.pgid();
  if (pgid === undefined) {
    return true;
  }
  const shutdown = control.shutdown();
  if (shutdown) {
    return shutdown;
  }
  let commandGroupStopped = true;
  const commandGroupPath = control.sandboxGroupPath();
  if (commandGroupPath) {
    const commandPgid = await publishedSandboxGroup(commandGroupPath);
    if (commandPgid === undefined) {
      commandGroupStopped = false;
    } else if (commandPgid > 0) {
      commandGroupStopped = await terminateRemainingGroup(commandPgid);
    }
  }
  const sandboxGroupStopped = await stopGroup(pgid, control.receivedAt(), control.signal());
  return commandGroupStopped && sandboxGroupStopped;
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

function sandboxLaunch(
  file: string,
  args: string[],
  ownership: ScratchOwnership
): {
  file: string;
  args: string[];
  signalPath?: string;
  groupPath?: string;
} {
  if (process.env.TEST_SANDBOX_DISABLE === "1") {
    return { file, args };
  }
  const signalPath = join(ownership.allocation.root, ".sandbox-child-signal");
  const groupPath = join(ownership.allocation.root, ".sandbox-child-group");
  return {
    file: SANDBOX,
    args: [
      "--scratch",
      ownership.allocation.root,
      "--",
      process.execPath,
      "--import",
      "tsx",
      SANDBOX_CHILD,
      signalPath,
      groupPath,
      file,
      ...args,
    ],
    signalPath,
    groupPath,
  };
}

async function restoreSandboxSignal(result: CommandResult, signalPath?: string): Promise<CommandResult> {
  if (!signalPath) {
    return result;
  }
  const signal = await readFile(signalPath, "utf8").catch(() => undefined);
  const signalNumber = signal && constants.signals[signal.trim() as NodeJS.Signals];
  return signalNumber && result.code === 128 + signalNumber
    ? { code: null, signal: signal.trim() as NodeJS.Signals }
    : result;
}

function spawnOwnedCommand(launch: ReturnType<typeof sandboxLaunch>, ownership: ScratchOwnership) {
  // The collector uses mkdir -p for --scratch. A replacement root must remain
  // private even if another process removes the one we allocated.
  const previousUmask = launch.groupPath ? process.umask(0o077) : undefined;
  try {
    return spawn(launch.file, launch.args, {
      cwd: process.cwd(),
      detached: true,
      env: launch.groupPath ? { ...ownership.env, TEST_SANDBOX_PIDNS: "0" } : ownership.env,
      shell: false,
      stdio: "inherit",
    });
  } finally {
    if (previousUmask !== undefined) {
      process.umask(previousUmask);
    }
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
    const launch = sandboxLaunch(file, args, ownership);
    if (launch.groupPath) {
      control.setSandboxGroupPath(launch.groupPath);
    }
    const child = spawnOwnedCommand(launch, ownership);
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
    result = await restoreSandboxSignal(result, launch.signalPath);
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
