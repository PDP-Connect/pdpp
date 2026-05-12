/**
 * Signal-driven cleanup hook for connector subprocesses.
 *
 * When the connector runtime acquires a Chromium context, the parent
 * controller may later signal the subprocess (SIGTERM/SIGINT) to stop.
 * Without a handler, Node exits before the runtime's `finally` block
 * runs — Chromium dies with its profile lock held, and the next launch
 * fails with the "appears to be in use" error.
 *
 * `withShutdownRelease(release)` registers a one-shot SIGTERM/SIGINT
 * handler that awaits `release()` and then calls `process.exit` with the
 * conventional shell exit code for that signal (128 + signum).
 *
 * The first signal received wins; subsequent signals during cleanup are
 * ignored (otherwise a double-Ctrl-C would abort `release()` mid-flight
 * and leave a lock). If `release()` itself throws, the process still
 * exits — failing to exit during shutdown would defeat the purpose.
 *
 * Returns a `dispose()` function that:
 *   - Removes the signal handlers.
 *   - MUST be called on normal completion of the work being protected,
 *     either via try/finally or any other mechanism.
 *
 * Design contract: this complements (does not replace) the startup
 * cleanup in `profile-lock.ts`. The signal handler is the prevention
 * layer that keeps clean shutdowns from leaving locks behind. The
 * startup cleanup is the correction layer that handles SIGKILL, OOM,
 * power loss, and any other path the signal handler can't intercept.
 *
 * See docs (this brief in conversation) for the layered design rationale.
 */

const SIGNALS_TO_HOOK = ["SIGTERM", "SIGINT"] as const;
type HookableSignal = (typeof SIGNALS_TO_HOOK)[number];

const SIGNAL_EXIT_CODES: Record<HookableSignal, number> = {
  // Conventional UNIX: shell exit code = 128 + signum.
  SIGTERM: 128 + 15,
  SIGINT: 128 + 2,
};

/**
 * Install a SIGTERM/SIGINT handler that runs `release()` before exit.
 *
 * Returns `dispose()` — caller MUST invoke this when their work completes
 * normally so the handler is removed and `release()` is not double-called.
 *
 * Safe to register multiple times concurrently for different `release`s —
 * each registration adds an independent listener.
 */
export function withShutdownRelease(release: () => Promise<unknown>): () => void {
  let firing = false;

  const handle = (signal: HookableSignal) => async () => {
    if (firing) {
      return; // first signal wins; ignore duplicates during cleanup.
    }
    firing = true;
    try {
      await release();
    } catch (err) {
      // Don't block exit on a release failure. Surface to stderr so the
      // operator can see it; the SIGTERM-driven exit is more important.
      try {
        process.stderr.write(
          `[shutdown-hook] release() rejected during ${signal}: ${err instanceof Error ? err.message : String(err)}\n`
        );
      } catch {
        // stderr may be closed; nothing to do.
      }
    } finally {
      process.exit(SIGNAL_EXIT_CODES[signal]);
    }
  };

  // We need a stable reference per signal so `dispose()` can remove the
  // specific listener we added (not all listeners, which would clobber
  // sibling hooks).
  const listeners: { signal: HookableSignal; fn: () => void }[] = [];
  for (const signal of SIGNALS_TO_HOOK) {
    const fn = handle(signal);
    process.on(signal, fn);
    listeners.push({ signal, fn });
  }

  return function dispose(): void {
    for (const { signal, fn } of listeners) {
      process.removeListener(signal, fn);
    }
  };
}
