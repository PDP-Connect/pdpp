// Browser-enrollment-shell TTL retirement sweep.
//
// Every browser-enrollment shell is created with an `enrollment_expires_at`
// field inside its sourceBinding. This module provides a pure retirement sweep
// that can be called at startup or from a periodic handler to flip expired
// shell rows to `revoked`. A browser run can temporarily activate the draft
// row before source identity is captured, so the durable completion signal is
// the source-binding kind moving away from `browser_enrollment_shell`, not the
// status alone.
//
// The sweep is intentionally side-effect-free in its pure form: it accepts a
// list of shells and returns the IDs that should be retired, so it is directly
// unit-testable without a database. The imperative variant wraps the scan.

import type { BrowserEnrollmentShellSourceBinding } from "./routes/ref-browser-enrollment-shell.ts";

export interface EnrollmentShellLike {
  readonly connectorInstanceId: string;
  readonly sourceBinding?: Record<string, unknown> | null;
  readonly status: string;
}

// Has this one enrollment shell's TTL expired relative to `nowMs`? The `nowMs`
// cutoff that the enclosing filter used to capture from its closure is now an
// EXPLICIT parameter, so this is a pure predicate over one shell. Only draft/
// active shells carrying a real `browser_enrollment_shell` binding with a
// parseable declared TTL are eligible; anything else (wrong status, wrong
// binding kind, missing/malformed TTL) is conservatively not-yet-expired.
function enrollmentShellExpired(shell: EnrollmentShellLike, nowMs: number): boolean {
  if (shell.status !== "draft" && shell.status !== "active") {
    return false;
  }
  const binding = shell.sourceBinding as Partial<BrowserEnrollmentShellSourceBinding> | null;
  if (binding?.kind !== "browser_enrollment_shell") {
    return false;
  }
  const expiresAt = binding.enrollment_expires_at;
  if (typeof expiresAt !== "string") {
    return false;
  }
  const expiresMs = new Date(expiresAt).getTime();
  return !Number.isNaN(expiresMs) && expiresMs <= nowMs;
}

// Returns the connectorInstanceIds of browser-enrollment shells whose TTL has
// expired relative to `now`. Draft and active shell rows are both eligible:
// active only means a run started, not that enrollment completed. Missing or
// malformed `enrollment_expires_at` is treated conservatively as not-yet-
// expired (the data-ops retirement contract applies only to shells with a
// declared TTL).
export function expiredEnrollmentShellIds(shells: readonly EnrollmentShellLike[], now: string): readonly string[] {
  const nowMs = new Date(now).getTime();
  return shells.filter((shell) => enrollmentShellExpired(shell, nowMs)).map((shell) => shell.connectorInstanceId);
}

export interface ShellRetirementStore {
  // List all unresolved browser-enrollment shell instances (any connector) for
  // the given owner, or all owners if ownerSubjectId is null. Implementations
  // may scope this to `source_binding_json->>'kind' =
  // 'browser_enrollment_shell'` for efficiency.
  listDraftBrowserEnrollmentShells(ownerSubjectId: string | null): Promise<EnrollmentShellLike[]>;
  updateStatus(
    connectorInstanceId: string,
    args: { status: string; updatedAt: string; revokedAt?: string | null }
  ): Promise<unknown>;
}

// Retires all expired browser-enrollment shells system-wide (or scoped to one
// owner). Returns the list of retired connection IDs for caller logging.
export async function retireExpiredBrowserEnrollmentShells(
  store: ShellRetirementStore,
  { now, ownerSubjectId = null }: { now: string; ownerSubjectId?: string | null }
): Promise<readonly string[]> {
  const shells = await store.listDraftBrowserEnrollmentShells(ownerSubjectId);
  const ids = expiredEnrollmentShellIds(shells, now);
  for (const id of ids) {
    await store.updateStatus(id, { status: "revoked", updatedAt: now, revokedAt: now });
  }
  return ids;
}
