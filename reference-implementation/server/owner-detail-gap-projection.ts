// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { classifyRecoveryGap } from "../runtime/recovery-decision.ts";
import { getDefaultConnectorDetailGapStore } from "./stores/connector-detail-gap-store.ts";

export const OWNER_DETAIL_GAP_PAGE_DEFAULT_LIMIT = 25;
export const OWNER_DETAIL_GAP_PAGE_MAX_LIMIT = 100;

type OwnerDetailGapDispositionState = "policy_skipped" | "recovered" | "retryable" | "terminal";
type OwnerDetailGapLeaseState = "leased" | "not_leased" | "unknown";

interface DetailGapCursorBoundary {
  createdAt: string;
  gapId: string;
}

interface DetailGapForProjection {
  attempt_count?: unknown;
  created_at?: unknown;
  gap_id?: unknown;
  last_attempt_at?: unknown;
  last_error?: unknown;
  lease_expires_at?: unknown;
  lease_id?: unknown;
  lease_run_id?: unknown;
  next_attempt_after?: unknown;
  reason?: unknown;
  record_key?: unknown;
  status?: unknown;
  stream?: unknown;
}

export interface OwnerDetailGapStoreLike {
  listGapsForConnectorInstance: (
    connectorId: string,
    connectorInstanceId: string,
    options: { after?: DetailGapCursorBoundary | null; limit?: number }
  ) => Promise<readonly DetailGapForProjection[]> | readonly DetailGapForProjection[];
}

export interface OwnerDetailGapWire {
  attempt_count: number;
  disposition: {
    policy_class: string | null;
    state: OwnerDetailGapDispositionState;
  };
  gap_id: string;
  last_attempt_at: string | null;
  last_error: { class: string | null };
  lease: { expires_at: string | null; state: OwnerDetailGapLeaseState };
  next_attempt_after: string | null;
  reason: string | null;
  record_key: string | null;
  status: string;
  stream: string;
}

export interface OwnerDetailGapPage {
  connection_id: string;
  data: readonly OwnerDetailGapWire[];
  has_more: boolean;
  limit: number;
  next_cursor: string | null;
  object: "owner_connection_detail_gaps";
}

interface InvalidDetailGapRequest extends Error {
  code: "invalid_cursor" | "invalid_request";
  param?: string;
}

// `too_large` is already a neutral connector error class used by the existing
// detail-gap rows. It is a policy disposition, not a Gmail route or a payload
// field. Informational recovery reasons are handled through the shared
// recovery classifier below.
const POLICY_DISPOSITION_CLASSES = new Set(["too_large"]);

function invalidRequest(
  code: InvalidDetailGapRequest["code"],
  message: string,
  param?: string
): InvalidDetailGapRequest {
  const error = new Error(message) as InvalidDetailGapRequest;
  error.code = code;
  if (param) {
    error.param = param;
  }
  return error;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function encodeCursor(connectionId: string, row: DetailGapForProjection): string {
  const createdAt = nonEmptyString(row.created_at);
  const gapId = nonEmptyString(row.gap_id);
  if (!(createdAt && gapId)) {
    throw new Error("detail-gap row is missing its ordering identity");
  }
  return Buffer.from(
    JSON.stringify({
      connection_id: connectionId,
      created_at: createdAt,
      gap_id: gapId,
      v: 1,
    }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined, connectionId: string): DetailGapCursorBoundary | null {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  if (typeof cursor !== "string" || !cursor.trim()) {
    throw invalidRequest("invalid_cursor", "cursor must be a non-empty opaque cursor", "cursor");
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("cursor is not an object");
    }
    const row = decoded as Record<string, unknown>;
    const decodedConnectionId = nonEmptyString(row.connection_id);
    const createdAt = nonEmptyString(row.created_at);
    const gapId = nonEmptyString(row.gap_id);
    if (row.v !== 1 || decodedConnectionId !== connectionId || !(createdAt && gapId)) {
      throw new Error("cursor does not match this connection");
    }
    return { createdAt, gapId };
  } catch (cause) {
    const error = invalidRequest("invalid_cursor", "cursor is invalid or belongs to another connection", "cursor");
    error.cause = cause;
    throw error;
  }
}

export function normalizeOwnerDetailGapLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return OWNER_DETAIL_GAP_PAGE_DEFAULT_LIMIT;
  }
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > OWNER_DETAIL_GAP_PAGE_MAX_LIMIT) {
    throw invalidRequest(
      "invalid_request",
      `limit must be an integer between 1 and ${OWNER_DETAIL_GAP_PAGE_MAX_LIMIT}`,
      "limit"
    );
  }
  return limit;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readErrorClass(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return nonEmptyString((value as Record<string, unknown>).class);
}

function readAttemptCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function policyClassFor(row: DetailGapForProjection, errorClass: string | null): string | null {
  const classification = classifyRecoveryGap({
    last_error: errorClass ? { class: errorClass } : null,
    reason: stringOrNull(row.reason),
  });
  if (POLICY_DISPOSITION_CLASSES.has(errorClass ?? "")) {
    return errorClass;
  }
  if (classification.recoveryClass === "informational") {
    return classification.connectorClass ?? stringOrNull(row.reason);
  }
  return null;
}

function dispositionFor(status: string, policyClass: string | null): OwnerDetailGapWire["disposition"] {
  if (status === "terminal") {
    return { policy_class: policyClass, state: "terminal" };
  }
  if (status === "recovered") {
    return { policy_class: policyClass, state: "recovered" };
  }
  if (policyClass) {
    return { policy_class: policyClass, state: "policy_skipped" };
  }
  return { policy_class: null, state: "retryable" };
}

function leaseFor(row: DetailGapForProjection): OwnerDetailGapWire["lease"] {
  const expiresAt = stringOrNull(row.lease_expires_at);
  const hasLeaseIdentity = Boolean(nonEmptyString(row.lease_id) || nonEmptyString(row.lease_run_id));
  const status = stringOrNull(row.status);
  let state: OwnerDetailGapLeaseState = "not_leased";
  if (hasLeaseIdentity) {
    state = "leased";
  } else if (status === "in_progress") {
    state = "unknown";
  }
  return { expires_at: expiresAt, state };
}

function projectGap(row: DetailGapForProjection): OwnerDetailGapWire {
  const gapId = nonEmptyString(row.gap_id);
  const stream = nonEmptyString(row.stream);
  if (!(gapId && stream)) {
    throw new Error("detail-gap row is missing its public identity");
  }
  const status = nonEmptyString(row.status) ?? "unknown";
  const errorClass = readErrorClass(row.last_error);
  const policyClass = policyClassFor(row, errorClass);
  return {
    attempt_count: readAttemptCount(row.attempt_count),
    disposition: dispositionFor(status, policyClass),
    gap_id: gapId,
    last_attempt_at: stringOrNull(row.last_attempt_at),
    last_error: { class: errorClass },
    lease: leaseFor(row),
    next_attempt_after: stringOrNull(row.next_attempt_after),
    reason: stringOrNull(row.reason),
    record_key: stringOrNull(row.record_key),
    status,
    stream,
  };
}

export async function getOwnerConnectionDetailGapPage(input: {
  connectorId: string;
  connectorInstanceId: string;
  connectionId: string;
  cursor?: string | null;
  limit?: unknown;
  store?: OwnerDetailGapStoreLike;
}): Promise<OwnerDetailGapPage> {
  const limit = normalizeOwnerDetailGapLimit(input.limit);
  const after = decodeCursor(input.cursor, input.connectionId);
  const store = input.store ?? (getDefaultConnectorDetailGapStore() as OwnerDetailGapStoreLike);
  const rows = await store.listGapsForConnectorInstance(input.connectorId, input.connectorInstanceId, {
    after,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const lastPageRow = pageRows.at(-1);
  if (hasMore && !lastPageRow) {
    throw new Error("detail-gap page cannot produce a cursor without a row");
  }
  const nextCursor = hasMore && lastPageRow ? encodeCursor(input.connectionId, lastPageRow) : null;
  return {
    connection_id: input.connectionId,
    data: pageRows.map(projectGap),
    has_more: hasMore,
    limit,
    next_cursor: nextCursor,
    object: "owner_connection_detail_gaps",
  };
}
