// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side "last known sync-start" marker for a single source detail page.
 *
 * The source-detail run-start toast is local acknowledgement, not durable
 * server state. A short sync can start, trigger a refresh/revalidation, and
 * still be worth showing after the component remounts. We persist only the
 * minimal non-secret toast fields needed to reconstruct that acknowledgement:
 * the exact run link, the human message, the run id when available, the tone,
 * and an expiry.
 */

export interface PersistedSyncStartToast {
  expiresAt: number;
  message: string;
  runId?: string;
  tone: "info" | "error" | "warning";
}

const SYNC_START_TOAST_PREFIX = "pdpp.sources.syncStartToast.";
const SYNC_START_TOAST_TTL_MS = 15_000;

function hasSessionStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
  } catch {
    return false;
  }
}

function isToastTone(value: unknown): value is PersistedSyncStartToast["tone"] {
  return value === "info" || value === "error" || value === "warning";
}

export function syncStartToastKey(scopeId: string): string {
  return `${SYNC_START_TOAST_PREFIX}${scopeId}`;
}

export function clearSyncStartToast(scopeId: string): void {
  if (!hasSessionStorage()) {
    return;
  }
  try {
    window.sessionStorage.removeItem(syncStartToastKey(scopeId));
  } catch {
    // Storage is best-effort only; a blocked quota must not crash the page.
  }
}

export function markSyncStartToast(
  scopeId: string,
  toast: Omit<PersistedSyncStartToast, "expiresAt">,
  ttlMs: number
): void {
  if (!hasSessionStorage()) {
    return;
  }
  try {
    const value: PersistedSyncStartToast = {
      ...toast,
      expiresAt: Date.now() + ttlMs,
    };
    window.sessionStorage.setItem(syncStartToastKey(scopeId), JSON.stringify(value));
  } catch {
    // Best-effort durability only.
  }
}

export function syncStartToastDismissDelayMs(
  toast: { readonly expiresAt?: number },
  now: number = Date.now()
): number {
  if (typeof toast.expiresAt === "number" && Number.isFinite(toast.expiresAt)) {
    return Math.max(0, toast.expiresAt - now);
  }
  return SYNC_START_TOAST_TTL_MS;
}

export function readSyncStartToast(scopeId: string): PersistedSyncStartToast | null {
  if (!hasSessionStorage()) {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(syncStartToastKey(scopeId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSyncStartToast>;
    if (
      typeof parsed.message !== "string" ||
      !isToastTone(parsed.tone) ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= Date.now()
    ) {
      clearSyncStartToast(scopeId);
      return null;
    }
    return {
      expiresAt: parsed.expiresAt,
      message: parsed.message,
      runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
      tone: parsed.tone,
    };
  } catch {
    return null;
  }
}
