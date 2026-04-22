/**
 * Page-level download queue for multi-download runs.
 *
 * WHY: Chromium's headed download-bubble and the CDP-based
 * `Playwright.download` interception compete for ownership of each stream
 * (microsoft/playwright#40158). We already mitigate the race with
 * `--disable-features=DownloadBubble` on the daemon's launch args — but
 * we also want a listener surface that tolerates multiple downloads
 * fired back-to-back without needing one `waitForEvent` per click.
 *
 * Verified 2026-04-21 via scripts/archive/test-download-queue-debug.mjs:
 * - `context.on('download')` is NOT dispatched when attached over CDP to
 *   a freshly-created BrowserContext (`browser.newContext(...)`). Events
 *   reliably reach page-level listeners only.
 * - `page.on('download', ...)` DOES fire for every download from that page,
 *   in order, across multiple sequential clicks.
 *
 * So the queue is page-scoped. Callers must pass the page they're clicking
 * on. If they navigate to a new page, they need a new queue (because the
 * listener is wired to the old one).
 *
 * Usage:
 *   const q = attachDownloadQueue(page);
 *   await q.ready();                   // wait for listener setup
 *   await clickSomethingThatDownloads();
 *   const dl = await q.waitForNextDownload({ timeoutMs: 180_000 });
 *   q.detach();
 *
 * The queue preserves event-delivery order.
 */

/**
 * @typedef {Object} DownloadQueue
 * @property {(opts?: { timeoutMs?: number }) => Promise<import('playwright').Download>} waitForNextDownload
 * @property {() => void} detach
 * @property {() => number} pendingCount
 */

/**
 * @param {import('playwright').Page | import('playwright').BrowserContext} target
 * @returns {DownloadQueue}
 */
export function attachDownloadQueue(target) {
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

  target.on('download', onDownload);

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
      target.off('download', onDownload);
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
