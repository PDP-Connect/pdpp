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
  insert_order: number;
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
  insert_order: number;
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
  excludeKinds?: readonly LocalDeviceOutboxKind[];
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

export interface LocalDeviceOutboxRequeueDeadLettersInput {
  dryRun?: boolean;
  kind?: LocalDeviceOutboxKind;
  limit?: number;
  sourceInstanceId?: string;
}

export interface LocalDeviceOutboxRequeueDeadLettersResult {
  matched: number;
  requeued: number;
}

export interface LocalDeviceOutboxDeadLetterErrorClass {
  /** Count of dead-letter rows whose `last_error` collapses to this class. */
  count: number;
  /**
   * Stable, redacted error class. Derived from the row's `last_error` first
   * line with filesystem paths, credential markers, OTP-shaped digits, long
   * opaque tokens, and volatile ids/numbers scrubbed so structurally
   * identical failures group together. Never contains payloads, tokens,
   * cookies, or host paths.
   */
  error_class: string;
}

export interface LocalDeviceOutboxDeadLetterErrorSummary {
  /** Total dead-letter rows considered (after the optional source scope). */
  dead_letter_count: number;
  /** Dead-letter rows whose `last_error` was null/empty (uncategorized). */
  null_error_count: number;
  /** Top error classes by count, descending, truncated to `limit`. */
  top_classes: LocalDeviceOutboxDeadLetterErrorClass[];
}

export interface LocalDeviceOutboxDeadLetterErrorSummaryInput {
  /** Max distinct classes to return (default 5). */
  limit?: number;
  sourceInstanceId?: string;
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
      insert_order: 0,
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
    const inserted = this.get(row.id);
    if (!inserted) {
      throw new Error(`local outbox insert disappeared before readback: ${row.id}`);
    }
    return inserted;
  }

  claimReady(input: LocalDeviceOutboxClaimInput): LocalDeviceOutboxItem[] {
    const now = this.#now();
    const leaseUntil = new Date(this.#clock().getTime() + input.leaseMs).toISOString();
    const limit = Math.max(1, input.limit ?? 1);
    const candidates = this.#selectReady(input.sourceInstanceId, now, limit, input.excludeKinds);
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

  peekReady(input: { sourceInstanceId?: string } = {}): LocalDeviceOutboxItem | null {
    const [candidate] = this.#selectReady(input.sourceInstanceId, this.#now(), 1);
    return candidate ? rowToItem(candidate) : null;
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
    const row = this.#db.prepare("SELECT *, rowid AS insert_order FROM local_device_outbox WHERE id = ?").get(id);
    return row ? rowToItem(row) : null;
  }

  deleteSucceeded(id: string): boolean {
    const result = this.#db.prepare("DELETE FROM local_device_outbox WHERE id = ? AND status = 'succeeded'").run(id);
    return Number(result.changes) === 1;
  }

  backupTo(path: string): void {
    this.#db.exec(`VACUUM INTO ${sqlStringLiteral(path)}`);
  }

  requeueDeadLetters(input: LocalDeviceOutboxRequeueDeadLettersInput = {}): LocalDeviceOutboxRequeueDeadLettersResult {
    const limit = normalizeLimit(input.limit);
    const { clauses, params } = deadLetterWhere(input);
    const matched = this.#countWhere(clauses, params, limit);
    if (input.dryRun || matched === 0) {
      return { matched, requeued: 0 };
    }

    const now = this.#now();
    const limitSql = limit == null ? "" : " LIMIT ?";
    const selected = this.#db
      .prepare(
        `SELECT id
           FROM local_device_outbox
          WHERE ${clauses.join(" AND ")}
          ORDER BY rowid${limitSql}`
      )
      .all(...(limit == null ? params : [...params, limit]));
    const ids = selected.map((row) => {
      if (!isRecord(row) || typeof row.id !== "string") {
        throw new Error("local outbox dead-letter id query returned an invalid row");
      }
      return row.id;
    });
    if (ids.length === 0) {
      return { matched, requeued: 0 };
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db
        .prepare(
          `UPDATE local_device_outbox
              SET status = 'ready',
                  attempt_count = 0,
                  next_attempt_at = ?,
                  lease_holder = NULL,
                  lease_until = NULL,
                  last_error = NULL,
                  updated_at = ?
            WHERE id IN (${ids.map(() => "?").join(", ")})
              AND status = 'dead_letter'`
        )
        .run(now, now, ...ids);
      this.#db.exec("COMMIT");
      return { matched, requeued: Number(result.changes) };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  hasNonSucceededWork(input: {
    excludeKinds?: readonly LocalDeviceOutboxKind[];
    kinds?: readonly LocalDeviceOutboxKind[];
    sourceInstanceId: string;
  }): boolean {
    const clauses = ["source_instance_id = ?", "status != 'succeeded'"];
    const params: string[] = [input.sourceInstanceId];
    if (input.kinds && input.kinds.length > 0) {
      clauses.push(`kind IN (${input.kinds.map(() => "?").join(", ")})`);
      params.push(...input.kinds);
    }
    if (input.excludeKinds && input.excludeKinds.length > 0) {
      clauses.push(`kind NOT IN (${input.excludeKinds.map(() => "?").join(", ")})`);
      params.push(...input.excludeKinds);
    }
    const row = this.#db
      .prepare(`SELECT 1 AS found FROM local_device_outbox WHERE ${clauses.join(" AND ")} LIMIT 1`)
      .get(...params);
    return Boolean(row);
  }

  hasNonSucceededPredecessor(input: {
    beforeInsertOrder: number;
    kinds: readonly LocalDeviceOutboxKind[];
    sourceInstanceId: string;
  }): boolean {
    if (input.kinds.length === 0) {
      return false;
    }
    const row = this.#db
      .prepare(
        `SELECT 1 AS found FROM local_device_outbox
          WHERE source_instance_id = ?
            AND rowid < ?
            AND status != 'succeeded'
            AND kind IN (${input.kinds.map(() => "?").join(", ")})
          LIMIT 1`
      )
      .get(input.sourceInstanceId, input.beforeInsertOrder, ...input.kinds);
    return Boolean(row);
  }

  countOpenGaps(input: { sourceInstanceId: string }): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total FROM local_device_outbox
          WHERE source_instance_id = ?
            AND kind = 'gap'
            AND status IN ('ready', 'leased')`
      )
      .get(input.sourceInstanceId);
    return isRecord(row) ? numberFrom(row.total) : 0;
  }

  listByKind(input: {
    kind: LocalDeviceOutboxKind;
    sourceInstanceId: string;
    statuses?: readonly LocalDeviceOutboxStatus[];
  }): LocalDeviceOutboxItem[] {
    const clauses = ["source_instance_id = ?", "kind = ?"];
    const params: string[] = [input.sourceInstanceId, input.kind];
    if (input.statuses && input.statuses.length > 0) {
      clauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
      params.push(...input.statuses);
    }
    const rows = this.#db
      .prepare(
        `SELECT *, rowid AS insert_order FROM local_device_outbox
          WHERE ${clauses.join(" AND ")}
          ORDER BY insert_order`
      )
      .all(...params);
    return rows.map((row) => rowToItem(row));
  }

  maxRecordBatchSeq(input: { sourceInstanceId: string }): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(CAST(json_extract(payload_json, '$.batchSeq') AS INTEGER)), 0) AS max_seq
          FROM local_device_outbox
          WHERE source_instance_id = ?
            AND kind = 'record_batch'`
      )
      .get(input.sourceInstanceId);
    return isRecord(row) ? numberFrom(row.max_seq) : 0;
  }

  list(input: { sourceInstanceId?: string } = {}): LocalDeviceOutboxItem[] {
    const rows = input.sourceInstanceId
      ? this.#db
          .prepare(
            `SELECT *, rowid AS insert_order FROM local_device_outbox
              WHERE source_instance_id = ?
              ORDER BY source_instance_id, insert_order`
          )
          .all(input.sourceInstanceId)
      : this.#db
          .prepare(
            `SELECT *, rowid AS insert_order FROM local_device_outbox
              ORDER BY source_instance_id, insert_order`
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

  /**
   * Whether this lane has ever carried a record on the named stream.
   *
   * Local-device collectors push records from this durable outbox and write
   * no spine run, so the connection-health rollup can only project a
   * non-`unknown` coverage axis from durable `coverage_diagnostics` records.
   * A drained lane that has carried real records but never a coverage record
   * is the exact local shape behind the dashboard's stuck `coverage_unknown`
   * (see `openspec/changes/derive-local-collector-coverage-from-diagnostics`).
   *
   * Detection scans `record_batch` payloads with `json_each` over
   * `$.records[*].stream` and reads only the stream name — never record
   * bodies, paths, or tokens. Succeeded record_batch rows are retained (only
   * gap rows are deleted on recovery), so the signal survives a clean drain.
   * Dead-letter rows are excluded: a stream that only ever dead-lettered was
   * never durably observed by the lane.
   */
  hasObservedStream(input: { sourceInstanceId: string; stream: string }): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 AS found
           FROM local_device_outbox AS o,
                json_each(o.payload_json, '$.records') AS rec
          WHERE o.source_instance_id = ?
            AND o.kind = 'record_batch'
            AND o.status != 'dead_letter'
            AND json_extract(rec.value, '$.stream') = ?
          LIMIT 1`
      )
      .get(input.sourceInstanceId, input.stream);
    return Boolean(row);
  }

  /**
   * Count of non-dead-letter `record_batch` rows for a source instance.
   *
   * Lets the status/doctor surface distinguish an empty/never-run lane
   * (zero record batches — coverage absence is simply "nothing collected
   * yet") from a lane that has carried records but no coverage diagnostic
   * (coverage genuinely missing). Reads only the indexed status/kind
   * columns; never materializes payloads.
   */
  countRecordBatches(input: { sourceInstanceId: string }): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total
           FROM local_device_outbox
          WHERE source_instance_id = ?
            AND kind = 'record_batch'
            AND status != 'dead_letter'`
      )
      .get(input.sourceInstanceId);
    return isRecord(row) ? numberFrom(row.total) : 0;
  }

  /**
   * Aggregate the top redacted dead-letter error classes.
   *
   * Reads only the indexed `status` filter plus the `last_error` text column
   * — never `payload_json`. Each `last_error` is collapsed to a stable class
   * (see {@link classifyDeadLetterError}) so 3,420 identical
   * `400 invalid_request` rejections report as one class with `count: 3420`
   * rather than 3,420 opaque rows. This is what lets `doctor` and the device
   * heartbeat answer "why did these dead-letter?" without the operator
   * opening the SQLite file by hand.
   *
   * Output is redaction-safe at this boundary, and the reference server
   * re-sanitizes it again before persistence.
   */
  deadLetterErrorSummary(
    input: LocalDeviceOutboxDeadLetterErrorSummaryInput = {}
  ): LocalDeviceOutboxDeadLetterErrorSummary {
    const limit = input.limit && input.limit > 0 ? input.limit : 5;
    const rows = input.sourceInstanceId
      ? this.#db
          .prepare(
            `SELECT last_error AS last_error, COUNT(*) AS total
               FROM local_device_outbox
              WHERE status = 'dead_letter' AND source_instance_id = ?
              GROUP BY last_error`
          )
          .all(input.sourceInstanceId)
      : this.#db
          .prepare(
            `SELECT last_error AS last_error, COUNT(*) AS total
               FROM local_device_outbox
              WHERE status = 'dead_letter'
              GROUP BY last_error`
          )
          .all();

    const classCounts = new Map<string, number>();
    let deadLetterCount = 0;
    let nullErrorCount = 0;
    for (const rowLike of rows) {
      if (!isRecord(rowLike)) {
        continue;
      }
      const total = numberFrom(rowLike.total);
      deadLetterCount += total;
      const raw = rowLike.last_error;
      if (typeof raw !== "string" || raw.trim() === "") {
        nullErrorCount += total;
        continue;
      }
      const errorClass = classifyDeadLetterError(raw);
      classCounts.set(errorClass, (classCounts.get(errorClass) ?? 0) + total);
    }

    const top_classes = [...classCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([error_class, count]) => ({ count, error_class }));

    return {
      dead_letter_count: deadLetterCount,
      null_error_count: nullErrorCount,
      top_classes,
    };
  }

  #countWhere(clauses: readonly string[], params: readonly string[], limit: number | null): number {
    if (limit == null) {
      const row = this.#db
        .prepare(`SELECT COUNT(*) AS total FROM local_device_outbox WHERE ${clauses.join(" AND ")}`)
        .get(...params);
      return isRecord(row) ? numberFrom(row.total) : 0;
    }
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total
           FROM (
             SELECT 1
               FROM local_device_outbox
              WHERE ${clauses.join(" AND ")}
              ORDER BY rowid
              LIMIT ?
           )`
      )
      .get(...params, limit);
    return isRecord(row) ? numberFrom(row.total) : 0;
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

  #selectReady(
    sourceInstanceId: string | undefined,
    now: string,
    limit: number,
    excludeKinds: readonly LocalDeviceOutboxKind[] = []
  ): LocalDeviceOutboxRow[] {
    const kindClause = excludeKinds.length > 0 ? `AND kind NOT IN (${excludeKinds.map(() => "?").join(", ")})` : "";
    if (sourceInstanceId) {
      return this.#db
        .prepare(
          `SELECT *, rowid AS insert_order FROM local_device_outbox
            WHERE status = 'ready'
              AND source_instance_id = ?
              AND next_attempt_at <= ?
              ${kindClause}
            ORDER BY insert_order
            LIMIT ?`
        )
        .all(sourceInstanceId, now, ...excludeKinds, limit)
        .map(asOutboxRow);
    }
    return this.#db
      .prepare(
        `SELECT *, rowid AS insert_order FROM local_device_outbox
          WHERE status = 'ready'
            AND next_attempt_at <= ?
            ${kindClause}
          ORDER BY source_instance_id, insert_order
          LIMIT ?`
      )
      .all(now, ...excludeKinds, limit)
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
    insert_order: row.insert_order,
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

function deadLetterWhere(input: LocalDeviceOutboxRequeueDeadLettersInput): { clauses: string[]; params: string[] } {
  const clauses = ["status = 'dead_letter'"];
  const params: string[] = [];
  if (input.sourceInstanceId) {
    clauses.push("source_instance_id = ?");
    params.push(input.sourceInstanceId);
  }
  if (input.kind) {
    clauses.push("kind = ?");
    params.push(input.kind);
  }
  return { clauses, params };
}

function normalizeLimit(value: number | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("dead-letter requeue limit must be a positive safe integer");
  }
  return value;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const DEAD_LETTER_SECRET_RE =
  /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b\s*[:=]\s*\S+/gi;
const DEAD_LETTER_OTP_RE = /\b\d{6}\b/g;
const DEAD_LETTER_LONG_OPAQUE_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const DEAD_LETTER_PATH_RE = /(?:\/home|\/Users|\/root)\/[^\s"',)]+|[A-Za-z]:\\Users\\[^\s"',)]+/g;
const DEAD_LETTER_URL_RE = /https?:\/\/[^\s"',)]+/gi;
const DEAD_LETTER_HEX_ID_RE = /\b[0-9a-f]{8,}\b/gi;
const DEAD_LETTER_NUMBER_RE = /\b\d{4,}\b/g;
const DEAD_LETTER_MAX_LENGTH = 160;

/**
 * Collapse a raw `last_error` string into a stable, redaction-safe class.
 *
 * The goal is grouping, not preservation: HTTP status codes and the error
 * shape stay so `400 invalid_request` reads clearly, while host paths,
 * credential markers, OTP-shaped digits, opaque tokens, URLs, and long
 * volatile ids/sequence numbers are scrubbed so structurally identical
 * failures map to one class. First line only; never the payload body.
 */
export function classifyDeadLetterError(raw: string): string {
  let s = raw.split("\n", 1)[0] ?? "";
  s = s.replace(DEAD_LETTER_PATH_RE, "[PATH]");
  s = s.replace(DEAD_LETTER_URL_RE, "[URL]");
  s = s.replace(DEAD_LETTER_SECRET_RE, (_match, marker: string) => `${marker}=[REDACTED]`);
  s = s.replace(DEAD_LETTER_OTP_RE, "[REDACTED_OTP]");
  s = s.replace(DEAD_LETTER_LONG_OPAQUE_RE, "[REDACTED]");
  s = s.replace(DEAD_LETTER_HEX_ID_RE, "[ID]");
  s = s.replace(DEAD_LETTER_NUMBER_RE, "[N]");
  s = s.replace(/\s+/g, " ").trim();
  if (s === "") {
    return "(unclassified)";
  }
  return s.length > DEAD_LETTER_MAX_LENGTH ? `${s.slice(0, DEAD_LETTER_MAX_LENGTH - 1)}…` : s;
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
    (typeof row.insert_order !== "number" && typeof row.insert_order !== "bigint") ||
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
    insert_order: numberFrom(row.insert_order),
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
