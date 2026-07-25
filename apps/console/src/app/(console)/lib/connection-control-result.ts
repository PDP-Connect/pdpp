// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { describeError } from "./describe-error.ts";

/**
 * Pure mappings for the owner-session connection control responses
 * (`POST /_ref/connections/:id/revoke`, `POST /_ref/connections/:id/reactivate`,
 * and `DELETE /_ref/connections/:id`), factored out of `operator-runs.ts` so
 * they can be unit tested directly under `node --test` without pulling in the
 * server-only fetch helpers (`owner-token.ts` imports `server-only`, which
 * throws outside the React Server runtime).
 *
 * These routes share the same connector-instance store primitives + typed
 * errors as the owner-agent bearer revoke/reactivate/delete routes. The
 * console surfaces each typed outcome honestly rather than flattening it into
 * a generic error:
 *
 *   Revoke:
 *     - `200` → `revoked`
 *     - `400 connector_instance_inactive` → `already_revoked` (repeat revoke;
 *       the connection is not active so there is nothing new to revoke)
 *
 *   Reactivate:
 *     - `200` → `reactivated`
 *     - `409 connector_instance_not_revoked` → `not_revoked` (connection is
 *       already active; nothing to reactivate)
 *     - `404 connector_instance_not_found` → `not_found`
 *
 *   Delete:
 *     - `200` → `deleted`
 *     - `409 connection_run_active` → `run_active` (a run is in flight; stop it
 *       first — delete refuses to erase a running collection)
 *     - `409 default_account_delete_unsupported` → `default_account` (a
 *       default-account binding would silently re-materialize; revoke instead)
 *     - `404 connector_instance_not_found` → `not_found` (unknown / already
 *       deleted / foreign — no existence leak)
 */
export type RevokeConnectionOutcome = "revoked" | "already_revoked";

export interface RevokeConnectionResult {
  status: RevokeConnectionOutcome;
}

export type ReactivateConnectionOutcome = "reactivated" | "not_revoked" | "not_found";

export interface ReactivateConnectionResult {
  status: ReactivateConnectionOutcome;
}

/**
 * Map a reactivate response `(status, body, errorCode)` to a typed outcome, or
 * throw a described error for any status that is not a documented outcome.
 */
export function classifyReactivateConnectionResponse(
  status: number,
  body: unknown,
  errorCode: string | null
): ReactivateConnectionResult {
  if (status === 200) {
    return { status: "reactivated" };
  }
  if (status === 409 && errorCode === "connector_instance_not_revoked") {
    return { status: "not_revoked" };
  }
  if (status === 404 && errorCode === "connector_instance_not_found") {
    return { status: "not_found" };
  }
  throw new Error(describeError(body, `connection reactivate failed (${status})`));
}

export type DeleteConnectionOutcome = "deleted" | "run_active" | "default_account" | "not_found";

export interface DeleteConnectionResult {
  /** Non-secret deletion summary, present only on a successful `deleted`. */
  deletedRecordCount?: number;
  status: DeleteConnectionOutcome;
}

/** Extract the reference error envelope's `error.code`, if present. */
export function connectionControlErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const { error } = body as { error?: unknown };
  if (!error || typeof error !== "object") {
    return null;
  }
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : null;
}

/**
 * Map a revoke response `(status, body, errorCode)` to a typed outcome, or throw
 * a described error for any status that is not a documented revoke outcome.
 */
export function classifyRevokeConnectionResponse(
  status: number,
  body: unknown,
  errorCode: string | null
): RevokeConnectionResult {
  if (status === 200) {
    return { status: "revoked" };
  }
  if (status === 400 && errorCode === "connector_instance_inactive") {
    return { status: "already_revoked" };
  }
  throw new Error(describeError(body, `connection revoke failed (${status})`));
}

/**
 * Map a delete response `(status, body, errorCode)` to a typed outcome, or throw
 * a described error for any status that is not a documented delete outcome.
 */
export function classifyDeleteConnectionResponse(
  status: number,
  body: unknown,
  errorCode: string | null
): DeleteConnectionResult {
  if (status === 200) {
    const count = (body as { deleted_record_count?: unknown } | null)?.deleted_record_count;
    return {
      status: "deleted",
      ...(typeof count === "number" ? { deletedRecordCount: count } : {}),
    };
  }
  if (status === 409 && errorCode === "connection_run_active") {
    return { status: "run_active" };
  }
  if (status === 409 && errorCode === "default_account_delete_unsupported") {
    return { status: "default_account" };
  }
  if (status === 404 && errorCode === "connector_instance_not_found") {
    return { status: "not_found" };
  }
  throw new Error(describeError(body, `connection delete failed (${status})`));
}
