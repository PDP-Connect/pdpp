// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
//
// `runInFlight` is the fifth guard and the only one that is not a property of
// the shell row itself: a shell the owner is actively signing into must not be
// revoked out from under him mid-attempt. See `expiredEnrollmentShellIds`.
function enrollmentShellExpired(shell: EnrollmentShellLike, nowMs: number, runInFlight: boolean): boolean {
  if (runInFlight) {
    return false;
  }
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
//
// `runInFlightInstanceIds` holds the connectorInstanceIds that currently own a
// durable controller run claim (`controller_active_runs`, one row per in-flight
// run). A shell in that set is NEVER retired, however far past its TTL it is.
//
// WHY: the shell TTL answers "has the owner abandoned this setup?", and an
// in-flight run is direct evidence that he has not. A browser enrollment can
// legitimately outlive the 2-hour TTL — the connector reaches a 2FA or
// device-approval step, asks the owner for a code, and waits (up to 1800s per
// manual handoff, `packages/polyfill-connectors/src/session-establish.ts`).
// Without this guard the maintenance sweep revokes the shell while the owner is
// mid-sign-in, and his attempt dies for a reason that has nothing to do with
// the provider — the same self-inflicted shape `ref-control.ts` already names
// `controller_terminated_while_awaiting_owner_interaction`.
//
// This does NOT make shells immortal, because the claim itself is bounded. Every
// run that ends — success, failure, owner cancel, assistance timeout
// (`run.assistance_timed_out`), or boot reconciliation of an orphan
// (`releaseAbandonedControllerRunClaims`) — deletes the active-run row. Once the
// owner's interaction wait times out, the claim drops and the very next sweep
// retires the shell normally. The guard defers retirement for the life of a real
// run; it never cancels it.
export function expiredEnrollmentShellIds(
  shells: readonly EnrollmentShellLike[],
  now: string,
  runInFlightInstanceIds: ReadonlySet<string> = new Set()
): readonly string[] {
  const nowMs = new Date(now).getTime();
  return shells
    .filter((shell) => enrollmentShellExpired(shell, nowMs, runInFlightInstanceIds.has(shell.connectorInstanceId)))
    .map((shell) => shell.connectorInstanceId);
}

// Stamped into the revoked shell's `source_binding_json.revocation_reason` by
// the sweep below. This is the ONLY reason a `browser_enrollment_shell` row
// is ever revoked by this module — an owner-abandon revocation goes through
// the separate `/abandon-enrollment` route, which stamps `owner_abandoned`
// instead (see `mountRefBrowserEnrollmentShell` in
// `routes/ref-browser-enrollment-shell.ts`). Recording the true cause at the
// moment of revocation means `deriveSourceVisibility`/`archiveRenderedVerdict`
// (`ref-control.ts`) never have to GUESS why a setup shell died from
// `revoked_at` timing alone.
export const TTL_EXPIRED_REVOCATION_REASON = "ttl_expired";

export interface ShellRetirementStore {
  // List all unresolved browser-enrollment shell instances (any connector) for
  // the given owner, or all owners if ownerSubjectId is null. Implementations
  // may scope this to `source_binding_json->>'kind' =
  // 'browser_enrollment_shell'` for efficiency.
  listDraftBrowserEnrollmentShells: (ownerSubjectId: string | null) => Promise<EnrollmentShellLike[]>;
  // The connectorInstanceIds that currently hold a durable controller run
  // claim. Optional so existing callers/fakes keep compiling; when absent the
  // sweep treats no run as in flight (its historical behavior). Real callers
  // supply it — see `retireExpiredBrowserEnrollmentShellsForMaintenance`.
  listRunInFlightInstanceIds?: () => Promise<readonly string[]>;
  updateStatus: (
    connectorInstanceId: string,
    args: {
      status: string;
      updatedAt: string;
      revokedAt?: string | null;
      sourceBindingPatch?: Record<string, unknown> | null;
    }
  ) => Promise<unknown>;
}

// Retires all expired browser-enrollment shells system-wide (or scoped to one
// owner). Returns the list of retired connection IDs for caller logging.
export async function retireExpiredBrowserEnrollmentShells(
  store: ShellRetirementStore,
  { now, ownerSubjectId = null }: { now: string; ownerSubjectId?: string | null }
): Promise<readonly string[]> {
  const shells = await store.listDraftBrowserEnrollmentShells(ownerSubjectId);
  // Read the in-flight claims AFTER the shell list, never before. A run that
  // starts between the two reads is then necessarily visible here, so the
  // shell it claims is spared. The opposite order would leave exactly the
  // window this fix exists to close: claims read first, run starts, shell read
  // second, shell revoked under a live run. See `expiredEnrollmentShellIds`.
  const runInFlightInstanceIds = new Set(await store.listRunInFlightInstanceIds?.());
  const ids = expiredEnrollmentShellIds(shells, now, runInFlightInstanceIds);
  for (const id of ids) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    await store.updateStatus(id, {
      revokedAt: now,
      sourceBindingPatch: { revocation_reason: TTL_EXPIRED_REVOCATION_REASON },
      status: "revoked",
      updatedAt: now,
    });
  }
  return ids;
}
