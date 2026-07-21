// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side "last-known good read" marker for the records segment.
 *
 * The records page is a `force-dynamic` server component. A transient read
 * failure during a `router.refresh()` (a poll tick or a post-Sync revalidation)
 * re-renders the server tree, and if that read throws it ejects to the segment
 * error boundary (`records/error.tsx`) — blanking every card. The boundary is
 * `"use client"` and MUST stay self-contained (it cannot import server-only
 * modules, since the dashboard shell transitively pulls in
 * `lib/owner-token.ts` → `server-only`). So the boundary cannot read live data
 * to show "last-known status".
 *
 * This module is the client-side bridge: each successful records render stamps
 * the wall-clock time into `sessionStorage`, and the boundary reads it to tell
 * the owner *when* the data it is still showing was last confirmed live. No
 * payload is cached — only the timestamp — so the boundary says "showing
 * last-known status from <ts>" honestly without duplicating the 19-card model
 * or touching a server read.
 *
 * Pure, dependency-free, and SSR-safe (guards `window`/`sessionStorage`), so it
 * is unit-testable under node and never throws into a render.
 */

const LAST_GOOD_READ_KEY = "pdpp.records.lastGoodReadAt";

/** True when a usable `sessionStorage` is available (browser, not SSR/node). */
function hasSessionStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
  } catch {
    // Some embedded contexts throw on `window.sessionStorage` access.
    return false;
  }
}

/**
 * Stamp "the records data rendered cleanly at this instant". Called from a
 * mounted client component on the records page (the poller). Swallows any
 * storage error — a full/blocked quota must never crash the page.
 */
export function markRecordsReadFresh(nowMs: number = Date.now()): void {
  if (!hasSessionStorage()) {
    return;
  }
  try {
    window.sessionStorage.setItem(LAST_GOOD_READ_KEY, String(nowMs));
  } catch {
    // Storage disabled or over quota — non-fatal; the boundary simply omits the
    // "last-known" timestamp.
  }
}

/**
 * Read the last clean-render timestamp, or `null` when none has been recorded
 * (or storage is unavailable / corrupt). The boundary uses this to phrase the
 * banner; a `null` falls back to a timestamp-free message.
 */
export function readLastRecordsReadAt(): number | null {
  if (!hasSessionStorage()) {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(LAST_GOOD_READ_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}
