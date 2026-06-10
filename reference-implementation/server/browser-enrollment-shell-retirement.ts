// Browser-enrollment-shell TTL retirement sweep.
//
// Every browser-enrollment shell is created with an `enrollment_expires_at`
// field inside its sourceBinding. This module provides a pure retirement sweep
// that can be called at startup or from a periodic handler to flip expired
// `draft` shells to `revoked`. Active shells (enrollment completed → ingest
// flipped them to `active`) are never touched.
//
// The sweep is intentionally side-effect-free in its pure form: it accepts a
// list of shells and returns the IDs that should be retired, so it is directly
// unit-testable without a database. The imperative variant wraps the scan.

import type { BrowserEnrollmentShellSourceBinding } from "./routes/ref-browser-enrollment-shell.ts";

export interface EnrollmentShellLike {
  readonly connectorInstanceId: string;
  readonly status: string;
  readonly sourceBinding?: Record<string, unknown> | null;
}

// Returns the connectorInstanceIds of draft browser-enrollment shells whose
// TTL has expired relative to `now`. Active shells are excluded (they already
// completed enrollment). Missing/malformed `enrollment_expires_at` is treated
// conservatively as not-yet-expired (the data-ops retirement contract applies
// only to shells with a declared TTL).
export function expiredEnrollmentShellIds(
  shells: readonly EnrollmentShellLike[],
  now: string
): readonly string[] {
  const nowMs = new Date(now).getTime();
  return shells
    .filter((shell) => {
      if (shell.status !== "draft") return false;
      const binding = shell.sourceBinding as Partial<BrowserEnrollmentShellSourceBinding> | null;
      if (binding?.kind !== "browser_enrollment_shell") return false;
      const expiresAt = binding.enrollment_expires_at;
      if (typeof expiresAt !== "string") return false;
      const expiresMs = new Date(expiresAt).getTime();
      return !Number.isNaN(expiresMs) && expiresMs <= nowMs;
    })
    .map((shell) => shell.connectorInstanceId);
}

export interface ShellRetirementStore {
  // List all draft instances (any connector) for the given owner, or all owners
  // if ownerSubjectId is null. Implementations may scope this to
  // `source_binding_json->>'kind' = 'browser_enrollment_shell'` for efficiency.
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
