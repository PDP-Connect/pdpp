// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { exec, execOn, getMany, getOne, getOneOn, referenceQueries, writeTransaction } from "../../lib/db.ts";
import { postgresEmitSpineEventWithClient } from "../../lib/postgres-spine.ts";
import { emitSqliteSpineEventSynchronously, type SpineEventInput } from "../../lib/spine.ts";
import { getDb } from "../db.ts";
import { HOSTED_INGEST_MAX_LINE_BYTES } from "../hosted-ingest-limits.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import { RECORD_REJECTION_GENERATION, recordRejectionReplayKey } from "../record-rejection-replay-key.ts";
import { applyRetainedSizeRecordRejectionDelta, markRetainedSizeConnectionDirty } from "../retained-size-read-model.ts";

export const DEFAULT_RECORD_REJECTION_OWNER_QUOTA_BYTES = 10 * 1024 * 1024;
export const DEFAULT_RECORD_REJECTION_OWNER_QUOTA_COUNT = 1000;
export const DEFAULT_RECORD_REJECTION_CONNECTION_QUOTA_COUNT = 250;
export const RECORD_REJECTION_OWNER_QUOTA_ENV = "PDPP_RECORD_REJECTION_OWNER_QUOTA_BYTES";
export const RECORD_REJECTION_OWNER_QUOTA_COUNT_ENV = "PDPP_RECORD_REJECTION_OWNER_QUOTA_COUNT";
export const RECORD_REJECTION_CONNECTION_QUOTA_COUNT_ENV = "PDPP_RECORD_REJECTION_CONNECTION_QUOTA_COUNT";
export const RECORD_REJECTION_REPLAY_COUNT_MAX = 1_000_000;
const MAX_PAGE_SIZE = 100;

export class RecordRejectionStoreError extends Error {
  code: string;
  retryable: boolean;

  constructor(code: string, message: string, { retryable = true }: { retryable?: boolean } = {}) {
    super(message);
    this.name = "RecordRejectionStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface InsertOrReplayRecordRejectionInput {
  readonly auditActorId?: string;
  readonly auditActorType?: string;
  readonly auditTraceId?: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly inputIndex: number;
  readonly maxConnectionReceipts?: number;
  readonly maxOwnerReceipts?: number;
  readonly maxPayloadBytes?: number;
  readonly ownerSubjectId: string;
  readonly quotaBytes?: number;
  readonly rawLine: Buffer | string;
  readonly reasonCode: string;
  readonly runId?: string | null;
  readonly stream: string;
}

export interface MarkAcceptedRecordRejectionsStaleInput {
  readonly auditActorId?: string;
  readonly auditActorType?: string;
  readonly auditTraceId?: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly rawLine: Buffer | string;
  readonly recordKey?: string | null;
  readonly runId?: string | null;
  readonly stream: string;
}

export interface RecordRejectionReceipt {
  readonly code: string;
  readonly inputIndex: number;
  readonly receiptId: string;
  readonly replayed: boolean;
}

export interface HostedRecordRejectionCoordinatorHooks {
  readonly afterInsertOrReplayBeforeCommit?: (receipt: RecordRejectionReceipt) => Promise<void> | void;
}

export interface RecordRejectionMetadata {
  readonly acceptedAt: string | null;
  readonly acceptedRecordKey: string | null;
  readonly acceptedRunId: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt: string;
  readonly firstInputIndex: number;
  readonly firstRunId: string | null;
  readonly lastSeenAt: string;
  readonly latestInputIndex: number;
  readonly latestRunId: string | null;
  readonly ownerSubjectId: string;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
  readonly quotaNearLimit: boolean;
  readonly reasonCode: string;
  readonly receiptId: string;
  readonly replayCount: number;
  readonly runId: string | null;
  readonly status: "pending" | "stale_after_acceptance";
  readonly stream: string;
}

export interface RecordRejectionDetail extends RecordRejectionMetadata {
  readonly payloadBase64: string;
  readonly payloadEncoding: "base64";
  readonly payloadText: string | null;
}

export interface RecordRejectionPage {
  readonly items: readonly RecordRejectionMetadata[];
  readonly nextCursor: string | null;
}

interface RecordRejectionRow extends QueryResultRow {
  accepted_at?: string | null;
  accepted_record_key?: string | null;
  accepted_run_id?: string | null;
  connection_receipt_count?: number | string;
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  first_input_index: number | string;
  first_run_id?: string | null;
  last_seen_at: string;
  latest_input_index: number | string;
  latest_run_id?: string | null;
  owner_subject_id: string;
  payload?: Buffer;
  payload_bytes: number | string;
  payload_sha256: string;
  payload_text?: string;
  pending_payload_bytes?: number | string;
  pending_receipt_count?: number | string;
  quota_near_limit?: number | boolean;
  reason_code: string;
  receipt_id: string;
  replay_count: number | string;
  run_id: string | null;
  status: string;
}

interface RecordRejectionAuditFacts {
  readonly connectionId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
  readonly reasonCode: string;
  readonly receiptId: string;
  readonly replayed: boolean;
  readonly stream: string;
}

function scheduleRetainedSizeProjectionUpdate(update: Promise<unknown>): void {
  update.catch(() => undefined);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8IfLossless(value: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function replayKey(input: InsertOrReplayRecordRejectionInput): string {
  return recordRejectionReplayKey({
    connectorInstanceId: input.connectorInstanceId,
    ownerSubjectId: input.ownerSubjectId,
    payload: rawLineBytes(input),
    reasonCode: input.reasonCode,
    stream: input.stream,
  });
}

function newReceiptId(): string {
  return `rr_${randomBytes(18).toString("base64url")}`;
}

function recordRejectionAuditEvent(
  input: InsertOrReplayRecordRejectionInput,
  facts: RecordRejectionAuditFacts
): SpineEventInput {
  return {
    actor_id: input.auditActorId ?? "pdpp_reference",
    actor_type: input.auditActorType ?? "system",
    data: {
      connection_id: facts.connectionId,
      created_at: facts.createdAt,
      last_seen_at: facts.lastSeenAt,
      payload_bytes: facts.payloadBytes,
      payload_sha256: facts.payloadSha256,
      reason_code: facts.reasonCode,
      receipt_id: facts.receiptId,
      stream: facts.stream,
    },
    event_type: facts.replayed ? "record_rejection.replay_coalesced" : "record_rejection.quarantined",
    object_id: facts.receiptId,
    object_type: "record_rejection",
    occurred_at: facts.lastSeenAt,
    status: "succeeded",
    stream_id: facts.stream,
    trace_id: input.auditTraceId ?? null,
  };
}

function emitSqliteRecordRejectionAudit(
  db: SqliteRecordRejectionTransactionHandle,
  input: InsertOrReplayRecordRejectionInput,
  facts: RecordRejectionAuditFacts
): void {
  emitSqliteSpineEventSynchronously(recordRejectionAuditEvent(input, facts), db);
}

function emitPostgresRecordRejectionAudit(
  client: PoolClient,
  input: InsertOrReplayRecordRejectionInput,
  facts: RecordRejectionAuditFacts
): Promise<unknown> {
  return postgresEmitSpineEventWithClient(client, recordRejectionAuditEvent(input, facts));
}

export function recordRejectionOwnerQuotaBytes(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[RECORD_REJECTION_OWNER_QUOTA_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RECORD_REJECTION_OWNER_QUOTA_BYTES;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecordRejectionStoreError(
      "invalid_quota",
      `${RECORD_REJECTION_OWNER_QUOTA_ENV} must be a non-negative safe integer byte count.`,
      { retryable: false }
    );
  }
  return value;
}

function integerLimitFromEnv(
  envName: string,
  defaultValue: number,
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecordRejectionStoreError("invalid_quota", `${envName} must be a non-negative safe integer.`, {
      retryable: false,
    });
  }
  return value;
}

function normalizeCountLimit(value: number | undefined, envName: string, defaultValue: number): number {
  const limit = value ?? integerLimitFromEnv(envName, defaultValue);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RecordRejectionStoreError("invalid_quota", "Record rejection count quota must be non-negative.", {
      retryable: false,
    });
  }
  return limit;
}

function normalizeQuota(value: number | undefined): number {
  if (value === undefined) {
    return recordRejectionOwnerQuotaBytes();
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecordRejectionStoreError(
      "invalid_quota",
      "Record rejection quota must be a non-negative safe integer.",
      {
        retryable: false,
      }
    );
  }
  return value;
}

function normalizePayloadLimit(value: number | undefined): number {
  if (value === undefined) {
    return HOSTED_INGEST_MAX_LINE_BYTES;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RecordRejectionStoreError(
      "invalid_payload_limit",
      "Record rejection payload limit must be a positive safe integer.",
      { retryable: false }
    );
  }
  return Math.min(value, HOSTED_INGEST_MAX_LINE_BYTES);
}

function boundedPayloadBytes(input: InsertOrReplayRecordRejectionInput): number {
  const bytes = rawLineBytes(input).byteLength;
  if (bytes > normalizePayloadLimit(input.maxPayloadBytes)) {
    throw new RecordRejectionStoreError(
      "record_rejection_payload_too_large",
      "Record rejection payload exceeds the hosted ingest line limit."
    );
  }
  return bytes;
}

function assertInput(input: InsertOrReplayRecordRejectionInput): void {
  if (!Number.isInteger(input.inputIndex) || input.inputIndex < 0) {
    throw new RecordRejectionStoreError("invalid_input_index", "Record rejection inputIndex must be non-negative.", {
      retryable: false,
    });
  }
  assertRequiredInputStrings(input);
  if (!hasNonEmptyRawLine(input.rawLine)) {
    throw new RecordRejectionStoreError("invalid_rejection_input", "rawLine is required.", { retryable: false });
  }
}

function assertRequiredInputStrings(input: InsertOrReplayRecordRejectionInput): void {
  for (const [name, value] of [
    ["ownerSubjectId", input.ownerSubjectId],
    ["connectorInstanceId", input.connectorInstanceId],
    ["connectorId", input.connectorId],
    ["stream", input.stream],
    ["reasonCode", input.reasonCode],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new RecordRejectionStoreError("invalid_rejection_input", `${name} is required.`, { retryable: false });
    }
  }
}

function hasNonEmptyRawLine(rawLine: Buffer | string): boolean {
  return (Buffer.isBuffer(rawLine) || typeof rawLine === "string") && rawLine.length > 0;
}

function rawLineBytes(input: InsertOrReplayRecordRejectionInput): Buffer {
  return Buffer.isBuffer(input.rawLine) ? input.rawLine : Buffer.from(input.rawLine, "utf8");
}

interface RecordRejectionQuotaPolicy {
  readonly connectionReceiptCount: number;
  readonly ownerPayloadBytes: number;
  readonly ownerReceiptCount: number;
}

function defaultQuotaPolicy(): RecordRejectionQuotaPolicy {
  return {
    connectionReceiptCount: integerLimitFromEnv(
      RECORD_REJECTION_CONNECTION_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_CONNECTION_QUOTA_COUNT
    ),
    ownerPayloadBytes: recordRejectionOwnerQuotaBytes(),
    ownerReceiptCount: integerLimitFromEnv(
      RECORD_REJECTION_OWNER_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_OWNER_QUOTA_COUNT
    ),
  };
}

function mapMetadata(
  row: RecordRejectionRow,
  policy: RecordRejectionQuotaPolicy = defaultQuotaPolicy()
): RecordRejectionMetadata {
  return {
    acceptedAt: row.accepted_at ?? null,
    acceptedRecordKey: row.accepted_record_key ?? null,
    acceptedRunId: row.accepted_run_id ?? null,
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    createdAt: row.created_at,
    firstInputIndex: Number(row.first_input_index),
    firstRunId: row.first_run_id ?? row.run_id,
    lastSeenAt: row.last_seen_at,
    latestInputIndex: Number(row.latest_input_index),
    latestRunId: row.latest_run_id ?? row.run_id,
    ownerSubjectId: row.owner_subject_id,
    payloadBytes: Number(row.payload_bytes),
    payloadSha256: row.payload_sha256,
    quotaNearLimit: quotaNearLimit(row, policy),
    reasonCode: row.reason_code,
    receiptId: row.receipt_id,
    replayCount: Number(row.replay_count),
    runId: row.run_id,
    status: row.status === "stale_after_acceptance" ? "stale_after_acceptance" : "pending",
    stream: row.stream,
  };
}

function quotaNearLimit(row: RecordRejectionRow, policy: RecordRejectionQuotaPolicy): boolean {
  return (
    Boolean(row.quota_near_limit) ||
    quotaRatioNearLimit(Number(row.pending_payload_bytes ?? 0), policy.ownerPayloadBytes) ||
    quotaRatioNearLimit(Number(row.pending_receipt_count ?? 0), policy.ownerReceiptCount) ||
    quotaRatioNearLimit(Number(row.connection_receipt_count ?? 0), policy.connectionReceiptCount)
  );
}

function quotaRatioNearLimit(value: number, limit: number): boolean {
  return limit > 0 && value / limit >= 0.8;
}

function mapDetail(
  row: RecordRejectionRow,
  policy: RecordRejectionQuotaPolicy = defaultQuotaPolicy()
): RecordRejectionDetail {
  const payload = Buffer.isBuffer(row.payload) ? row.payload : Buffer.from(row.payload_text ?? "", "utf8");
  return {
    ...mapMetadata(row, policy),
    payloadBase64: payload.toString("base64"),
    payloadEncoding: "base64",
    payloadText: decodeUtf8IfLossless(payload),
  };
}

function encodeCursor(row: RecordRejectionMetadata): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, receiptId: row.receiptId }), "utf8").toString(
    "base64url"
  );
}

function decodeCursor(cursor: string | null | undefined): { createdAt: string; receiptId: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.createdAt === "string" && typeof parsed.receiptId === "string") {
      return { createdAt: parsed.createdAt, receiptId: parsed.receiptId };
    }
  } catch {
    // handled below
  }
  throw new RecordRejectionStoreError("invalid_cursor", "Record rejection cursor is invalid.", { retryable: false });
}

function pageSize(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RecordRejectionStoreError("invalid_page_size", "Record rejection page size must be positive.", {
      retryable: false,
    });
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

function lastPageItem(items: readonly RecordRejectionMetadata[]): RecordRejectionMetadata {
  const item = items.at(-1);
  if (!item) {
    throw new Error("Truncated record-rejection page did not contain an item.");
  }
  return item;
}

interface SqliteRecordRejectionTransactionHandle {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
  };
}

function assertSqliteWritable(
  db: SqliteRecordRejectionTransactionHandle,
  ownerSubjectId: string,
  connectorInstanceId: string,
  connectorId: string,
  runId?: string | null
) {
  const connection = getOneOn<{ status: string }>(db, referenceQueries.recordRejectionsGetConnectionStatus, [
    ownerSubjectId,
    connectorInstanceId,
    connectorId,
  ]);
  if (!connection || connection.status === "revoked") {
    throw new RecordRejectionStoreError("connection_not_writable", "Connection is not writable.");
  }
  if (runId) {
    const run = getOneOn<{ status: string }>(db, referenceQueries.controllerGetRunHistoryStatusForRun, [
      runId,
      connectorInstanceId,
    ]);
    if (run?.status !== "running") {
      throw new RecordRejectionStoreError("run_not_writable", "Run is not writable.");
    }
  }
}

interface PreparedRecordRejectionInsert {
  readonly bytes: number;
  readonly connectionReceiptQuota: number;
  readonly digest: string;
  readonly key: string;
  readonly ownerReceiptQuota: number;
  readonly quota: number;
  readonly rawLine: Buffer;
}

function prepareRecordRejectionInsert(input: InsertOrReplayRecordRejectionInput): PreparedRecordRejectionInsert {
  const bytes = boundedPayloadBytes(input);
  const rawLine = rawLineBytes(input);
  return {
    bytes,
    connectionReceiptQuota: normalizeCountLimit(
      input.maxConnectionReceipts,
      RECORD_REJECTION_CONNECTION_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_CONNECTION_QUOTA_COUNT
    ),
    digest: sha256Hex(rawLine),
    key: replayKey(input),
    ownerReceiptQuota: normalizeCountLimit(
      input.maxOwnerReceipts,
      RECORD_REJECTION_OWNER_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_OWNER_QUOTA_COUNT
    ),
    quota: normalizeQuota(input.quotaBytes),
    rawLine,
  };
}

function replaySqliteRecordRejection(
  db: SqliteRecordRejectionTransactionHandle,
  receiptId: string,
  reasonCode: string,
  inputIndex: number,
  runId?: string | null
): RecordRejectionReceipt {
  const lastSeenAt = nowIso();
  execOn(db, referenceQueries.recordRejectionsUpdateReplay, [
    RECORD_REJECTION_REPLAY_COUNT_MAX,
    inputIndex,
    runId ?? null,
    lastSeenAt,
    receiptId,
  ]);
  return {
    code: reasonCode,
    inputIndex,
    receiptId,
    replayed: true,
  };
}

function admitSqliteRecordRejectionQuota(
  db: SqliteRecordRejectionTransactionHandle,
  input: InsertOrReplayRecordRejectionInput,
  prepared: PreparedRecordRejectionInsert
): void {
  execOn(db, referenceQueries.recordRejectionsEnsureQuotaOwner, [input.ownerSubjectId, nowIso()]);
  const connectionCount =
    getOneOn<{ count: number }>(db, referenceQueries.recordRejectionsCountForConnection, [
      input.ownerSubjectId,
      input.connectorInstanceId,
    ])?.count ?? 0;
  if (connectionCount + 1 > prepared.connectionReceiptQuota) {
    throw new RecordRejectionStoreError(
      "record_rejection_connection_quota_exceeded",
      "Record rejection connection quota is exhausted."
    );
  }
  const admitted = execOn(db, referenceQueries.recordRejectionsAdmitQuota, [
    prepared.bytes,
    nowIso(),
    input.ownerSubjectId,
    prepared.bytes,
    prepared.quota,
    prepared.ownerReceiptQuota,
  ]);
  if (admitted.changes !== 1) {
    throw new RecordRejectionStoreError(
      "record_rejection_quota_exceeded",
      "Record rejection owner quota is exhausted."
    );
  }
}

export function insertOrReplaySqliteRecordRejectionInTransaction(
  db: SqliteRecordRejectionTransactionHandle,
  input: InsertOrReplayRecordRejectionInput
): RecordRejectionReceipt {
  assertInput(input);
  const prepared = prepareRecordRejectionInsert(input);
  assertSqliteWritable(db, input.ownerSubjectId, input.connectorInstanceId, input.connectorId, input.runId);
  const existing = getOneOn<{
    created_at: string;
    payload_bytes: number;
    payload_sha256: string;
    reason_code: string;
    receipt_id: string;
  }>(db, referenceQueries.recordRejectionsGetByReplayKey, [prepared.key]);
  if (existing) {
    return replaySqliteRecordRejection(db, existing.receipt_id, existing.reason_code, input.inputIndex, input.runId);
  }
  admitSqliteRecordRejectionQuota(db, input, prepared);
  const receiptId = newReceiptId();
  const createdAt = nowIso();
  execOn(db, referenceQueries.recordRejectionsInsert, [
    receiptId,
    input.ownerSubjectId,
    input.connectorInstanceId,
    input.connectorId,
    input.stream,
    input.runId ?? null,
    input.inputIndex,
    input.inputIndex,
    input.runId ?? null,
    input.runId ?? null,
    input.reasonCode,
    prepared.rawLine,
    prepared.digest,
    prepared.bytes,
    RECORD_REJECTION_GENERATION,
    prepared.key,
    createdAt,
    createdAt,
  ]);
  emitSqliteRecordRejectionAudit(db, input, {
    connectionId: input.connectorInstanceId,
    createdAt,
    lastSeenAt: createdAt,
    payloadBytes: prepared.bytes,
    payloadSha256: prepared.digest,
    reasonCode: input.reasonCode,
    receiptId,
    replayed: false,
    stream: input.stream,
  });
  return { code: input.reasonCode, inputIndex: input.inputIndex, receiptId, replayed: false };
}

export function insertOrReplaySqliteRecordRejection(input: InsertOrReplayRecordRejectionInput): RecordRejectionReceipt {
  const receipt = writeTransaction(() => insertOrReplaySqliteRecordRejectionInTransaction(getDb(), input));
  if (!receipt.replayed) {
    scheduleRetainedSizeProjectionUpdate(
      applyRetainedSizeRecordRejectionDelta({
        connectorId: input.connectorId,
        connectorInstanceId: input.connectorInstanceId,
        recordRejectionCountDelta: 1,
        recordRejectionPayloadBytesDelta: boundedPayloadBytes(input),
        stream: input.stream,
      })
    );
  }
  return receipt;
}

export function insertOrReplayHostedSqliteRecordRejection(
  input: InsertOrReplayRecordRejectionInput,
  hooks: HostedRecordRejectionCoordinatorHooks = {}
): RecordRejectionReceipt {
  const receipt = writeTransaction(() => {
    const inserted = insertOrReplaySqliteRecordRejectionInTransaction(getDb(), input);
    const hookResult = hooks.afterInsertOrReplayBeforeCommit?.(inserted);
    if (hookResult && typeof (hookResult as Promise<void>).then === "function") {
      throw new RecordRejectionStoreError(
        "invalid_hosted_rejection_hook",
        "SQLite hosted record rejection hooks must be synchronous.",
        { retryable: false }
      );
    }
    return inserted;
  });
  if (!receipt.replayed) {
    scheduleRetainedSizeProjectionUpdate(
      applyRetainedSizeRecordRejectionDelta({
        connectorId: input.connectorId,
        connectorInstanceId: input.connectorInstanceId,
        recordRejectionCountDelta: 1,
        recordRejectionPayloadBytesDelta: boundedPayloadBytes(input),
        stream: input.stream,
      })
    );
  }
  return receipt;
}

export function getSqliteRecordRejectionDetail(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
  receiptId: string;
}): RecordRejectionDetail | null {
  const row = getOne<RecordRejectionRow>(referenceQueries.recordRejectionsGetDetail, [
    args.ownerSubjectId,
    args.connectorInstanceId,
    args.receiptId,
  ]);
  return row ? mapDetail(row) : null;
}

export function listSqliteRecordRejections(args: {
  connectorInstanceId: string;
  cursor?: string | null;
  limit: number;
  maxConnectionReceipts?: number;
  maxOwnerReceipts?: number;
  ownerSubjectId: string;
  quotaBytes?: number;
}): RecordRejectionPage {
  const limit = pageSize(args.limit);
  const cursor = decodeCursor(args.cursor);
  const query = cursor
    ? referenceQueries.recordRejectionsListAfterCursor
    : referenceQueries.recordRejectionsListFirstPage;
  const params = cursor
    ? [args.ownerSubjectId, args.connectorInstanceId, cursor.createdAt, cursor.receiptId]
    : [args.ownerSubjectId, args.connectorInstanceId];
  const page = getMany<RecordRejectionRow>(query, params, { limit });
  const policy = {
    connectionReceiptCount: normalizeCountLimit(
      args.maxConnectionReceipts,
      RECORD_REJECTION_CONNECTION_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_CONNECTION_QUOTA_COUNT
    ),
    ownerPayloadBytes: normalizeQuota(args.quotaBytes),
    ownerReceiptCount: normalizeCountLimit(
      args.maxOwnerReceipts,
      RECORD_REJECTION_OWNER_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_OWNER_QUOTA_COUNT
    ),
  };
  const items = page.rows.map((row) => mapMetadata(row, policy));
  return { items, nextCursor: page.truncated ? encodeCursor(lastPageItem(items)) : null };
}

export function deleteSqliteRecordRejectionsForConnectionWithinTransaction(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
}): number {
  const total =
    getOne<{ bytes: number }>(referenceQueries.recordRejectionsSumPayloadBytesForConnection, [
      args.ownerSubjectId,
      args.connectorInstanceId,
    ])?.bytes ?? 0;
  const deleted = exec(referenceQueries.recordRejectionsDeleteForConnection, [
    args.ownerSubjectId,
    args.connectorInstanceId,
  ]);
  if (deleted.changes > 0) {
    exec(referenceQueries.recordRejectionsReleaseQuota, [total, deleted.changes, nowIso(), args.ownerSubjectId]);
  }
  return deleted.changes;
}

export function deleteSqliteRecordRejectionsForConnection(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
}): number {
  const deleted = writeTransaction(() => deleteSqliteRecordRejectionsForConnectionWithinTransaction(args));
  if (deleted > 0) {
    scheduleRetainedSizeProjectionUpdate(
      markRetainedSizeConnectionDirty({
        connectorInstanceId: args.connectorInstanceId,
      })
    );
  }
  return deleted;
}

export function markSqliteAcceptedRecordRejectionsStaleInTransaction(
  db: SqliteRecordRejectionTransactionHandle,
  input: MarkAcceptedRecordRejectionsStaleInput
): number {
  assertRequiredInputStrings({ ...input, inputIndex: 0, rawLine: input.rawLine, reasonCode: "accepted_record" });
  if (!hasNonEmptyRawLine(input.rawLine)) {
    throw new RecordRejectionStoreError("invalid_rejection_input", "rawLine is required.", { retryable: false });
  }
  const acceptedAt = nowIso();
  return execOn(db, referenceQueries.recordRejectionsMarkAcceptedStale, [
    input.runId ?? null,
    input.recordKey ?? null,
    acceptedAt,
    acceptedAt,
    input.ownerSubjectId,
    input.connectorInstanceId,
    input.connectorId,
    input.stream,
    sha256Hex(Buffer.isBuffer(input.rawLine) ? input.rawLine : Buffer.from(input.rawLine, "utf8")),
  ]).changes;
}

export function markSqliteAcceptedRecordRejectionsStale(input: MarkAcceptedRecordRejectionsStaleInput): number {
  return writeTransaction(() => markSqliteAcceptedRecordRejectionsStaleInTransaction(getDb(), input));
}

async function assertPostgresWritable(
  client: PoolClient,
  ownerSubjectId: string,
  connectorInstanceId: string,
  connectorId: string,
  runId?: string | null
) {
  const connection = await client.query<{ status: string }>(
    `SELECT status FROM connector_instances
      WHERE owner_subject_id = $1 AND connector_instance_id = $2 AND connector_id = $3
      FOR UPDATE`,
    [ownerSubjectId, connectorInstanceId, connectorId]
  );
  if (connection.rowCount !== 1 || connection.rows[0]?.status === "revoked") {
    throw new RecordRejectionStoreError("connection_not_writable", "Connection is not writable.");
  }
  if (runId) {
    const run = await client.query<{ status: string }>(
      `SELECT status FROM run_history
        WHERE run_id = $1 AND connector_instance_id = $2
        FOR UPDATE`,
      [runId, connectorInstanceId]
    );
    if (run.rows[0]?.status !== "running") {
      throw new RecordRejectionStoreError("run_not_writable", "Run is not writable.");
    }
  }
}

async function replayPostgresRecordRejection(
  client: PoolClient,
  receiptId: string,
  reasonCode: string,
  inputIndex: number,
  runId?: string | null
): Promise<RecordRejectionReceipt> {
  const lastSeenAt = nowIso();
  await client.query(
    `UPDATE record_rejections
      SET replay_count = LEAST(replay_count + 1, $1),
          latest_input_index = $2,
          latest_run_id = $3,
          last_seen_at = $4
    WHERE receipt_id = $5`,
    [RECORD_REJECTION_REPLAY_COUNT_MAX, inputIndex, runId ?? null, lastSeenAt, receiptId]
  );
  return { code: reasonCode, inputIndex, receiptId, replayed: true };
}

async function admitPostgresRecordRejectionQuota(
  client: PoolClient,
  input: InsertOrReplayRecordRejectionInput,
  prepared: PreparedRecordRejectionInsert
): Promise<void> {
  await client.query(
    `INSERT INTO record_rejection_quota(owner_subject_id, pending_payload_bytes, pending_receipt_count, updated_at)
     VALUES($1, 0, 0, $2)
     ON CONFLICT(owner_subject_id) DO NOTHING`,
    [input.ownerSubjectId, nowIso()]
  );
  const connectionCount = await client.query<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count
       FROM record_rejections
      WHERE owner_subject_id = $1 AND connector_instance_id = $2`,
    [input.ownerSubjectId, input.connectorInstanceId]
  );
  if (Number(connectionCount.rows[0]?.count ?? 0) + 1 > prepared.connectionReceiptQuota) {
    throw new RecordRejectionStoreError(
      "record_rejection_connection_quota_exceeded",
      "Record rejection connection quota is exhausted."
    );
  }
  const admitted = await client.query(
    `UPDATE record_rejection_quota
      SET pending_payload_bytes = pending_payload_bytes + $1,
          pending_receipt_count = pending_receipt_count + 1,
          updated_at = $2
    WHERE owner_subject_id = $3
      AND pending_payload_bytes + $1 <= $4
      AND pending_receipt_count + 1 <= $5`,
    [prepared.bytes, nowIso(), input.ownerSubjectId, prepared.quota, prepared.ownerReceiptQuota]
  );
  if (admitted.rowCount !== 1) {
    throw new RecordRejectionStoreError("record_rejection_quota_exceeded", "Record rejection quota is exhausted.");
  }
}

export async function insertOrReplayPostgresRecordRejectionWithClient(
  client: PoolClient,
  input: InsertOrReplayRecordRejectionInput
): Promise<RecordRejectionReceipt> {
  assertInput(input);
  const prepared = prepareRecordRejectionInsert(input);
  await assertPostgresWritable(client, input.ownerSubjectId, input.connectorInstanceId, input.connectorId, input.runId);
  const existing = await client.query<{
    created_at: string;
    payload_bytes: number | string;
    payload_sha256: string;
    reason_code: string;
    receipt_id: string;
  }>(
    `SELECT receipt_id, reason_code, payload_sha256, payload_bytes, created_at
       FROM record_rejections
      WHERE replay_key = $1
      LIMIT 1`,
    [prepared.key]
  );
  const [existingRow] = existing.rows;
  if (existingRow) {
    return await replayPostgresRecordRejection(
      client,
      existingRow.receipt_id,
      existingRow.reason_code,
      input.inputIndex,
      input.runId
    );
  }
  await admitPostgresRecordRejectionQuota(client, input, prepared);
  const receiptId = newReceiptId();
  const createdAt = nowIso();
  await client.query(
    `INSERT INTO record_rejections(
    receipt_id, owner_subject_id, connector_instance_id, connector_id, stream, run_id,
    first_input_index, latest_input_index, first_run_id, latest_run_id, reason_code, payload, payload_sha256,
    payload_bytes, rejection_generation, replay_key, replay_count, status, created_at, last_seen_at
  ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, 'pending', $17, $18)`,
    [
      receiptId,
      input.ownerSubjectId,
      input.connectorInstanceId,
      input.connectorId,
      input.stream,
      input.runId ?? null,
      input.inputIndex,
      input.inputIndex,
      input.runId ?? null,
      input.runId ?? null,
      input.reasonCode,
      prepared.rawLine,
      prepared.digest,
      prepared.bytes,
      RECORD_REJECTION_GENERATION,
      prepared.key,
      createdAt,
      createdAt,
    ]
  );
  await emitPostgresRecordRejectionAudit(client, input, {
    connectionId: input.connectorInstanceId,
    createdAt,
    lastSeenAt: createdAt,
    payloadBytes: prepared.bytes,
    payloadSha256: prepared.digest,
    reasonCode: input.reasonCode,
    receiptId,
    replayed: false,
    stream: input.stream,
  });
  return { code: input.reasonCode, inputIndex: input.inputIndex, receiptId, replayed: false };
}

export function insertOrReplayPostgresRecordRejection(
  input: InsertOrReplayRecordRejectionInput
): Promise<RecordRejectionReceipt> {
  return withPostgresTransaction((client) => insertOrReplayPostgresRecordRejectionWithClient(client, input), {
    lockConnectorInstanceId: input.connectorInstanceId,
  }).then(async (receipt) => {
    if (!receipt.replayed) {
      await applyRetainedSizeRecordRejectionDelta({
        connectorId: input.connectorId,
        connectorInstanceId: input.connectorInstanceId,
        recordRejectionCountDelta: 1,
        recordRejectionPayloadBytesDelta: boundedPayloadBytes(input),
        stream: input.stream,
      });
    }
    return receipt;
  });
}

export function insertOrReplayHostedPostgresRecordRejection(
  input: InsertOrReplayRecordRejectionInput,
  hooks: HostedRecordRejectionCoordinatorHooks = {}
): Promise<RecordRejectionReceipt> {
  return withPostgresTransaction(
    async (client) => {
      const receipt = await insertOrReplayPostgresRecordRejectionWithClient(client, input);
      await hooks.afterInsertOrReplayBeforeCommit?.(receipt);
      return receipt;
    },
    {
      lockConnectorInstanceId: input.connectorInstanceId,
    }
  ).then(async (receipt) => {
    if (!receipt.replayed) {
      await applyRetainedSizeRecordRejectionDelta({
        connectorId: input.connectorId,
        connectorInstanceId: input.connectorInstanceId,
        recordRejectionCountDelta: 1,
        recordRejectionPayloadBytesDelta: boundedPayloadBytes(input),
        stream: input.stream,
      });
    }
    return receipt;
  });
}

export function insertOrReplayHostedRecordRejection(
  input: InsertOrReplayRecordRejectionInput,
  hooks: HostedRecordRejectionCoordinatorHooks = {}
): Promise<RecordRejectionReceipt> {
  if (isPostgresStorageBackend()) {
    return insertOrReplayHostedPostgresRecordRejection(input, hooks);
  }
  return Promise.resolve(insertOrReplayHostedSqliteRecordRejection(input, hooks));
}

export async function markPostgresAcceptedRecordRejectionsStaleWithClient(
  client: PoolClient,
  input: MarkAcceptedRecordRejectionsStaleInput
): Promise<number> {
  assertRequiredInputStrings({ ...input, inputIndex: 0, rawLine: input.rawLine, reasonCode: "accepted_record" });
  if (!hasNonEmptyRawLine(input.rawLine)) {
    throw new RecordRejectionStoreError("invalid_rejection_input", "rawLine is required.", { retryable: false });
  }
  const acceptedAt = nowIso();
  const result = await client.query(
    `UPDATE record_rejections
        SET status = 'stale_after_acceptance',
            accepted_run_id = $1,
            accepted_record_key = $2,
            accepted_at = $3,
            last_seen_at = $3
      WHERE owner_subject_id = $4
        AND connector_instance_id = $5
        AND connector_id = $6
        AND stream = $7
        AND payload_sha256 = $8
        AND status = 'pending'`,
    [
      input.runId ?? null,
      input.recordKey ?? null,
      acceptedAt,
      input.ownerSubjectId,
      input.connectorInstanceId,
      input.connectorId,
      input.stream,
      sha256Hex(Buffer.isBuffer(input.rawLine) ? input.rawLine : Buffer.from(input.rawLine, "utf8")),
    ]
  );
  return result.rowCount ?? 0;
}

export function markPostgresAcceptedRecordRejectionsStale(
  input: MarkAcceptedRecordRejectionsStaleInput
): Promise<number> {
  return withPostgresTransaction((client) => markPostgresAcceptedRecordRejectionsStaleWithClient(client, input), {
    lockConnectorInstanceId: input.connectorInstanceId,
  });
}

export function markAcceptedRecordRejectionsStale(input: MarkAcceptedRecordRejectionsStaleInput): Promise<number> {
  if (isPostgresStorageBackend()) {
    return markPostgresAcceptedRecordRejectionsStale(input);
  }
  return Promise.resolve(markSqliteAcceptedRecordRejectionsStale(input));
}

export async function getPostgresRecordRejectionDetail(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
  receiptId: string;
}): Promise<RecordRejectionDetail | null> {
  const row = await postgresQuery<RecordRejectionRow>(
    `SELECT r.*, q.pending_payload_bytes, q.pending_receipt_count,
            (
              SELECT COUNT(*)::bigint
                FROM record_rejections cr
               WHERE cr.owner_subject_id = r.owner_subject_id
                 AND cr.connector_instance_id = r.connector_instance_id
            ) AS connection_receipt_count
       FROM record_rejections r
       JOIN record_rejection_quota q ON q.owner_subject_id = r.owner_subject_id
      WHERE r.owner_subject_id = $1 AND r.connector_instance_id = $2 AND r.receipt_id = $3
      LIMIT 1`,
    [args.ownerSubjectId, args.connectorInstanceId, args.receiptId]
  );
  return row.rows[0] ? mapDetail(row.rows[0]) : null;
}

export async function listPostgresRecordRejections(args: {
  connectorInstanceId: string;
  cursor?: string | null;
  limit: number;
  maxConnectionReceipts?: number;
  maxOwnerReceipts?: number;
  ownerSubjectId: string;
  quotaBytes?: number;
}): Promise<RecordRejectionPage> {
  const limit = pageSize(args.limit);
  const cursor = decodeCursor(args.cursor);
  const params: unknown[] = [args.ownerSubjectId, args.connectorInstanceId];
  let cursorClause = "";
  if (cursor) {
    cursorClause = "AND (created_at, receipt_id) > ($3, $4)";
    params.push(cursor.createdAt, cursor.receiptId);
  }
  params.push(limit + 1);
  const limitIndex = params.length;
  const rows = await postgresQuery<RecordRejectionRow>(
    `SELECT receipt_id, owner_subject_id, connector_instance_id, connector_id, stream, run_id,
            first_input_index, latest_input_index, reason_code, payload_sha256,
            payload_bytes, replay_count, status, created_at, last_seen_at,
            record_rejection_quota.pending_receipt_count,
            record_rejection_quota.pending_payload_bytes,
            (
              SELECT COUNT(*)::bigint FROM record_rejections AS connection_rejections
               WHERE connection_rejections.owner_subject_id = record_rejections.owner_subject_id
                 AND connection_rejections.connector_instance_id = record_rejections.connector_instance_id
            ) AS connection_receipt_count
       FROM record_rejections
       JOIN record_rejection_quota USING (owner_subject_id)
      WHERE owner_subject_id = $1 AND connector_instance_id = $2
        ${cursorClause}
      ORDER BY created_at ASC, receipt_id ASC
      LIMIT $${limitIndex}`,
    params
  );
  const policy = {
    connectionReceiptCount: normalizeCountLimit(
      args.maxConnectionReceipts,
      RECORD_REJECTION_CONNECTION_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_CONNECTION_QUOTA_COUNT
    ),
    ownerPayloadBytes: normalizeQuota(args.quotaBytes),
    ownerReceiptCount: normalizeCountLimit(
      args.maxOwnerReceipts,
      RECORD_REJECTION_OWNER_QUOTA_COUNT_ENV,
      DEFAULT_RECORD_REJECTION_OWNER_QUOTA_COUNT
    ),
  };
  const mapped = rows.rows.map((row) => mapMetadata(row, policy));
  const items = mapped.slice(0, limit);
  return { items, nextCursor: mapped.length > limit ? encodeCursor(lastPageItem(items)) : null };
}

export async function deletePostgresRecordRejectionsForConnectionWithClient(
  client: PoolClient,
  args: {
    connectorInstanceId: string;
    ownerSubjectId: string;
  }
): Promise<number> {
  const total = await client.query<{ bytes: string }>(
    `SELECT COALESCE(SUM(payload_bytes), 0)::bigint AS bytes
         FROM record_rejections
        WHERE owner_subject_id = $1 AND connector_instance_id = $2`,
    [args.ownerSubjectId, args.connectorInstanceId]
  );
  const deleted = await client.query(
    "DELETE FROM record_rejections WHERE owner_subject_id = $1 AND connector_instance_id = $2",
    [args.ownerSubjectId, args.connectorInstanceId]
  );
  if ((deleted.rowCount ?? 0) > 0) {
    await client.query(
      `UPDATE record_rejection_quota
            SET pending_payload_bytes = pending_payload_bytes - $1,
                pending_receipt_count = pending_receipt_count - $2,
                updated_at = $3
          WHERE owner_subject_id = $4`,
      [Number(total.rows[0]?.bytes ?? 0), deleted.rowCount ?? 0, nowIso(), args.ownerSubjectId]
    );
  }
  return deleted.rowCount ?? 0;
}

export function deletePostgresRecordRejectionsForConnection(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
}): Promise<number> {
  return withPostgresTransaction((client) => deletePostgresRecordRejectionsForConnectionWithClient(client, args), {
    lockConnectorInstanceId: args.connectorInstanceId,
  }).then(async (deleted) => {
    if (deleted > 0) {
      await markRetainedSizeConnectionDirty({ connectorInstanceId: args.connectorInstanceId });
    }
    return deleted;
  });
}

export function createRecordRejectionStore() {
  if (isPostgresStorageBackend()) {
    return {
      deleteForConnection: deletePostgresRecordRejectionsForConnection,
      getDetail: getPostgresRecordRejectionDetail,
      insertOrReplay: insertOrReplayPostgresRecordRejection,
      list: listPostgresRecordRejections,
      markAcceptedStale: markPostgresAcceptedRecordRejectionsStale,
    };
  }
  return {
    deleteForConnection: (args: Parameters<typeof deleteSqliteRecordRejectionsForConnection>[0]) =>
      Promise.resolve(deleteSqliteRecordRejectionsForConnection(args)),
    getDetail: (args: Parameters<typeof getSqliteRecordRejectionDetail>[0]) =>
      Promise.resolve(getSqliteRecordRejectionDetail(args)),
    insertOrReplay: async (input: InsertOrReplayRecordRejectionInput) => insertOrReplaySqliteRecordRejection(input),
    list: (args: Parameters<typeof listSqliteRecordRejections>[0]) => Promise.resolve(listSqliteRecordRejections(args)),
    markAcceptedStale: (input: MarkAcceptedRecordRejectionsStaleInput) =>
      Promise.resolve(markSqliteAcceptedRecordRejectionsStale(input)),
  };
}
