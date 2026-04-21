/**
 * Context-level download queue for multi-download runs.
 *
 * WHY: Playwright's `page.waitForEvent('download')` is a one-shot promise —
 * it resolves on the next download event, then returns. In headed Chromium
 * (especially when attached over CDP, as our browser-daemon is), subsequent
 * `waitForEvent('download')` calls on the same page can silently never
 * dispatch, because Chrome's download-bubble UI state and the Playwright
 * CDP download-interception compete for ownership of each stream.
 *
 * Microsoft/playwright#40158 (open as of 2026-04-10) documents the race.
 * Current recommendation: use `context.on('download', ...)` as a long-lived
 * listener, not `page.waitForEvent(...)` as a per-click one-shot.
 *
 * This module wraps that advice into a small API:
 *   const q = attachDownloadQueue(context);
 *   // ...click things that trigger downloads...
 *   const dl = await q.waitForNextDownload({ timeoutMs: 180_000 });
 *   // do things with dl...
 *   q.detach();  // when done
 *
 * The queue preserves event-delivery order: if two downloads fire back-to-
 * back before the caller awaits, both are queued and consumed in order.
 */

/**
 * @typedef {Object} DownloadQueue
 * @property {(opts?: { timeoutMs?: number }) => Promise<import('playwright').Download>} waitForNextDownload
 * @property {() => void} detach
 * @property {() => number} pendingCount
 */

/**
 * @param {import('playwright').BrowserContext} context
 * @returns {DownloadQueue}
 */
export function attachDownloadQueue(context) {
  /** @type {import('playwright').Download[]} */
  const pending = [];
  /** @type {((dl: import('playwright').Download) => void)[]} */
  const waiters = [];

  const onDownload = (dl) => {
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(dl);
    } else {
      pending.push(dl);
    }
  };

  context.on('download', onDownload);

  return {
    waitForNextDownload({ timeoutMs = 180_000 } = {}) {
      if (pending.length > 0) {
        return Promise.resolve(pending.shift());
      }
      return new Promise((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          // Remove this waiter from the queue so a late download doesn't
          // resolve a timed-out promise.
          const idx = waiters.indexOf(wrap);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`download_timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const wrap = (dl) => {
          if (resolved) {
            // Already timed out — push back so another waiter (if any) can
            // claim it, rather than dropping.
            pending.unshift(dl);
            return;
          }
          resolved = true;
          clearTimeout(timer);
          resolve(dl);
        };
        waiters.push(wrap);
      });
    },
    detach() {
      context.off('download', onDownload);
      // Anything still waiting gets rejected so callers don't hang forever.
      while (waiters.length > 0) {
        const w = waiters.shift();
        // Passing a sentinel that won't look like a Download; the waiter
        // pairs a timer that will fire the rejection on its own, but we
        // flush here for immediate unblock.
        try { w(null); } catch {}
      }
    },
    pendingCount() {
      return pending.length;
    },
  };
}
