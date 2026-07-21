// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared, backend-agnostic storage helpers used by BOTH the SQLite record store
// (records.js) and the Postgres record store (postgres-records.js). These were
// previously duplicated, and the copies had silently diverged (different
// accepted shapes and different empty-input behavior). Consolidating them here
// is the first increment of the storage-convergence work: a single source of
// truth so the two backends cannot drift on these primitives.
//
// Unification decisions (audited against current callers, 2026-06-18):
//   - resolveStorageConnectorId / resolveStorageConnectorInstanceId accept the
//     UNION of the shapes the two old copies accepted: a bare string, a
//     snake_case object ({connector_id, connector_instance_id}), AND a
//     camelCase object ({connectorId, connectorInstanceId}). connection-identity.js
//     produces camelCase records that flow into the Postgres path, so the
//     camelCase fallback is load-bearing and is preserved for both backends.
//   - resolveStorageConnectorId returns null on empty input rather than throwing.
//     The old Postgres copy threw; no caller wraps it in try/catch or branches on
//     the throw, so the non-throwing (SQLite) form is the safe superset.
//   - resolveStorageConnectorInstanceId keeps the stricter SQLite behavior:
//     require a connectorId before deriving the default instance id, throwing
//     invalid_connector_id when absent. This preserves the stronger guard.

import { canonicalConnectorKey } from "./connector-key.js";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import { makeDefaultAccountConnectorInstanceId } from "./stores/connector-instance-store.js";

/**
 * A storage target: a bare connector-id string, or an object carrying the
 * connector / connector-instance ids in either snake_case or camelCase.
 */
type StorageTarget =
  | string
  | {
      connector_id?: string;
      connectorId?: string;
      connector_instance_id?: string;
      connectorInstanceId?: string;
    }
  | null
  | undefined;

/**
 * Current time as an ISO-8601 string. Single definition shared by both stores.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

function normalizeConnectorId(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : null;
  if (!trimmed) {
    return null;
  }
  return canonicalConnectorKey(trimmed) ?? trimmed;
}

/**
 * Resolve the canonical connector id from a storage target. Accepts a bare
 * connector-id string, a snake_case object, or a camelCase object. Returns null
 * when no connector id is present.
 */
export function resolveStorageConnectorId(storageTarget: StorageTarget): string | null {
  if (typeof storageTarget === "string") {
    return normalizeConnectorId(storageTarget);
  }
  if (storageTarget && typeof storageTarget === "object") {
    if (typeof storageTarget.connector_id === "string" && storageTarget.connector_id.trim()) {
      return normalizeConnectorId(storageTarget.connector_id);
    }
    if (typeof storageTarget.connectorId === "string" && storageTarget.connectorId.trim()) {
      return normalizeConnectorId(storageTarget.connectorId);
    }
  }
  return null;
}

/**
 * Resolve the connector-instance id from a storage target, falling back to the
 * default-account instance id derived from the connector id. Accepts snake_case
 * or camelCase instance-id fields. Requires a connector id to derive the
 * default; throws invalid_connector_id when neither an explicit instance id nor
 * a connector id is available.
 */
export function resolveStorageConnectorInstanceId(storageTarget: StorageTarget, connectorId: string): string {
  if (storageTarget && typeof storageTarget === "object") {
    const snake = storageTarget.connector_instance_id;
    if (typeof snake === "string" && snake.trim()) {
      return snake.trim();
    }
    const camel = storageTarget.connectorInstanceId;
    if (typeof camel === "string" && camel.trim()) {
      return camel.trim();
    }
  }
  if (typeof connectorId !== "string" || !connectorId.trim()) {
    const err = new Error("connector_id is required for connector sync state.") as Error & {
      code?: string;
    };
    err.code = "invalid_connector_id";
    throw err;
  }
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

/**
 * The configured change-history retention limit (0 = unbounded). Single shared
 * definition; both stores read the same env var with the same parsing.
 */
export function getChangeHistoryLimit(): number {
  return Math.max(Number.parseInt(process.env.PDPP_CHANGE_HISTORY_LIMIT || "0", 10) || 0, 0);
}
