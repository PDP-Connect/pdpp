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

function waitForClose(child: ReturnType<typeof spawn>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
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

async function terminateRemainingGroup(pgid: number): Promise<void> {
  if (!groupExists(pgid)) {
    return;
  }
  signalGroup(pgid, "SIGTERM");
  if (!(await waitForGroup(pgid, GROUP_GRACE_MS))) {
    signalGroup(pgid, "SIGKILL");
    await waitForGroup(pgid, GROUP_GRACE_MS);
  }
}

function runParticipant(command: string[]): Promise<CommandResult> {
  const [file, ...args] = command;
  if (!file) {
    throw new ScratchOwnershipError("usage");
  }
  return waitForClose(spawn(file, args, { cwd: process.cwd(), env: process.env, shell: false, stdio: "inherit" }));
}

async function cleanupWithResult(ownership: ScratchOwnership, result: CommandResult): Promise<CommandResult> {
  try {
    await cleanupScratchOwnership(ownership);
    return result;
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed";
    process.stderr.write(`test scratch cleanup failed: ${reason}\n`);
    return result.code === 0 ? { code: INFRASTRUCTURE_EXIT_CODE, signal: null } : result;
  }
}

export async function runScratchCommand(argv: string[]): Promise<CommandResult> {
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
  const forwardSignal = (signal: Signal) => {
    firstSignal ??= signal;
    if (pgid !== undefined) {
      try {
        signalGroup(pgid, signal);
      } catch {
        // Cleanup reports the final infrastructure failure if the root cannot be removed.
      }
    }
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
    if (!child.pid) {
      throw new ScratchOwnershipError("spawn-failed");
    }
    pgid = child.pid;
    await markScratchRunning(ownership, pgid);
    let result = await waitForClose(child);
    await terminateRemainingGroup(pgid);
    if (firstSignal) {
      result = { code: null, signal: firstSignal };
    }
    return await cleanupWithResult(ownership, result);
  } catch (error) {
    const reason = error instanceof ScratchOwnershipError ? error.reason : "spawn-failed";
    process.stderr.write(`test scratch command failed: ${reason}\n`);
    return await cleanupWithResult(ownership, { code: INFRASTRUCTURE_EXIT_CODE, signal: null });
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
