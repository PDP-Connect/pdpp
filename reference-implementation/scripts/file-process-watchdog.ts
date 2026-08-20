// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

/**
 * Bound a child process by output inactivity and by an independent absolute
 * per-file deadline.
 *
 * A test file can be finite but slower than the inactivity budget when the
 * machine is loaded. Output keeps that budget alive. The hard deadline still
 * bounds a continuously chatty process that never terminates.
 */

const WATCHDOG_TICK_MS = 1000;

type Timer = ReturnType<typeof setInterval>;

export type FileProcessTimeoutReason = "hard" | "idle";

export interface FileProcessWatchdog {
  clear: () => void;
  markProgress: () => void;
  timeoutReason: () => FileProcessTimeoutReason | undefined;
}

export interface FileProcessWatchdogOptions {
  cancel?: (timer: Timer) => void;
  hardDeadlineMs: number;
  idleBudgetMs: number;
  kill: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
}

function assertValidDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer number of milliseconds`);
  }
}

/** Start a per-file inactivity and hard-deadline watchdog. */
export function startFileProcessWatchdog({
  cancel = clearInterval,
  hardDeadlineMs,
  idleBudgetMs,
  kill,
  now = () => performance.now(),
  schedule = setInterval,
}: FileProcessWatchdogOptions): FileProcessWatchdog {
  assertValidDuration("hardDeadlineMs", hardDeadlineMs);
  assertValidDuration("idleBudgetMs", idleBudgetMs);
  if (hardDeadlineMs < idleBudgetMs) {
    throw new Error("hardDeadlineMs must be greater than or equal to idleBudgetMs");
  }

  const startedAt = now();
  let active = true;
  let lastProgressAt = startedAt;
  let reason: FileProcessTimeoutReason | undefined;
  let timer: Timer | undefined;

  const stopTimer = () => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };

  const check = () => {
    if (!active) {
      return;
    }
    const currentTime = now();
    if (currentTime - startedAt >= hardDeadlineMs) {
      reason = "hard";
    } else if (currentTime - lastProgressAt >= idleBudgetMs) {
      reason = "idle";
    } else {
      return;
    }
    active = false;
    stopTimer();
    kill();
  };

  timer = schedule(check, Math.max(1, Math.min(WATCHDOG_TICK_MS, idleBudgetMs, hardDeadlineMs)));
  timer.unref?.();

  return {
    clear: () => {
      if (!active) {
        return;
      }
      active = false;
      stopTimer();
    },
    markProgress: () => {
      if (active) {
        lastProgressAt = now();
      }
    },
    timeoutReason: () => reason,
  };
}
