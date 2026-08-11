// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { exec, getMany, getOne, referenceQueries, writeTransaction } from "../../lib/db.ts";
import { HOSTED_INGEST_MAX_LINE_BYTES } from "../hosted-ingest-limits.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";

export const RECORD_REJECTION_GENERATION = "record-rejection-v1";
const DEFAULT_OWNER_QUOTA_BYTES = 10 * 1024 * 1024;
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
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly inputIndex: number;
  readonly maxPayloadBytes?: number;
  readonly ownerSubjectId: string;
  readonly quotaBytes?: number;
  readonly rawLine: string;
  readonly reasonCode: string;
  readonly runId?: string | null;
  readonly stream: string;
}

export interface RecordRejectionReceipt {
  readonly code: string;
  readonly inputIndex: number;
  readonly receiptId: string;
  readonly replayed: boolean;
}

export interface RecordRejectionMetadata {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt: string;
  readonly firstInputIndex: number;
  readonly lastSeenAt: string;
  readonly latestInputIndex: number;
  readonly ownerSubjectId: string;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
  readonly reasonCode: string;
  readonly receiptId: string;
  readonly replayCount: number;
  readonly runId: string | null;
  readonly status: "pending";
  readonly stream: string;
}

export interface RecordRejectionDetail extends RecordRejectionMetadata {
  readonly payloadText: string;
}

export interface RecordRejectionPage {
  readonly items: readonly RecordRejectionMetadata[];
  readonly nextCursor: string | null;
}

interface RecordRejectionRow extends QueryResultRow {
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  first_input_index: number | string;
  last_seen_at: string;
  latest_input_index: number | string;
  owner_subject_id: string;
  payload_bytes: number | string;
  payload_sha256: string;
  payload_text?: string;
  reason_code: string;
  receipt_id: string;
  replay_count: number | string;
  run_id: string | null;
  status: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function replayKey(input: InsertOrReplayRecordRejectionInput, digest: string): string {
  return sha256Hex(
    JSON.stringify([input.ownerSubjectId, input.connectorInstanceId, input.stream, digest, RECORD_REJECTION_GENERATION])
  );
}

function newReceiptId(): string {
  return `rr_${randomBytes(18).toString("base64url")}`;
}

function normalizeQuota(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_OWNER_QUOTA_BYTES;
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
  const bytes = payloadBytes(input.rawLine);
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
  for (const [name, value] of [
    ["ownerSubjectId", input.ownerSubjectId],
    ["connectorInstanceId", input.connectorInstanceId],
    ["connectorId", input.connectorId],
    ["stream", input.stream],
    ["rawLine", input.rawLine],
    ["reasonCode", input.reasonCode],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new RecordRejectionStoreError("invalid_rejection_input", `${name} is required.`, { retryable: false });
    }
  }
}

function mapMetadata(row: RecordRejectionRow): RecordRejectionMetadata {
  return {
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    createdAt: row.created_at,
    firstInputIndex: Number(row.first_input_index),
    lastSeenAt: row.last_seen_at,
    latestInputIndex: Number(row.latest_input_index),
    ownerSubjectId: row.owner_subject_id,
    payloadBytes: Number(row.payload_bytes),
    payloadSha256: row.payload_sha256,
    reasonCode: row.reason_code,
    receiptId: row.receipt_id,
    replayCount: Number(row.replay_count),
    runId: row.run_id,
    status: "pending",
    stream: row.stream,
  };
}

function mapDetail(row: RecordRejectionRow): RecordRejectionDetail {
  return {
    ...mapMetadata(row),
    payloadText: row.payload_text ?? "",
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

function assertSqliteWritable(
  ownerSubjectId: string,
  connectorInstanceId: string,
  connectorId: string,
  runId?: string | null
) {
  const connection = getOne<{ status: string }>(referenceQueries.recordRejectionsGetConnectionStatus, [
    ownerSubjectId,
    connectorInstanceId,
    connectorId,
  ]);
  if (!connection || connection.status === "revoked") {
    throw new RecordRejectionStoreError("connection_not_writable", "Connection is not writable.");
  }
  if (runId) {
    const run = getOne<{ status: string }>(referenceQueries.controllerGetRunHistoryStatusForRun, [
      runId,
      connectorInstanceId,
    ]);
    if (run?.status !== "running") {
      throw new RecordRejectionStoreError("run_not_writable", "Run is not writable.");
    }
  }
}

export function insertOrReplaySqliteRecordRejection(input: InsertOrReplayRecordRejectionInput): RecordRejectionReceipt {
  assertInput(input);
  const bytes = boundedPayloadBytes(input);
  const digest = sha256Hex(input.rawLine);
  const key = replayKey(input, digest);
  const quota = normalizeQuota(input.quotaBytes);
  return writeTransaction(() => {
    assertSqliteWritable(input.ownerSubjectId, input.connectorInstanceId, input.connectorId, input.runId);
    const existing = getOne<{ reason_code: string; receipt_id: string }>(
      referenceQueries.recordRejectionsGetByReplayKey,
      [key]
    );
    if (existing) {
      exec(referenceQueries.recordRejectionsUpdateReplay, [input.inputIndex, nowIso(), existing.receipt_id]);
      return {
        code: existing.reason_code,
        inputIndex: input.inputIndex,
        receiptId: existing.receipt_id,
        replayed: true,
      };
    }
    exec(referenceQueries.recordRejectionsEnsureQuotaOwner, [input.ownerSubjectId, nowIso()]);
    const admitted = exec(referenceQueries.recordRejectionsAdmitQuota, [
      bytes,
      nowIso(),
      input.ownerSubjectId,
      bytes,
      quota,
    ]);
    if (admitted.changes !== 1) {
      throw new RecordRejectionStoreError("record_rejection_quota_exceeded", "Record rejection quota is exhausted.");
    }
    const receiptId = newReceiptId();
    const createdAt = nowIso();
    exec(referenceQueries.recordRejectionsInsert, [
      receiptId,
      input.ownerSubjectId,
      input.connectorInstanceId,
      input.connectorId,
      input.stream,
      input.runId ?? null,
      input.inputIndex,
      input.inputIndex,
      input.reasonCode,
      input.rawLine,
      digest,
      bytes,
      key,
      createdAt,
      createdAt,
    ]);
    return { code: input.reasonCode, inputIndex: input.inputIndex, receiptId, replayed: false };
  });
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
  ownerSubjectId: string;
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
  const items = page.rows.map(mapMetadata);
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
    exec(referenceQueries.recordRejectionsReleaseQuota, [total, nowIso(), args.ownerSubjectId]);
  }
  return deleted.changes;
}

export function deleteSqliteRecordRejectionsForConnection(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
}): number {
  return writeTransaction(() => deleteSqliteRecordRejectionsForConnectionWithinTransaction(args));
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

export function insertOrReplayPostgresRecordRejection(
  input: InsertOrReplayRecordRejectionInput
): Promise<RecordRejectionReceipt> {
  assertInput(input);
  const bytes = boundedPayloadBytes(input);
  const digest = sha256Hex(input.rawLine);
  const key = replayKey(input, digest);
  const quota = normalizeQuota(input.quotaBytes);
  return withPostgresTransaction(
    async (client) => {
      await assertPostgresWritable(
        client,
        input.ownerSubjectId,
        input.connectorInstanceId,
        input.connectorId,
        input.runId
      );
      const existing = await client.query<{ reason_code: string; receipt_id: string }>(
        "SELECT receipt_id, reason_code FROM record_rejections WHERE replay_key = $1 LIMIT 1",
        [key]
      );
      const [existingRow] = existing.rows;
      if (existingRow) {
        const receiptId = existingRow.receipt_id;
        await client.query(
          `UPDATE record_rejections
            SET replay_count = replay_count + 1,
                latest_input_index = $1,
                last_seen_at = $2
          WHERE receipt_id = $3`,
          [input.inputIndex, nowIso(), receiptId]
        );
        return { code: existingRow.reason_code, inputIndex: input.inputIndex, receiptId, replayed: true };
      }
      await client.query(
        `INSERT INTO record_rejection_quota(owner_subject_id, pending_payload_bytes, updated_at)
       VALUES($1, 0, $2)
       ON CONFLICT(owner_subject_id) DO NOTHING`,
        [input.ownerSubjectId, nowIso()]
      );
      const admitted = await client.query(
        `UPDATE record_rejection_quota
          SET pending_payload_bytes = pending_payload_bytes + $1,
              updated_at = $2
        WHERE owner_subject_id = $3
          AND pending_payload_bytes + $1 <= $4`,
        [bytes, nowIso(), input.ownerSubjectId, quota]
      );
      if (admitted.rowCount !== 1) {
        throw new RecordRejectionStoreError("record_rejection_quota_exceeded", "Record rejection quota is exhausted.");
      }
      const receiptId = newReceiptId();
      const createdAt = nowIso();
      await client.query(
        `INSERT INTO record_rejections(
        receipt_id, owner_subject_id, connector_instance_id, connector_id, stream, run_id,
        first_input_index, latest_input_index, reason_code, payload_text, payload_sha256,
        payload_bytes, replay_key, replay_count, status, created_at, last_seen_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, 'pending', $14, $15)`,
        [
          receiptId,
          input.ownerSubjectId,
          input.connectorInstanceId,
          input.connectorId,
          input.stream,
          input.runId ?? null,
          input.inputIndex,
          input.inputIndex,
          input.reasonCode,
          input.rawLine,
          digest,
          bytes,
          key,
          createdAt,
          createdAt,
        ]
      );
      return { code: input.reasonCode, inputIndex: input.inputIndex, receiptId, replayed: false };
    },
    { lockConnectorInstanceId: input.connectorInstanceId }
  );
}

export async function getPostgresRecordRejectionDetail(args: {
  connectorInstanceId: string;
  ownerSubjectId: string;
  receiptId: string;
}): Promise<RecordRejectionDetail | null> {
  const row = await postgresQuery<RecordRejectionRow>(
    `SELECT * FROM record_rejections
      WHERE owner_subject_id = $1 AND connector_instance_id = $2 AND receipt_id = $3
      LIMIT 1`,
    [args.ownerSubjectId, args.connectorInstanceId, args.receiptId]
  );
  return row.rows[0] ? mapDetail(row.rows[0]) : null;
}

export async function listPostgresRecordRejections(args: {
  connectorInstanceId: string;
  cursor?: string | null;
  limit: number;
  ownerSubjectId: string;
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
            payload_bytes, replay_count, status, created_at, last_seen_at
       FROM record_rejections
      WHERE owner_subject_id = $1 AND connector_instance_id = $2
        ${cursorClause}
      ORDER BY created_at ASC, receipt_id ASC
      LIMIT $${limitIndex}`,
    params
  );
  const mapped = rows.rows.map(mapMetadata);
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
                updated_at = $2
          WHERE owner_subject_id = $3`,
      [Number(total.rows[0]?.bytes ?? 0), nowIso(), args.ownerSubjectId]
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
  });
}

export function createRecordRejectionStore() {
  if (isPostgresStorageBackend()) {
    return {
      deleteForConnection: deletePostgresRecordRejectionsForConnection,
      getDetail: getPostgresRecordRejectionDetail,
      insertOrReplay: insertOrReplayPostgresRecordRejection,
      list: listPostgresRecordRejections,
    };
  }
  return {
    deleteForConnection: (args: Parameters<typeof deleteSqliteRecordRejectionsForConnection>[0]) =>
      Promise.resolve(deleteSqliteRecordRejectionsForConnection(args)),
    getDetail: (args: Parameters<typeof getSqliteRecordRejectionDetail>[0]) =>
      Promise.resolve(getSqliteRecordRejectionDetail(args)),
    insertOrReplay: async (input: InsertOrReplayRecordRejectionInput) => insertOrReplaySqliteRecordRejection(input),
    list: (args: Parameters<typeof listSqliteRecordRejections>[0]) => Promise.resolve(listSqliteRecordRejections(args)),
  };
}
