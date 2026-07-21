// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owns the periodic browser-surface lease sweep's `setInterval` lifecycle.
 * Extracted so the timer seam (exactly one interval per start, unref'd,
 * cleared on stop, no double-start, no post-stop execution, no
 * listener/timer accumulation when bound to external close sources) is
 * directly testable with fake timers — no live allocator or HTTP boot
 * required.
 */

/** Minimal shape of anything the timer can bind its stop to — any Node EventEmitter-like object that emits 'close' once (http.Server, net.Server, ...). */
export interface BrowserSurfaceLeaseSweepCloseSource {
  once(event: "close", listener: () => void): unknown;
}

export interface BrowserSurfaceLeaseSweepTimerOptions {
  readonly clearIntervalFn?: (timer: NodeJS.Timeout) => void;
  readonly intervalMs: number;
  readonly onSweepError?: (err: unknown) => void;
  /** Injectable for tests. Defaults to the global timer functions. */
  readonly setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  readonly sweep: () => Promise<void>;
}

export interface BrowserSurfaceLeaseSweepTimer {
  start(): void;
  stop(): void;
  /**
   * Stop this timer once EVERY given close source has emitted its own
   * 'close' event — NOT on the first. The timer's sweep can depend on
   * state (e.g. a shared controller) that remains reachable through any
   * one of several servers; closing one source while another still serves
   * that state must NOT stop the sweep. Only once all sources have closed
   * does the underlying state become fully unreachable, and the timer
   * stops (idempotently — safe to call stop() again from any path,
   * including this one racing an explicit stop()).
   */
  stopWhenAllClosed(sources: readonly BrowserSurfaceLeaseSweepCloseSource[]): void;
}

export function createBrowserSurfaceLeaseSweepTimer(
  options: BrowserSurfaceLeaseSweepTimerOptions
): BrowserSurfaceLeaseSweepTimer {
  const { sweep, intervalMs, onSweepError } = options;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let timer: NodeJS.Timeout | null = null;

  function runTick(): void {
    sweep().catch((err) => {
      onSweepError?.(err);
    });
  }

  function stop(): void {
    if (!timer) {
      return;
    }
    clearIntervalFn(timer);
    timer = null;
  }

  return {
    start(): void {
      if (timer) {
        return;
      }
      timer = setIntervalFn(runTick, intervalMs);
      if (typeof (timer as { unref?: () => void })?.unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    },
    stop,
    stopWhenAllClosed(sources: readonly BrowserSurfaceLeaseSweepCloseSource[]): void {
      if (sources.length === 0) {
        return;
      }
      let remaining = sources.length;
      for (const source of sources) {
        source.once("close", () => {
          remaining -= 1;
          if (remaining <= 0) {
            stop();
          }
        });
      }
    },
  };
}
