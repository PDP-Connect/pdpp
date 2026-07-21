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
 * Verified 2026-04-21: `context.on('download')` is NOT dispatched when
 * attached over CDP to
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

import type { Download, Page } from "playwright";

export interface DownloadQueue {
  detach(): void;
  pendingCount(): number;
  waitForNextDownload(opts?: { timeoutMs?: number }): Promise<Download>;
}

/**
 * Wrapper a waiter callback can accept. We reject pending waiters on detach
 * by calling them with `null`; the wrap checks for this and the pending
 * timer fires the real rejection.
 */
type Waiter = (dl: Download | null) => void;

export function attachDownloadQueue(target: Page): DownloadQueue {
  const pending: Download[] = [];
  const waiters: Waiter[] = [];

  const onDownload = (dl: Download): void => {
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      if (resolve) {
        resolve(dl);
      }
    } else {
      pending.push(dl);
    }
  };

  target.on("download", onDownload);

  return {
    waitForNextDownload({ timeoutMs = 180_000 } = {}): Promise<Download> {
      if (pending.length > 0) {
        const first = pending.shift();
        if (first) {
          return Promise.resolve(first);
        }
      }
      return new Promise<Download>((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (resolved) {
            return;
          }
          resolved = true;
          // Remove this waiter from the queue so a late download doesn't
          // resolve a timed-out promise.
          const idx = waiters.indexOf(wrap);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(new Error(`download_timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const wrap: Waiter = (dl) => {
          if (resolved) {
            // Already timed out — push back so another waiter (if any) can
            // claim it, rather than dropping.
            if (dl) {
              pending.unshift(dl);
            }
            return;
          }
          if (!dl) {
            // Detached; let the timer fire the real rejection.
            return;
          }
          resolved = true;
          clearTimeout(timer);
          resolve(dl);
        };
        waiters.push(wrap);
      });
    },
    detach(): void {
      target.off("download", onDownload);
      // Anything still waiting gets rejected so callers don't hang forever.
      while (waiters.length > 0) {
        const w = waiters.shift();
        // Passing a sentinel that won't look like a Download; the waiter
        // pairs a timer that will fire the rejection on its own, but we
        // flush here for immediate unblock.
        try {
          w?.(null);
        } catch {
          /* ignore */
        }
      }
    },
    pendingCount(): number {
      return pending.length;
    },
  };
}
