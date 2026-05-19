import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashCanonicalJson } from "./local-device-envelope.ts";

const CURRENT_SCHEMA_VERSION = 1;

export type LocalDeviceOutboxKind = "record_batch" | "checkpoint" | "gap" | "blob_upload";
export type LocalDeviceOutboxStatus = "ready" | "leased" | "succeeded" | "dead_letter";

export interface LocalDeviceOutboxItem {
  acknowledged_at: string | null;
  attempt_count: number;
  body_hash: string;
  created_at: string;
  id: string;
  kind: LocalDeviceOutboxKind;
  last_error: string | null;
  lease_epoch: number;
  lease_holder: string | null;
  lease_until: string | null;
  next_attempt_at: string;
  payload: unknown;
  source_instance_id: string;
  status: LocalDeviceOutboxStatus;
  updated_at: string;
}

export interface LocalDeviceOutboxSummary {
  deadLetter: number;
  leased: number;
  oldestReadyAt: string | null;
  ready: number;
  retrying: number;
  staleLeases: number;
  succeeded: number;
  total: number;
}

interface LocalDeviceOutboxRow {
  acknowledged_at: string | null;
  attempt_count: number;
  body_hash: string;
  created_at: string;
  id: string;
  kind: LocalDeviceOutboxKind;
  last_error: string | null;
  lease_epoch: number;
  lease_holder: string | null;
  lease_until: string | null;
  next_attempt_at: string;
  payload_json: string;
  source_instance_id: string;
  status: LocalDeviceOutboxStatus;
  updated_at: string;
}

export interface LocalDeviceOutboxOptions {
  clock?: () => Date;
  path: string;
}

export interface LocalDeviceOutboxEnqueueInput {
  id: string;
  kind: LocalDeviceOutboxKind;
  nextAttemptAt?: Date;
  payload: unknown;
  sourceInstanceId: string;
}

export interface BuildLocalDeviceOutboxIdInput {
  kind: LocalDeviceOutboxKind;
  parts: readonly unknown[];
  sourceInstanceId: string;
}

export interface LocalDeviceOutboxClaimInput {
  holder: string;
  leaseMs: number;
  limit?: number;
  sourceInstanceId?: string;
}

export interface LocalDeviceOutboxLeaseInput {
  holder: string;
  id: string;
  leaseEpoch: number;
}

export interface LocalDeviceOutboxFailInput extends LocalDeviceOutboxLeaseInput {
  error: string;
  retryBackoffMs: number;
}

export interface LocalDeviceOutboxDeadLetterInput extends LocalDeviceOutboxLeaseInput {
  error: string;
}

export interface LocalDeviceOutboxRenewInput extends LocalDeviceOutboxLeaseInput {
  leaseMs: number;
}

export class LocalDeviceOutbox {
  readonly #clock: () => Date;
  readonly #db: DatabaseSync;

  constructor(options: LocalDeviceOutboxOptions) {
    this.#clock = options.clock ?? (() => new Date());
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.#db = new DatabaseSync(options.path);
    this.#initialize();
  }

  close(): void {
    this.#db.close();
  }

  enqueue(input: LocalDeviceOutboxEnqueueInput): LocalDeviceOutboxItem {
    const now = this.#now();
    const payloadJson = JSON.stringify(input.payload);
    const bodyHash = hashCanonicalJson(input.payload);
    const existing = this.get(input.id);
    if (existing) {
      if (
        existing.body_hash !== bodyHash ||
        existing.kind !== input.kind ||
        existing.source_instance_id !== input.sourceInstanceId
      ) {
        throw new Error(`local outbox id collision with different payload: ${input.id}`);
      }
      return existing;
    }
    const row: LocalDeviceOutboxRow = {
      acknowledged_at: null,
      attempt_count: 0,
      body_hash: bodyHash,
      created_at: now,
      id: input.id,
      kind: input.kind,
      last_error: null,
      lease_epoch: 0,
      lease_holder: null,
      lease_until: null,
      next_attempt_at: (input.nextAttemptAt ?? this.#clock()).toISOString(),
      payload_json: payloadJson,
      source_instance_id: input.sourceInstanceId,
      status: "ready",
      updated_at: now,
    };
    this.#db
      .prepare(
        `INSERT INTO local_device_outbox (
          id,
          source_instance_id,
          kind,
          status,
          payload_json,
          body_hash,
          attempt_count,
          next_attempt_at,
          lease_holder,
          lease_epoch,
          lease_until,
          last_error,
          acknowledged_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.source_instance_id,
        row.kind,
        row.status,
        row.payload_json,
        row.body_hash,
        row.attempt_count,
        row.next_attempt_at,
        row.lease_holder,
        row.lease_epoch,
        row.lease_until,
        row.last_error,
        row.acknowledged_at,
        row.created_at,
        row.updated_at
      );
    return rowToItem(row);
  }

  claimReady(input: LocalDeviceOutboxClaimInput): LocalDeviceOutboxItem[] {
    const now = this.#now();
    const leaseUntil = new Date(this.#clock().getTime() + input.leaseMs).toISOString();
    const limit = Math.max(1, input.limit ?? 1);
    const candidates = this.#selectReady(input.sourceInstanceId, now, limit);
    const claimed: LocalDeviceOutboxItem[] = [];
    for (const candidate of candidates) {
      const nextEpoch = candidate.lease_epoch + 1;
      const result = this.#db
        .prepare(
          `UPDATE local_device_outbox
             SET status = 'leased',
                 lease_holder = ?,
                 lease_epoch = ?,
                 lease_until = ?,
                 updated_at = ?
           WHERE id = ?
             AND status = 'ready'`
        )
        .run(input.holder, nextEpoch, leaseUntil, now, candidate.id);
      if (result.changes !== 1) {
        continue;
      }
      const next = this.get(candidate.id);
      if (next) {
        claimed.push(next);
      }
    }
    return claimed;
  }

  acknowledge(input: LocalDeviceOutboxLeaseInput): void {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `UPDATE local_device_outbox
           SET status = 'succeeded',
               acknowledged_at = ?,
               lease_holder = NULL,
               lease_until = NULL,
               updated_at = ?
         WHERE id = ?
           AND status = 'leased'
           AND lease_holder = ?
           AND lease_epoch = ?
           AND lease_until > ?`
      )
      .run(now, now, input.id, input.holder, input.leaseEpoch, now);
    assertOneChange(Number(result.changes), `local outbox lease not current for acknowledge: ${input.id}`);
  }

  failRetryable(input: LocalDeviceOutboxFailInput): void {
    const now = this.#now();
    const nextAttemptAt = new Date(this.#clock().getTime() + input.retryBackoffMs).toISOString();
    const result = this.#db
      .prepare(
        `UPDATE local_device_outbox
           SET status = 'ready',
               attempt_count = attempt_count + 1,
               next_attempt_at = ?,
               lease_holder = NULL,
               lease_until = NULL,
               last_error = ?,
               updated_at = ?
         WHERE id = ?
           AND status = 'leased'
           AND lease_holder = ?
           AND lease_epoch = ?
           AND lease_until > ?`
      )
      .run(nextAttemptAt, input.error, now, input.id, input.holder, input.leaseEpoch, now);
    assertOneChange(Number(result.changes), `local outbox lease not current for retry: ${input.id}`);
  }

  deadLetter(input: LocalDeviceOutboxDeadLetterInput): void {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `UPDATE local_device_outbox
           SET status = 'dead_letter',
               attempt_count = attempt_count + 1,
               lease_holder = NULL,
               lease_until = NULL,
               last_error = ?,
               updated_at = ?
         WHERE id = ?
           AND status = 'leased'
           AND lease_holder = ?
           AND lease_epoch = ?
           AND lease_until > ?`
      )
      .run(input.error, now, input.id, input.holder, input.leaseEpoch, now);
    assertOneChange(Number(result.changes), `local outbox lease not current for dead-letter: ${input.id}`);
  }

  renewLease(input: LocalDeviceOutboxRenewInput): LocalDeviceOutboxItem {
    const now = this.#now();
    const leaseUntil = new Date(this.#clock().getTime() + input.leaseMs).toISOString();
    const result = this.#db
      .prepare(
        `UPDATE local_device_outbox
           SET lease_until = ?,
               updated_at = ?
         WHERE id = ?
           AND status = 'leased'
           AND lease_holder = ?
           AND lease_epoch = ?
           AND lease_until > ?`
      )
      .run(leaseUntil, now, input.id, input.holder, input.leaseEpoch, now);
    assertOneChange(Number(result.changes), `local outbox lease not current for renew: ${input.id}`);
    const item = this.get(input.id);
    if (!item) {
      throw new Error(`local outbox item missing after renew: ${input.id}`);
    }
    return item;
  }

  recoverExpiredLeases(input: { sourceInstanceId?: string } = {}): number {
    const now = this.#now();
    const sql = `UPDATE local_device_outbox
       SET status = 'ready',
           lease_holder = NULL,
           lease_until = NULL,
           last_error = COALESCE(last_error, 'lease expired before acknowledgement'),
           updated_at = ?
     WHERE status = 'leased'
       AND lease_until IS NOT NULL
       AND lease_until <= ?`;
    const result = input.sourceInstanceId
      ? this.#db.prepare(`${sql} AND source_instance_id = ?`).run(now, now, input.sourceInstanceId)
      : this.#db.prepare(sql).run(now, now);
    return Number(result.changes);
  }

  get(id: string): LocalDeviceOutboxItem | null {
    const row = this.#db.prepare("SELECT * FROM local_device_outbox WHERE id = ?").get(id);
    return row ? rowToItem(row) : null;
  }

  list(input: { sourceInstanceId?: string } = {}): LocalDeviceOutboxItem[] {
    const rows = input.sourceInstanceId
      ? this.#db
          .prepare(
            `SELECT * FROM local_device_outbox
              WHERE source_instance_id = ?
              ORDER BY source_instance_id, created_at, id`
          )
          .all(input.sourceInstanceId)
      : this.#db
          .prepare(
            `SELECT * FROM local_device_outbox
              ORDER BY source_instance_id, created_at, id`
          )
          .all();
    return rows.map((row) => rowToItem(row));
  }

  /**
   * Fast summary using SQL aggregation instead of materializing every row.
   *
   * Necessary for large outboxes where `list()` would copy the full table
   * (including payload JSON) into memory just to count statuses. The single
   * aggregation query reads the indexed status column and ISO-string
   * timestamps directly.
   */
  summary(input: { sourceInstanceId?: string } = {}): LocalDeviceOutboxSummary {
    const now = this.#now();
    const summary: LocalDeviceOutboxSummary = {
      deadLetter: 0,
      leased: 0,
      oldestReadyAt: null,
      ready: 0,
      retrying: 0,
      staleLeases: 0,
      succeeded: 0,
      total: 0,
    };
    const aggregateSql = `
      SELECT
        status,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'ready' AND next_attempt_at > ? THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'leased' AND lease_until IS NOT NULL AND lease_until <= ? THEN 1 ELSE 0 END) AS stale_leases,
        MIN(CASE WHEN status = 'ready' THEN created_at ELSE NULL END) AS oldest_ready
      FROM local_device_outbox
      ${input.sourceInstanceId ? "WHERE source_instance_id = ?" : ""}
      GROUP BY status`;
    const statement = this.#db.prepare(aggregateSql);
    const rows = input.sourceInstanceId ? statement.all(now, now, input.sourceInstanceId) : statement.all(now, now);
    for (const rowLike of rows) {
      if (!isRecord(rowLike)) {
        continue;
      }
      const status = rowLike.status;
      const total = numberFrom(rowLike.total);
      summary.total += total;
      if (status === "ready") {
        summary.ready = total;
        summary.retrying = numberFrom(rowLike.retrying);
        const oldest = rowLike.oldest_ready;
        if (typeof oldest === "string") {
          summary.oldestReadyAt = oldest;
        }
      } else if (status === "leased") {
        summary.leased = total;
        summary.staleLeases = numberFrom(rowLike.stale_leases);
      } else if (status === "succeeded") {
        summary.succeeded = total;
      } else if (status === "dead_letter") {
        summary.deadLetter = total;
      }
    }
    return summary;
  }

  #initialize(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    const version = this.#schemaVersion();
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `local outbox schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
      );
    }
    if (version < 1) {
      this.#applySchemaV1();
      this.#db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      return;
    }
    this.#applySchemaV1();
  }

  #applySchemaV1(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS local_device_outbox (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('record_batch', 'checkpoint', 'gap', 'blob_upload')),
        status TEXT NOT NULL CHECK (status IN ('ready', 'leased', 'succeeded', 'dead_letter')),
        payload_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_holder TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        last_error TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_device_outbox_ready_idx
        ON local_device_outbox (status, next_attempt_at, source_instance_id, created_at);
      CREATE INDEX IF NOT EXISTS local_device_outbox_lease_idx
        ON local_device_outbox (status, lease_until);
      CREATE INDEX IF NOT EXISTS local_device_outbox_source_idx
        ON local_device_outbox (source_instance_id, status);
    `);
  }

  #selectReady(sourceInstanceId: string | undefined, now: string, limit: number): LocalDeviceOutboxRow[] {
    if (sourceInstanceId) {
      return this.#db
        .prepare(
          `SELECT * FROM local_device_outbox
            WHERE status = 'ready'
              AND source_instance_id = ?
              AND next_attempt_at <= ?
            ORDER BY created_at, id
            LIMIT ?`
        )
        .all(sourceInstanceId, now, limit)
        .map(asOutboxRow);
    }
    return this.#db
      .prepare(
        `SELECT * FROM local_device_outbox
          WHERE status = 'ready'
            AND next_attempt_at <= ?
          ORDER BY source_instance_id, created_at, id
          LIMIT ?`
      )
      .all(now, limit)
      .map(asOutboxRow);
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #schemaVersion(): number {
    const row = this.#db.prepare("PRAGMA user_version").get();
    if (!isRecord(row)) {
      return 0;
    }
    const version = row.user_version;
    return typeof version === "bigint" || typeof version === "number" ? Number(version) : 0;
  }
}

export function buildLocalDeviceOutboxId(input: BuildLocalDeviceOutboxIdInput): string {
  return `local-outbox:${hashCanonicalJson({
    kind: input.kind,
    parts: input.parts,
    source_instance_id: input.sourceInstanceId,
  })}`;
}

function rowToItem(rowLike: unknown): LocalDeviceOutboxItem {
  const row = asOutboxRow(rowLike);
  return {
    acknowledged_at: row.acknowledged_at,
    attempt_count: row.attempt_count,
    body_hash: row.body_hash,
    created_at: row.created_at,
    id: row.id,
    kind: row.kind,
    last_error: row.last_error,
    lease_epoch: row.lease_epoch,
    lease_holder: row.lease_holder,
    lease_until: row.lease_until,
    next_attempt_at: row.next_attempt_at,
    payload: JSON.parse(row.payload_json) as unknown,
    source_instance_id: row.source_instance_id,
    status: row.status,
    updated_at: row.updated_at,
  };
}

function assertOneChange(changes: number, message: string): void {
  if (changes !== 1) {
    throw new Error(message);
  }
}

function asOutboxRow(row: unknown): LocalDeviceOutboxRow {
  if (!isRecord(row)) {
    throw new Error("local outbox query returned a non-object row");
  }
  const kind = row.kind;
  const status = row.status;
  if (typeof row.acknowledged_at !== "string" && row.acknowledged_at !== null) {
    throw new Error("local outbox row has invalid acknowledged_at");
  }
  if (
    typeof row.attempt_count !== "number" ||
    typeof row.body_hash !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.id !== "string" ||
    !isOutboxKind(kind) ||
    typeof row.lease_epoch !== "number" ||
    (typeof row.lease_holder !== "string" && row.lease_holder !== null) ||
    (typeof row.lease_until !== "string" && row.lease_until !== null) ||
    (typeof row.last_error !== "string" && row.last_error !== null) ||
    typeof row.next_attempt_at !== "string" ||
    typeof row.payload_json !== "string" ||
    typeof row.source_instance_id !== "string" ||
    !isOutboxStatus(status) ||
    typeof row.updated_at !== "string"
  ) {
    throw new Error("local outbox row has invalid shape");
  }
  return {
    acknowledged_at: row.acknowledged_at,
    attempt_count: row.attempt_count,
    body_hash: row.body_hash,
    created_at: row.created_at,
    id: row.id,
    kind,
    last_error: row.last_error,
    lease_epoch: row.lease_epoch,
    lease_holder: row.lease_holder,
    lease_until: row.lease_until,
    next_attempt_at: row.next_attempt_at,
    payload_json: row.payload_json,
    source_instance_id: row.source_instance_id,
    status,
    updated_at: row.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberFrom(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return 0;
}

function isOutboxKind(value: unknown): value is LocalDeviceOutboxKind {
  return value === "record_batch" || value === "checkpoint" || value === "gap" || value === "blob_upload";
}

function isOutboxStatus(value: unknown): value is LocalDeviceOutboxStatus {
  return value === "ready" || value === "leased" || value === "succeeded" || value === "dead_letter";
}
