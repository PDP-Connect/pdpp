// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector-summary evidence reconciliation primitive.
 *
 * Replaces the dirty-only reconcile in `connector-summary-read-model.ts`
 * with the one scope-safe primitive design.md requires: batched, fixed-query
 * discovery over the complete or scoped canonical `connector_instances` set,
 * classifying each row against canonical authorities (never against the
 * evidence row's own stale claim about itself), followed by writer-fenced
 * repair for exactly the K rows that need it.
 *
 * Authorities (design.md "Authorities"):
 *   - `connector_instances`: lifecycle/identity, and the requested set.
 *   - the reset-safe `record_source_checkpoint`: whether stored record facts
 *     match the current record namespace.
 *   - canonical `records WHERE deleted = false`: current per-stream counts
 *     and record recency.
 *   - terminal spine events by `event_seq`: per-stream latest-attempt facts.
 *   - the parsed current stored connector manifest: declaration/requiredness.
 *   - clean `retained_size_*` rows: retained byte/history/blob measures ONLY
 *     — never counts or coverage.
 *
 * `connector_summary_evidence` is never an authority; it is a disposable,
 * idempotently repairable cache of facts from those sources.
 *
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */

import { writeTransaction } from "../lib/db.ts";
import { withConnectorInstanceWrite } from "./connector-instance-write-coordinator.ts";
import { getDb } from "./db.js";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.js";
import {
  normalizeRecordSourceCheckpoint,
  type RecordSourceCheckpoint,
  recordSourceCheckpointsEqual,
} from "./record-source-checkpoint.ts";

// biome-ignore lint/suspicious/noExplicitAny: the db.js/pg boundary is untyped.
type Db = any;
type Row = Record<string, unknown>;

/**
 * Test-only synchronous delay between `repairCandidateSqlite`'s read phase
 * and its write phase, still INSIDE the `writeTransaction` (BEGIN IMMEDIATE)
 * body. Exists solely to make a genuine two-process interleaving window
 * deterministically reproducible in tests: without it, a second process's
 * own `BEGIN IMMEDIATE` could race to acquire the write lock before or after
 * the first process's transaction depending on unpredictable OS scheduling,
 * making a lock-ordering assertion flaky. With the delay held, the SECOND
 * process's `BEGIN IMMEDIATE` is forced to block on SQLite's write lock for
 * the delay's duration, proving the lock — not scheduling luck — is what
 * serializes the two read-then-write units.
 *
 * A complete no-op unless `PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS` is set
 * to a positive integer (never set in production). Better-sqlite3
 * transactions must be synchronous, so this uses `Atomics.wait` on a
 * throwaway `SharedArrayBuffer` for a genuine blocking sleep — no `await` is
 * possible inside a `db.transaction(fn)` body.
 */
function testOnlyRepairCandidateSqliteDelay(): void {
  const raw = process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS;
  const ms = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export type ComponentState = "current" | "unobserved" | "stale" | "failed";
export type ManifestState = "current" | "unavailable" | "failed";
export type DeclarationState = "declared" | "dormant" | "unexpected" | "unavailable";
export type CountState = "known" | "known_zero" | "unobserved" | "stale" | "unknown";

export type RepairCandidateReason =
  | "missing"
  | "dirty"
  | "record_checkpoint_mismatch"
  | "identity_mismatch"
  | "manifest_mismatch"
  | "terminal_checkpoint_lag"
  | "retained_bytes_changed_or_unavailable";

export interface StreamEvidence {
  readonly count_state: CountState;
  readonly declaration_state: DeclarationState;
  readonly record_count: number | null;
  readonly retained_record_count: number | null;
  readonly stream: string;
}

export interface EvidenceComponent<S extends string> {
  readonly as_of: string | null;
  readonly reason_code: string | null;
  readonly state: S;
}

export interface ConnectorSummaryEvidenceRow {
  readonly computed_at: string | null;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly dirty: boolean;
  readonly display_name: string;
  readonly last_error: string | null;
  readonly last_record_updated_at: string | null;
  readonly manifest_declaration: EvidenceComponent<ManifestState>;
  readonly manifest_generation?: number;
  readonly record_snapshot: EvidenceComponent<ComponentState>;
  readonly retained_bytes: Row | null;
  /**
   * The retained-bytes evidence component (design.md "Orthogonal projection
   * evidence"): `current | unobserved | stale | failed`, independent of the
   * `retained_bytes` byte-VALUE field above — this is the typed envelope
   * (state/as_of/reason_code), that field is the nullable payload itself.
   * Does NOT feed `evidenceUnreliableSources`/`ProjectionReliable` (design.md
   * "Health boundary": retained-byte failure makes bytes unavailable but
   * does not by itself degrade connection health).
   */
  readonly retained_bytes_evidence: EvidenceComponent<ComponentState>;
  readonly revoked_at: string | null;
  readonly source_event_seq: number | null;
  readonly source_kind: string | null;
  readonly state: string;
  readonly status: string | null;
  readonly stream_count: number;
  readonly stream_facts_event_seq: number | null;
  readonly stream_latest_facts: unknown;
  readonly stream_records: readonly StreamEvidence[];
  readonly terminal_facts: EvidenceComponent<ComponentState>;
  readonly total_records: number;
  readonly total_retained_bytes: number;
}

const REASON_CODES = {
  MISSING: "summary_missing",
  RECORD_CHECKPOINT_LAG: "record_checkpoint_lag",
  LOCK_UNAVAILABLE: "repair_lock_unavailable",
  RECORD_SNAPSHOT_FAILED: "record_snapshot_failed",
  TERMINAL_FOLD_FAILED: "terminal_fold_failed",
  MANIFEST_UNAVAILABLE: "manifest_unavailable",
  MANIFEST_INVALID: "manifest_invalid",
  RETAINED_BYTES_UNAVAILABLE: "retained_bytes_unavailable",
  MANIFEST_GENERATION_CHANGED: "manifest_generation_changed",
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeProjectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "object") {
    return value as T;
  }
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Manifest declaration (safe, diagnostic-only — never throws)
// ---------------------------------------------------------------------------

interface ManifestDeclaration {
  readonly fingerprint: string | null;
  readonly ok: boolean;
  readonly streams: readonly string[];
}

/**
 * Parse a connector's raw manifest text into its declared stream-name set
 * and a normalized fingerprint, WITHOUT throwing. A malformed/non-object
 * manifest, or one with a missing/empty streams array, yields `ok: false` —
 * the caller reports `manifest_declaration: unavailable`, never a thrown
 * error. This is intentionally lighter than `validateConnectorManifest`
 * (which enforces the full authoring contract and throws): this reader only
 * answers "what streams does the CURRENT stored manifest declare", the one
 * fact this reconciliation primitive needs.
 */
function parseManifestDeclaration(raw: unknown): ManifestDeclaration {
  if (typeof raw !== "string" || !raw) {
    return { ok: false, streams: [], fingerprint: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, streams: [], fingerprint: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, streams: [], fingerprint: null };
  }
  const streamsRaw = (parsed as Row).streams;
  if (!Array.isArray(streamsRaw) || streamsRaw.length === 0) {
    return { ok: false, streams: [], fingerprint: null };
  }
  const streams = streamsRaw
    .map((entry) => (entry && typeof entry === "object" ? (entry as Row).name : null))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (streams.length === 0) {
    return { ok: false, streams: [], fingerprint: null };
  }
  const sorted = [...new Set(streams)].sort();
  return { ok: true, streams: sorted, fingerprint: sorted.join("") };
}

// ---------------------------------------------------------------------------
// Batched, fixed-query discovery
// ---------------------------------------------------------------------------

interface DiscoveryInput {
  readonly canonicalTotalRecords: number;
  readonly currentCheckpoint: RecordSourceCheckpoint;
  readonly existingEvidence: Row | null;
  readonly instance: Row;
  readonly manifest: ManifestDeclaration;
  readonly maxTerminalEventSeq: number | null;
  readonly retainedByteRow: Row | null;
}

/**
 * Classify one connection against canonical authorities. Returns the exact
 * repair reason (highest-precedence first) or `null` when the row is
 * `current` and needs no repair. Never reads the evidence row's own claim
 * about its state — only whether its stored facts still match the
 * authorities.
 */
function classifyCandidate(input: DiscoveryInput): RepairCandidateReason | null {
  const { instance, existingEvidence, manifest, currentCheckpoint, retainedByteRow } = input;

  if (!existingEvidence) {
    return "missing";
  }
  if (Number(existingEvidence.dirty || 0) !== 0) {
    return "dirty";
  }
  if (
    existingEvidence.display_name !== instance.display_name ||
    existingEvidence.status !== instance.status ||
    existingEvidence.source_kind !== instance.source_kind ||
    (existingEvidence.revoked_at || null) !== (instance.revoked_at || null)
  ) {
    return "identity_mismatch";
  }
  const storedCheckpoint = parseJsonColumn<RecordSourceCheckpoint | null>(
    existingEvidence.record_checkpoint_json,
    null
  );
  if (!(storedCheckpoint && recordSourceCheckpointsEqual(storedCheckpoint, currentCheckpoint))) {
    return "record_checkpoint_mismatch";
  }
  // Supplementary to the composite checkpoint: a canonical total-record
  // count drift with no corresponding checkpoint change means a direct
  // writer mutated `records` without going through the normal version-
  // allocating ingest/reset paths. Still a real change the stored snapshot
  // must absorb.
  if (Number(existingEvidence.total_records || 0) !== input.canonicalTotalRecords) {
    return "record_checkpoint_mismatch";
  }
  const storedFingerprint =
    existingEvidence.manifest_fingerprint == null ? null : String(existingEvidence.manifest_fingerprint);
  const currentFingerprint = manifest.ok ? manifest.fingerprint : null;
  if (storedFingerprint !== currentFingerprint) {
    return "manifest_mismatch";
  }
  if (Number(existingEvidence.manifest_generation ?? 0) !== Number(instance.manifest_generation ?? 0)) {
    return "manifest_mismatch";
  }
  const storedTerminalSeq =
    existingEvidence.stream_facts_event_seq == null ? null : Number(existingEvidence.stream_facts_event_seq);
  if (
    input.maxTerminalEventSeq != null &&
    (storedTerminalSeq == null || storedTerminalSeq < input.maxTerminalEventSeq)
  ) {
    return "terminal_checkpoint_lag";
  }
  if (retainedBytesNeedsRepair(existingEvidence, retainedByteRow)) {
    return "retained_bytes_changed_or_unavailable";
  }
  return null;
}

/**
 * Whether the retained-bytes EVIDENCE component is out of sync with the
 * retained-bytes SOURCE (`retained_size_connection`), in either direction —
 * not just the narrow "dirty flag says changed, evidence says current" case.
 * The `dirty` boolean on the source row is a latency hint (same contract as
 * every other dirty marker in this codebase), not the correctness backstop;
 * this compares the STORED evidence values against what the source would
 * currently produce, mirroring how `record_checkpoint_mismatch` never trusts
 * `existingEvidence`'s own claim about itself either.
 *
 * Three cases converge:
 *   - missing/stale evidence but a clean source row now exists ("missing→
 *     clean convergence" — the bug this closes: a `dirty` flag that never
 *     fires again after the evidence was stamped `stale` can no longer hide
 *     a clean row that has since appeared);
 *   - clean, current evidence but the source row is now gone/dirty
 *     (the reverse transition — matches the original `dirty && current`
 *     case, generalized); and
 *   - both clean/current, but the persisted byte/record values differ from
 *     what the source row holds right now ("clean-value-changed
 *     convergence" — covers a `dirty` flag that was cleared or never set by
 *     whatever wrote the new values).
 *
 * This does NOT cause infinite repair churn: once repaired, `buildRepairedRow`
 * persists a `retained_bytes_json`/`retained_bytes_state` that exactly
 * mirrors what this function reads from the source, so the comparison goes
 * false on the very next pass — the same "candidate until genuinely
 * repaired, then stable" shape `missing`/`identity_mismatch`/
 * `manifest_mismatch` already rely on above.
 */
function retainedBytesNeedsRepair(existingEvidence: Row, retainedByteRow: Row | null): boolean {
  const storedRetainedState = existingEvidence.retained_bytes_state;
  const sourceClean = retainedByteRow ? Number(retainedByteRow.dirty || 0) === 0 : false;

  if (!sourceClean) {
    // Source is missing or dirty: evidence should read non-current
    // (`stale`/`failed`/`unobserved`). If it currently claims `current`,
    // that claim is now stale and must be repaired away — the original
    // `dirty && current` case, generalized to also cover a row that was
    // never observed at all.
    return storedRetainedState === "current";
  }

  // Source is clean. If the evidence does not already claim `current`, this
  // is the missing→clean convergence case: a clean row exists now but the
  // evidence has never absorbed it (e.g. it was stamped `stale` before any
  // retained row existed, and the `dirty` flag flipping false afterward gave
  // the old check nothing left to trigger on).
  if (storedRetainedState !== "current") {
    return true;
  }

  // Both sides claim clean/current: only a candidate if the actual
  // persisted values differ from what the source currently holds — the
  // clean-value-changed case, independent of whatever the `dirty` flag says.
  const storedRetainedBytes = parseJsonColumn<Row | null>(existingEvidence.retained_bytes_json, null);
  const sourceTotalBytes =
    Number(retainedByteRow?.current_record_json_bytes || 0) +
    Number(retainedByteRow?.record_history_json_bytes || 0) +
    Number(retainedByteRow?.blob_bytes || 0);
  if (!storedRetainedBytes) {
    return true;
  }
  return (
    Number(storedRetainedBytes.record_json_bytes || 0) !== Number(retainedByteRow?.current_record_json_bytes || 0) ||
    Number(storedRetainedBytes.record_changes_json_bytes || 0) !==
      Number(retainedByteRow?.record_history_json_bytes || 0) ||
    Number(storedRetainedBytes.blob_bytes || 0) !== Number(retainedByteRow?.blob_bytes || 0) ||
    Number(storedRetainedBytes.total_bytes || 0) !== sourceTotalBytes
  );
}

// ---------------------------------------------------------------------------
// Backend-dispatched batched reads (fixed query count regardless of N)
// ---------------------------------------------------------------------------

/**
 * Batched `IN (...)` placeholder clause for a fixed-size id array, matching
 * the existing idiom in `lib/spine.ts`'s `attachClientMetadata`
 * (`clientIds.map(() => "?").join(", ")`) — reused here rather than
 * invented, so the same one query-per-K (not one query-per-id) shape backs
 * every scoped table read below.
 */
function sqlitePlaceholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(", ");
}

function readSqliteDiscoveryContext(connectorInstanceIds: readonly string[] | null) {
  const db: Db = getDb();
  // `null` = complete census (unscoped). A non-null, EMPTY array is a
  // genuine "scoped to nothing" request — unlike Postgres's
  // `= ANY($1::text[])`, SQLite's `IN (...)` has no zero-placeholder form,
  // so this short-circuits to empty results rather than either producing
  // invalid SQL or silently falling back to the complete census (which
  // would be a correctness surprise: scoping to zero ids must mean zero
  // rows, never "reconcile everything").
  if (connectorInstanceIds != null && connectorInstanceIds.length === 0) {
    return {
      instanceRows: [] as Row[],
      evidenceByInstance: new Map<string, Row>(),
      manifestByConnector: new Map<string, string>(),
      retainedByteByInstance: new Map<string, Row>(),
      versionCountersByInstance: new Map<string, Row[]>(),
      canonicalTotalRecordsByInstance: new Map<string, number>(),
      maxTerminalEventSeq: null,
    };
  }
  const scoped = connectorInstanceIds != null;
  // REVIEWED-DYNAMIC: IN-list cardinality is bounded by the caller's own
  // requested scope (a route resolves at most one connection today; a
  // future bulk caller would still bind the same count of `?` placeholders
  // it requests), and every value is a bound parameter — never
  // string-interpolated into the SQL text.
  const placeholders = scoped ? sqlitePlaceholders(connectorInstanceIds!) : "";
  // Unscoped discovery reads the COMPLETE canonical connector_instances set
  // — every subject, not just REFERENCE_OWNER_SUBJECT_ID. A prior
  // owner_subject_id filter here created a genuine cross-subject
  // destructive-interference bug (Sol P1.3): the evidence reads/prunes
  // below are correctly unfiltered by subject, so a distinct subject's
  // (e.g. a client-grant-materialized connection's) evidence row would be
  // read into the "live" evidence set but its OWN connector_instances row
  // would never appear in `instanceRows`, making `pruneOrphanedEvidenceComplete`
  // treat it as orphaned and delete it — even though the connection still
  // genuinely exists. "Complete" means complete across every subject,
  // consistent with the scoped path (no subject filter at all) and with
  // every other read/prune below.
  const instanceRows = scoped
    ? db
        .prepare(`SELECT * FROM connector_instances WHERE connector_instance_id IN (${placeholders})`)
        .all(...connectorInstanceIds!)
    : db.prepare("SELECT * FROM connector_instances ORDER BY connector_instance_id ASC").all();
  // Evidence/retained-bytes/version-counter/canonical-count reads are scoped
  // to the SAME requested id set (one batched query each, not a complete
  // table scan) when the caller narrowed the discovery — a scoped consumer
  // must not pay for every OTHER connection's rows, and must never even
  // read (let alone repair) a sibling connection's evidence row.
  const evidenceRows: Row[] = scoped
    ? db
        .prepare(`SELECT * FROM connector_summary_evidence WHERE connector_instance_id IN (${placeholders})`)
        .all(...connectorInstanceIds!)
    : db.prepare("SELECT * FROM connector_summary_evidence").all();
  const evidenceByInstance = new Map(evidenceRows.map((row) => [String(row.connector_instance_id), row]));
  const connectorRows: Row[] = db.prepare("SELECT connector_id, manifest FROM connectors").all();
  const manifestByConnector = new Map(connectorRows.map((row) => [String(row.connector_id), String(row.manifest)]));
  const retainedByteRows: Row[] = scoped
    ? db
        .prepare(`SELECT * FROM retained_size_connection WHERE connector_instance_id IN (${placeholders})`)
        .all(...connectorInstanceIds!)
    : db.prepare("SELECT * FROM retained_size_connection").all();
  const retainedByteByInstance = new Map(retainedByteRows.map((row) => [String(row.connector_instance_id), row]));
  const versionCounterRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT connector_instance_id, stream, CAST(max_version AS TEXT) AS max_version FROM version_counter
            WHERE connector_instance_id IN (${placeholders})`
        )
        .all(...connectorInstanceIds!)
    : db
        .prepare("SELECT connector_instance_id, stream, CAST(max_version AS TEXT) AS max_version FROM version_counter")
        .all();
  const versionCountersByInstance = new Map<string, Row[]>();
  for (const row of versionCounterRows) {
    const instanceId = String(row.connector_instance_id);
    const list = versionCountersByInstance.get(instanceId) ?? [];
    list.push(row);
    versionCountersByInstance.set(instanceId, list);
  }
  // Cheap canonical-count supplement to the composite checkpoint: a direct
  // writer that mutates `records` without allocating a version (bypassing
  // the normal ingest/reset paths that advance version_counter or
  // record_reset_generation) still changes the live count, and this catches
  // it. One fixed aggregate query regardless of N (or of K, when scoped).
  const canonicalCountRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT connector_instance_id, COUNT(*) AS total_records FROM records
            WHERE deleted = 0 AND connector_instance_id IN (${placeholders})
            GROUP BY connector_instance_id`
        )
        .all(...connectorInstanceIds!)
    : db
        .prepare(
          "SELECT connector_instance_id, COUNT(*) AS total_records FROM records WHERE deleted = 0 GROUP BY connector_instance_id"
        )
        .all();
  const canonicalTotalRecordsByInstance = new Map(
    canonicalCountRows.map((row) => [String(row.connector_instance_id), Number(row.total_records || 0)])
  );
  const maxTerminalSeqRow = db
    .prepare(
      `SELECT MAX(event_seq) AS max_seq FROM spine_events
        WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`
    )
    .get() as Row | undefined;
  return {
    instanceRows: instanceRows as Row[],
    evidenceByInstance,
    manifestByConnector,
    retainedByteByInstance,
    versionCountersByInstance,
    canonicalTotalRecordsByInstance,
    maxTerminalEventSeq: maxTerminalSeqRow?.max_seq == null ? null : Number(maxTerminalSeqRow.max_seq),
  };
}

async function readPostgresDiscoveryContext(connectorInstanceIds: readonly string[] | null) {
  // `null` = complete census (unscoped). A non-null, EMPTY array is a
  // genuine "scoped to nothing" request; short-circuit rather than issue
  // `= ANY($1::text[])` with an empty bind array (which IS valid Postgres
  // and correctly matches zero rows for `instanceResult`, but the same
  // short-circuit as SQLite keeps both backends' empty-scope behavior
  // identical and avoids six no-op round-trips).
  if (connectorInstanceIds != null && connectorInstanceIds.length === 0) {
    return {
      instanceRows: [] as Row[],
      evidenceByInstance: new Map<string, Row>(),
      manifestByConnector: new Map<string, string>(),
      retainedByteByInstance: new Map<string, Row>(),
      versionCountersByInstance: new Map<string, Row[]>(),
      canonicalTotalRecordsByInstance: new Map<string, number>(),
      maxTerminalEventSeq: null,
    };
  }
  const scoped = connectorInstanceIds != null;
  // See the SQLite branch's identical comment (Sol P1.3): unscoped
  // discovery reads the COMPLETE canonical connector_instances set across
  // every subject, matching the unfiltered evidence reads/prunes below —
  // an owner_subject_id filter here would let a distinct subject's
  // genuinely-live connection be pruned as orphaned.
  const instanceResult = scoped
    ? await postgresQuery("SELECT * FROM connector_instances WHERE connector_instance_id = ANY($1::text[])", [
        connectorInstanceIds,
      ])
    : await postgresQuery("SELECT * FROM connector_instances ORDER BY connector_instance_id ASC");
  // Evidence/retained-bytes/version-counter/canonical-count reads are scoped
  // to the SAME requested id set (one batched `ANY($1::text[])` query each,
  // not a complete table scan) when the caller narrowed the discovery —
  // matches the SQLite `IN (...)` batching above; a scoped consumer must
  // not pay for, or even read, every other connection's rows.
  const evidenceResult = scoped
    ? await postgresQuery("SELECT * FROM connector_summary_evidence WHERE connector_instance_id = ANY($1::text[])", [
        connectorInstanceIds,
      ])
    : await postgresQuery("SELECT * FROM connector_summary_evidence");
  const evidenceByInstance = new Map(
    (evidenceResult.rows as Row[]).map((row) => [String(row.connector_instance_id), row])
  );
  const connectorResult = await postgresQuery("SELECT connector_id, manifest::text AS manifest FROM connectors");
  const manifestByConnector = new Map(
    (connectorResult.rows as Row[]).map((row) => [String(row.connector_id), String(row.manifest)])
  );
  const retainedByteResult = scoped
    ? await postgresQuery("SELECT * FROM retained_size_connection WHERE connector_instance_id = ANY($1::text[])", [
        connectorInstanceIds,
      ])
    : await postgresQuery("SELECT * FROM retained_size_connection");
  const retainedByteByInstance = new Map(
    (retainedByteResult.rows as Row[]).map((row) => [String(row.connector_instance_id), row])
  );
  const versionCounterResult = scoped
    ? await postgresQuery(
        "SELECT connector_instance_id, stream, max_version::text AS max_version FROM version_counter WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds]
      )
    : await postgresQuery(
        "SELECT connector_instance_id, stream, max_version::text AS max_version FROM version_counter"
      );
  const versionCountersByInstance = new Map<string, Row[]>();
  for (const row of versionCounterResult.rows as Row[]) {
    const instanceId = String(row.connector_instance_id);
    const list = versionCountersByInstance.get(instanceId) ?? [];
    list.push(row);
    versionCountersByInstance.set(instanceId, list);
  }
  // Cheap canonical-count supplement to the composite checkpoint: a direct
  // writer that mutates `records` without allocating a version still
  // changes the live count, and this catches it. One fixed aggregate query
  // regardless of N (or of K, when scoped).
  const canonicalCountResult = scoped
    ? await postgresQuery(
        `SELECT connector_instance_id, COUNT(*)::int AS total_records FROM records
          WHERE deleted = FALSE AND connector_instance_id = ANY($1::text[])
          GROUP BY connector_instance_id`,
        [connectorInstanceIds]
      )
    : await postgresQuery(
        "SELECT connector_instance_id, COUNT(*)::int AS total_records FROM records WHERE deleted = FALSE GROUP BY connector_instance_id"
      );
  const canonicalTotalRecordsByInstance = new Map(
    (canonicalCountResult.rows as Row[]).map((row) => [
      String(row.connector_instance_id),
      Number(row.total_records || 0),
    ])
  );
  const maxTerminalSeqResult = await postgresQuery(
    `SELECT MAX(event_seq) AS max_seq FROM spine_events
      WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`
  );
  const maxSeq = (maxTerminalSeqResult.rows[0] as Row | undefined)?.max_seq;
  return {
    instanceRows: instanceResult.rows as Row[],
    evidenceByInstance,
    manifestByConnector,
    retainedByteByInstance,
    versionCountersByInstance,
    canonicalTotalRecordsByInstance,
    maxTerminalEventSeq: maxSeq == null ? null : Number(maxSeq),
  };
}

/**
 * Batched discovery: reads the complete (or scoped) canonical set with a
 * FIXED number of queries regardless of N connections, and classifies each
 * row. Never acquires a per-connection lock. Discovery-only — no repair, no
 * write.
 */
async function discoverCandidates(
  connectorInstanceIds: readonly string[] | null
): Promise<{ instanceRows: readonly Row[]; candidates: ReadonlyMap<string, RepairCandidateReason> }> {
  const ctx = isPostgresStorageBackend()
    ? await readPostgresDiscoveryContext(connectorInstanceIds)
    : readSqliteDiscoveryContext(connectorInstanceIds);

  const candidates = new Map<string, RepairCandidateReason>();
  for (const instance of ctx.instanceRows) {
    const instanceId = String(instance.connector_instance_id);
    const existingEvidence = ctx.evidenceByInstance.get(instanceId) ?? null;
    const manifestRaw = ctx.manifestByConnector.get(String(instance.connector_id));
    const manifest = parseManifestDeclaration(manifestRaw);
    const currentCheckpoint = normalizeRecordSourceCheckpoint({
      resetGeneration: String(instance.record_reset_generation ?? "0"),
      streams: (ctx.versionCountersByInstance.get(instanceId) ?? []).map((row) => ({
        stream: String(row.stream),
        maxVersion: String(row.max_version),
      })),
    });
    const reason = classifyCandidate({
      instance,
      existingEvidence,
      manifest,
      currentCheckpoint,
      retainedByteRow: ctx.retainedByteByInstance.get(instanceId) ?? null,
      maxTerminalEventSeq: ctx.maxTerminalEventSeq,
      canonicalTotalRecords: ctx.canonicalTotalRecordsByInstance.get(instanceId) ?? 0,
    });
    if (reason) {
      candidates.set(instanceId, reason);
    }
  }
  return { instanceRows: ctx.instanceRows, candidates };
}

// ---------------------------------------------------------------------------
// Fenced repair — exactly the candidates, re-read + upsert in one transaction
// ---------------------------------------------------------------------------

interface RepairedEvidence {
  readonly failed: boolean;
  /**
   * Whether a `failed: true` row's durable write actually landed. `true`
   * for every non-failed repair (the success-path upsert either lands or
   * throws, caught by the outer failure branch). `false` only when a
   * failure ALSO could not be durably persisted — the caller must carry
   * `row` through in memory rather than trusting a subsequent read of
   * durable storage to reflect it (closes Sol P1.1).
   */
  readonly persisted: boolean;
  readonly row: Row;
}

/**
 * Repair exactly one connection's evidence row under the shared
 * connector-instance writer fence: re-read canonical facts fresh (not the
 * pre-lock discovery snapshot) and upsert. On lock/read/write failure,
 * returns row-shaped `stale`/`failed` evidence with a closed sanitized
 * reason code — never a fabricated clean row.
 */
async function repairCandidate(connectorInstanceId: string): Promise<RepairedEvidence> {
  try {
    return await withConnectorInstanceWrite(connectorInstanceId, async () => {
      if (isPostgresStorageBackend()) {
        return repairCandidatePostgres(connectorInstanceId);
      }
      return repairCandidateSqlite(connectorInstanceId);
    });
  } catch (err) {
    const failedRow = buildFailedRow(connectorInstanceId, REASON_CODES.LOCK_UNAVAILABLE, err);
    // The lock itself could not be acquired, so nothing about this
    // connection's canonical facts was even re-read this attempt — total
    // failure, every component fails closed (see `buildFailedRow`).
    const persisted = await persistFailedEvidence(connectorInstanceId, failedRow);
    return { row: failedRow, failed: true, persisted };
  }
}

function buildFailedRow(connectorInstanceId: string, reasonCode: string, err: unknown): Row {
  const sanitized = sanitizeProjectionError(err);
  return {
    connector_instance_id: connectorInstanceId,
    state: "failed",
    last_error: sanitized,
    record_snapshot_state: "failed",
    record_snapshot_reason_code: reasonCode,
    terminal_facts_state: "failed",
    terminal_facts_reason_code: reasonCode,
    manifest_declaration_state: "failed",
    manifest_declaration_reason_code: reasonCode,
    retained_bytes_state: "failed",
    retained_bytes_reason_code: reasonCode,
    dirty: 1,
  };
}

/**
 * Durably persist a repair-candidate failure OUTSIDE the failed transaction
 * (which already rolled back): an UPDATE that degrades exactly the columns
 * `buildFailedRow` computed, or — when no row exists yet for this
 * connection (first-ever observation that immediately fails) — an INSERT so
 * the failure is visible rather than silently absent. `terminal_facts_state`
 * is preserved from the existing row when it currently reads `current`
 * (matching `upsertSqliteEvidenceRow`/`upsertPostgresEvidenceRow`'s
 * success-path "preserve terminal_facts as-is" pattern — see their
 * `existing ? existing.terminal_facts_state : ...` carry-forward): a
 * record-snapshot repair failure is a DIFFERENT component's failure and must
 * never fabricate a terminal-facts failure that did not happen (design.md
 * "components are independent"). A row with no prior terminal_facts history
 * (never folded) has nothing to preserve, so it is failed closed like every
 * other component — this only ever "preserves" a genuinely current fold.
 *
 * Returns whether the durable write actually landed. When it did NOT (the
 * same fault that broke repair also breaks this write), the caller carries
 * `failedRow` through in memory instead of trusting a subsequent read of
 * durable storage to reflect the failure (closes Sol P1.1's simultaneous
 * repair-failure + failure-write-failure fail-open).
 */
async function persistFailedEvidence(connectorInstanceId: string, failedRow: Row): Promise<boolean> {
  try {
    if (isPostgresStorageBackend()) {
      await persistFailedEvidencePostgres(connectorInstanceId, failedRow);
    } else {
      persistFailedEvidenceSqlite(connectorInstanceId, failedRow);
    }
    return true;
  } catch {
    // The durable write itself failed. The row is left however it last
    // legitimately read; the caller carries `failedRow` through in memory
    // instead (see `RepairedEvidence.persisted` / `ReconcileResult.failedRows`).
    return false;
  }
}

function persistFailedEvidenceSqlite(connectorInstanceId: string, failedRow: Row): void {
  const db: Db = getDb();
  const existing = db
    .prepare(
      "SELECT terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as Row | undefined;
  const preserveTerminal = existing && existing.terminal_facts_state === "current";
  const terminalState = preserveTerminal ? existing?.terminal_facts_state : failedRow.terminal_facts_state;
  const terminalReason = preserveTerminal ? existing?.terminal_facts_reason_code : failedRow.terminal_facts_reason_code;
  const updateResult = db
    .prepare(
      `UPDATE connector_summary_evidence
          SET record_snapshot_state = ?,
              record_snapshot_reason_code = ?,
              manifest_declaration_state = ?,
              manifest_declaration_reason_code = ?,
              retained_bytes_state = ?,
              retained_bytes_reason_code = ?,
              terminal_facts_state = ?,
              terminal_facts_reason_code = ?,
              dirty = 1,
              state = 'failed',
              last_error = ?
        WHERE connector_instance_id = ?`
    )
    .run(
      failedRow.record_snapshot_state,
      failedRow.record_snapshot_reason_code,
      failedRow.manifest_declaration_state,
      failedRow.manifest_declaration_reason_code,
      failedRow.retained_bytes_state,
      failedRow.retained_bytes_reason_code,
      terminalState,
      terminalReason,
      failedRow.last_error,
      connectorInstanceId
    );
  if (updateResult.changes > 0) {
    return;
  }
  // No prior row: first-ever observation that immediately failed. Insert a
  // visible failed row rather than silently no-op'ing on a missing row.
  db.prepare(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name,
       record_snapshot_state, record_snapshot_reason_code,
       manifest_declaration_state, manifest_declaration_reason_code,
       retained_bytes_state, retained_bytes_reason_code,
       terminal_facts_state, terminal_facts_reason_code,
       dirty, state, last_error
     )
     VALUES(?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'failed', ?)
     ON CONFLICT(connector_instance_id) DO UPDATE SET
       record_snapshot_state = excluded.record_snapshot_state,
       record_snapshot_reason_code = excluded.record_snapshot_reason_code,
       manifest_declaration_state = excluded.manifest_declaration_state,
       manifest_declaration_reason_code = excluded.manifest_declaration_reason_code,
       retained_bytes_state = excluded.retained_bytes_state,
       retained_bytes_reason_code = excluded.retained_bytes_reason_code,
       terminal_facts_state = excluded.terminal_facts_state,
       terminal_facts_reason_code = excluded.terminal_facts_reason_code,
       dirty = 1,
       state = 'failed',
       last_error = excluded.last_error`
  ).run(
    connectorInstanceId,
    failedRow.record_snapshot_state,
    failedRow.record_snapshot_reason_code,
    failedRow.manifest_declaration_state,
    failedRow.manifest_declaration_reason_code,
    failedRow.retained_bytes_state,
    failedRow.retained_bytes_reason_code,
    failedRow.terminal_facts_state,
    failedRow.terminal_facts_reason_code,
    failedRow.last_error
  );
}

async function persistFailedEvidencePostgres(connectorInstanceId: string, failedRow: Row): Promise<void> {
  const existingResult = await postgresQuery(
    "SELECT terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const existing = existingResult.rows[0] as Row | undefined;
  const preserveTerminal = existing && existing.terminal_facts_state === "current";
  const terminalState = preserveTerminal ? existing?.terminal_facts_state : failedRow.terminal_facts_state;
  const terminalReason = preserveTerminal ? existing?.terminal_facts_reason_code : failedRow.terminal_facts_reason_code;
  const updateResult = await postgresQuery(
    `UPDATE connector_summary_evidence
        SET record_snapshot_state = $2,
            record_snapshot_reason_code = $3,
            manifest_declaration_state = $4,
            manifest_declaration_reason_code = $5,
            retained_bytes_state = $6,
            retained_bytes_reason_code = $7,
            terminal_facts_state = $8,
            terminal_facts_reason_code = $9,
            dirty = 1,
            state = 'failed',
            last_error = $10
      WHERE connector_instance_id = $1`,
    [
      connectorInstanceId,
      failedRow.record_snapshot_state,
      failedRow.record_snapshot_reason_code,
      failedRow.manifest_declaration_state,
      failedRow.manifest_declaration_reason_code,
      failedRow.retained_bytes_state,
      failedRow.retained_bytes_reason_code,
      terminalState,
      terminalReason,
      failedRow.last_error,
    ]
  );
  if ((updateResult.rowCount ?? 0) > 0) {
    return;
  }
  await postgresQuery(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name,
       record_snapshot_state, record_snapshot_reason_code,
       manifest_declaration_state, manifest_declaration_reason_code,
       retained_bytes_state, retained_bytes_reason_code,
       terminal_facts_state, terminal_facts_reason_code,
       dirty, state, last_error
     )
     VALUES($1, '', '', $2, $3, $4, $5, $6, $7, $8, $9, 1, 'failed', $10)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       record_snapshot_state = EXCLUDED.record_snapshot_state,
       record_snapshot_reason_code = EXCLUDED.record_snapshot_reason_code,
       manifest_declaration_state = EXCLUDED.manifest_declaration_state,
       manifest_declaration_reason_code = EXCLUDED.manifest_declaration_reason_code,
       retained_bytes_state = EXCLUDED.retained_bytes_state,
       retained_bytes_reason_code = EXCLUDED.retained_bytes_reason_code,
       terminal_facts_state = EXCLUDED.terminal_facts_state,
       terminal_facts_reason_code = EXCLUDED.terminal_facts_reason_code,
       dirty = 1,
       state = 'failed',
       last_error = EXCLUDED.last_error`,
    [
      connectorInstanceId,
      failedRow.record_snapshot_state,
      failedRow.record_snapshot_reason_code,
      failedRow.manifest_declaration_state,
      failedRow.manifest_declaration_reason_code,
      failedRow.retained_bytes_state,
      failedRow.retained_bytes_reason_code,
      failedRow.terminal_facts_state,
      failedRow.terminal_facts_reason_code,
      failedRow.last_error,
    ]
  );
}

function repairCandidateSqlite(connectorInstanceId: string): RepairedEvidence {
  const db: Db = getDb();
  try {
    // BEGIN IMMEDIATE (writeTransaction, not a deferred db.transaction()):
    // this unit reads canonical state (instance/manifest/checkpoint/records/
    // retained bytes) and then writes a derived upsert based on that read —
    // the write lock must be acquired at transaction start, not upgraded on
    // first write, so a concurrent writer serializes on the read rather than
    // racing between this read and this write. Same contract records.js's
    // ingest path uses for the identical read-then-write shape.
    return writeTransaction(() => {
      const instance = db
        .prepare("SELECT * FROM connector_instances WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as Row | undefined;
      if (!instance) {
        db.prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?").run(connectorInstanceId);
        return { row: { connector_instance_id: connectorInstanceId, __deleted: true }, failed: false, persisted: true };
      }
      const manifestRow = db
        .prepare("SELECT manifest FROM connectors WHERE connector_id = ?")
        .get(instance.connector_id) as Row | undefined;
      const manifest = parseManifestDeclaration(manifestRow?.manifest);
      const generationRow = db
        .prepare(
          "SELECT CAST(record_reset_generation AS TEXT) AS reset_generation FROM connector_instances WHERE connector_instance_id = ?"
        )
        .get(connectorInstanceId) as Row | undefined;
      const streamRows = db
        .prepare(
          "SELECT stream, CAST(max_version AS TEXT) AS max_version FROM version_counter WHERE connector_instance_id = ?"
        )
        .all(connectorInstanceId) as Row[];
      const checkpoint = normalizeRecordSourceCheckpoint({
        resetGeneration: String(generationRow?.reset_generation ?? "0"),
        streams: streamRows.map((row) => ({ stream: String(row.stream), maxVersion: String(row.max_version) })),
      });
      const canonicalRows = db
        .prepare(
          `SELECT stream, COUNT(*) AS record_count, MAX(emitted_at) AS last_updated
             FROM records WHERE connector_instance_id = ? AND deleted = 0
            GROUP BY stream`
        )
        .all(connectorInstanceId) as Row[];
      const canonicalByStream = new Map(canonicalRows.map((row) => [String(row.stream), row]));
      const retainedByteRow = db
        .prepare("SELECT * FROM retained_size_connection WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as Row | undefined;
      const retainedStreamRows = db
        .prepare("SELECT stream, record_count FROM retained_size_stream WHERE connector_instance_id = ?")
        .all(connectorInstanceId) as Row[];
      const retainedByStream = new Map(
        retainedStreamRows.map((row) => [String(row.stream), Number(row.record_count || 0)])
      );
      const unexpectedRows = manifest.ok
        ? (db
            .prepare(
              "SELECT stream FROM manifest_write_violations WHERE connector_instance_id = ? AND manifest_generation = ?"
            )
            .all(connectorInstanceId, Number(instance.manifest_generation ?? 0)) as Row[])
        : [];
      const unexpectedStreams = new Set(unexpectedRows.map((row) => String(row.stream)));
      const terminalHighWaterRow = db
        .prepare(
          `SELECT MAX(event_seq) AS max_seq FROM spine_events
            WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`
        )
        .get() as Row | undefined;

      // Test-only: see `testOnlyRepairCandidateSqliteDelay` — no-op in
      // production. Held here, between the read phase above and the write
      // phase below, still inside BEGIN IMMEDIATE.
      testOnlyRepairCandidateSqliteDelay();

      const built = buildRepairedRow({
        instance,
        manifest,
        checkpoint,
        canonicalByStream,
        retainedByteRow,
        retainedByStream,
        unexpectedStreams,
        terminalFactsGenerationBoundary:
          terminalHighWaterRow?.max_seq == null ? 0 : Number(terminalHighWaterRow.max_seq),
      });
      upsertSqliteEvidenceRow(db, built);
      return { row: built, failed: false, persisted: true };
    });
  } catch (err) {
    const failedRow = buildFailedRow(connectorInstanceId, REASON_CODES.RECORD_SNAPSHOT_FAILED, err);
    // Best-effort durable persist of the failure, OUTSIDE the failed
    // transaction (already rolled back). This is the same fault surface
    // Sol P1.1 reproduced (a trigger/fault rejecting BOTH the repair upsert
    // AND this write): `persistFailedEvidenceSqlite` can itself throw, so
    // it is wrapped exactly like the outer lock-failure branch — never left
    // to propagate uncaught, and `persisted: false` on failure so the
    // caller carries `failedRow` through in memory (see `ReconcileResult.failedRows`).
    let persisted = true;
    try {
      persistFailedEvidenceSqlite(connectorInstanceId, failedRow);
    } catch {
      persisted = false;
    }
    return { row: failedRow, failed: true, persisted };
  }
}

async function repairCandidatePostgres(connectorInstanceId: string): Promise<RepairedEvidence> {
  try {
    return await withPostgresTransaction(async (client: Db) => {
      const instanceResult = await client.query("SELECT * FROM connector_instances WHERE connector_instance_id = $1", [
        connectorInstanceId,
      ]);
      const instance = instanceResult.rows[0] as Row | undefined;
      if (!instance) {
        await client.query("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
        return { row: { connector_instance_id: connectorInstanceId, __deleted: true }, failed: false, persisted: true };
      }
      const manifestResult = await client.query(
        "SELECT manifest::text AS manifest FROM connectors WHERE connector_id = $1",
        [instance.connector_id]
      );
      const manifest = parseManifestDeclaration((manifestResult.rows[0] as Row | undefined)?.manifest);
      const generationResult = await client.query(
        "SELECT record_reset_generation::text AS reset_generation FROM connector_instances WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const streamsResult = await client.query(
        "SELECT stream, max_version::text AS max_version FROM version_counter WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const checkpoint = normalizeRecordSourceCheckpoint({
        resetGeneration: String((generationResult.rows[0] as Row | undefined)?.reset_generation ?? "0"),
        streams: (streamsResult.rows as Row[]).map((row) => ({
          stream: String(row.stream),
          maxVersion: String(row.max_version),
        })),
      });
      const canonicalResult = await client.query(
        `SELECT stream, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
           FROM records WHERE connector_instance_id = $1 AND deleted = FALSE
          GROUP BY stream`,
        [connectorInstanceId]
      );
      const canonicalByStream = new Map((canonicalResult.rows as Row[]).map((row) => [String(row.stream), row]));
      const retainedByteResult = await client.query(
        "SELECT * FROM retained_size_connection WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const retainedByteRow = retainedByteResult.rows[0] as Row | undefined;
      const retainedStreamResult = await client.query(
        "SELECT stream, record_count FROM retained_size_stream WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const retainedByStream = new Map(
        (retainedStreamResult.rows as Row[]).map((row) => [String(row.stream), Number(row.record_count || 0)])
      );
      const unexpectedResult = manifest.ok
        ? await client.query(
            "SELECT stream FROM manifest_write_violations WHERE connector_instance_id = $1 AND manifest_generation = $2",
            [connectorInstanceId, Number(instance.manifest_generation ?? 0)]
          )
        : { rows: [] as Row[] };
      const unexpectedStreams = new Set((unexpectedResult.rows as Row[]).map((row) => String(row.stream)));
      const terminalHighWaterResult = await client.query(
        `SELECT MAX(event_seq) AS max_seq FROM spine_events
          WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`
      );
      const terminalHighWater = (terminalHighWaterResult.rows[0] as Row | undefined)?.max_seq;

      const built = buildRepairedRow({
        instance,
        manifest,
        checkpoint,
        canonicalByStream,
        retainedByteRow,
        retainedByStream,
        unexpectedStreams,
        terminalFactsGenerationBoundary: terminalHighWater == null ? 0 : Number(terminalHighWater),
      });
      await upsertPostgresEvidenceRow(client, built);
      return { row: built, failed: false, persisted: true };
    });
  } catch (err) {
    const failedRow = buildFailedRow(connectorInstanceId, REASON_CODES.RECORD_SNAPSHOT_FAILED, err);
    // See the SQLite branch's identical comment: this write can itself
    // fail under the same fault (Sol P1.1), so it is wrapped rather than
    // left to propagate uncaught, and `persisted: false` on failure so the
    // caller carries `failedRow` through in memory.
    let persisted = true;
    try {
      await persistFailedEvidencePostgres(connectorInstanceId, failedRow);
    } catch {
      persisted = false;
    }
    return { row: failedRow, failed: true, persisted };
  }
}

interface RepairInputs {
  readonly canonicalByStream: ReadonlyMap<string, Row>;
  readonly checkpoint: RecordSourceCheckpoint;
  readonly instance: Row;
  readonly manifest: ManifestDeclaration;
  readonly retainedByStream: ReadonlyMap<string, number>;
  readonly retainedByteRow: Row | undefined;
  /**
   * Terminal-event high-water captured while the fingerprinted manifest is
   * repaired. This is an in-memory generation boundary, never persisted as a
   * timestamp: when declaration changes, all prior terminal facts must stay
   * historical until a post-boundary collection terminal event arrives.
   */
  readonly terminalFactsGenerationBoundary: number;
  readonly unexpectedStreams: ReadonlySet<string>;
}

/**
 * Build the fresh evidence row from re-read canonical facts. Pure — no I/O.
 * Canonical `records WHERE deleted = false` owns count/recency; retained-size
 * owns byte measures only; the manifest owns declaration; terminal facts are
 * NOT touched here (the stream-facts fold owns that component separately —
 * see `foldConnectorSummaryStreamFacts` — so a record-snapshot repair can
 * never launder a failed terminal fold, matching design.md's "components
 * are independent").
 */
function buildRepairedRow(inputs: RepairInputs): Row {
  const { instance, manifest, checkpoint, canonicalByStream, retainedByteRow, retainedByStream, unexpectedStreams } =
    inputs;
  const as_of = nowIso();

  const declaredStreams = new Set(manifest.ok ? manifest.streams : []);
  const canonicalStreams = new Set(canonicalByStream.keys());
  const retainedStreams = new Set(retainedByStream.keys());
  const unionStreams = manifest.ok
    ? new Set([...declaredStreams, ...canonicalStreams, ...retainedStreams, ...unexpectedStreams])
    : new Set([...canonicalStreams, ...retainedStreams]);

  const streamRecords: StreamEvidence[] = [...unionStreams].sort().map((stream) => {
    const canonical = canonicalByStream.get(stream);
    const retainedCount = retainedByStream.has(stream) ? retainedByStream.get(stream)! : null;
    let declaration_state: DeclarationState;
    if (!manifest.ok) {
      declaration_state = "unavailable";
    } else if (declaredStreams.has(stream)) {
      declaration_state = "declared";
    } else if (unexpectedStreams.has(stream)) {
      declaration_state = "unexpected";
    } else {
      declaration_state = "dormant";
    }
    const record_count = canonical ? Number(canonical.record_count || 0) : 0;
    const count_state: CountState = record_count > 0 ? "known" : "known_zero";
    return {
      stream,
      declaration_state,
      count_state,
      record_count,
      retained_record_count: retainedCount,
    };
  });

  let totalRecords = 0;
  let streamCount = 0;
  let lastRecordUpdatedAt: string | null = null;
  for (const [stream, row] of canonicalByStream) {
    if (manifest.ok && !declaredStreams.has(stream)) {
      continue;
    }
    const count = Number(row.record_count || 0);
    totalRecords += count;
    if (count > 0) {
      streamCount += 1;
    }
    const lastUpdated = (row.last_updated as string) || null;
    if (lastUpdated && (!lastRecordUpdatedAt || lastUpdated > lastRecordUpdatedAt)) {
      lastRecordUpdatedAt = lastUpdated;
    }
  }

  const retainedBytesClean = retainedByteRow ? Number(retainedByteRow.dirty || 0) === 0 : false;
  const retainedBytes = retainedBytesClean
    ? {
        record_json_bytes: Number(retainedByteRow?.current_record_json_bytes || 0),
        record_changes_json_bytes: Number(retainedByteRow?.record_history_json_bytes || 0),
        blob_bytes: Number(retainedByteRow?.blob_bytes || 0),
        total_bytes:
          Number(retainedByteRow?.current_record_json_bytes || 0) +
          Number(retainedByteRow?.record_history_json_bytes || 0) +
          Number(retainedByteRow?.blob_bytes || 0),
      }
    : null;

  return {
    connector_instance_id: instance.connector_instance_id,
    connector_id: instance.connector_id,
    display_name: instance.display_name,
    status: instance.status,
    source_kind: instance.source_kind,
    revoked_at: instance.revoked_at || null,
    total_records: totalRecords,
    stream_count: streamCount,
    last_record_updated_at: lastRecordUpdatedAt,
    stream_records_json: JSON.stringify(streamRecords),
    retained_bytes_json: JSON.stringify(retainedBytes ?? {}),
    total_retained_bytes: retainedBytes?.total_bytes ?? 0,
    record_checkpoint_json: JSON.stringify(checkpoint),
    manifest_fingerprint: manifest.ok ? manifest.fingerprint : null,
    manifest_generation: Number(instance.manifest_generation ?? 0),
    record_snapshot_state: "current",
    record_snapshot_reason_code: null,
    manifest_declaration_state: manifest.ok ? "current" : "unavailable",
    manifest_declaration_reason_code: manifest.ok ? null : REASON_CODES.MANIFEST_UNAVAILABLE,
    retained_bytes_state: retainedBytesClean ? "current" : "stale",
    retained_bytes_reason_code: retainedBytesClean ? null : REASON_CODES.RETAINED_BYTES_UNAVAILABLE,
    computed_at: as_of,
    dirty: 0,
    state: "fresh",
    last_error: null,
    terminal_facts_generation_boundary: inputs.terminalFactsGenerationBoundary,
  };
}

function upsertSqliteEvidenceRow(db: Db, row: Row): void {
  const existing = db
    .prepare(
      "SELECT manifest_generation, stream_latest_facts_json, stream_facts_event_seq, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?"
    )
    .get(row.connector_instance_id) as Row | undefined;
  const manifestGenerationChanged =
    existing !== undefined && Number(existing.manifest_generation ?? 0) !== Number(row.manifest_generation);
  const terminalFacts = terminalFactsForRepair(existing, row, manifestGenerationChanged);
  db.prepare(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name, status, source_kind,
       revoked_at, total_records, stream_count, last_record_updated_at,
       stream_records_json, retained_bytes_json, total_retained_bytes,
       record_checkpoint_json, manifest_fingerprint,
       record_snapshot_state, record_snapshot_reason_code,
       manifest_declaration_state, manifest_declaration_reason_code,
       retained_bytes_state, retained_bytes_reason_code,
       terminal_facts_state, terminal_facts_reason_code,
       stream_latest_facts_json, stream_facts_event_seq,
       dirty, computed_at, source_event_seq, state, last_error,
       manifest_generation
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)
     ON CONFLICT(connector_instance_id) DO UPDATE SET
       connector_id = excluded.connector_id,
       display_name = excluded.display_name,
       status = excluded.status,
       source_kind = excluded.source_kind,
       revoked_at = excluded.revoked_at,
       total_records = excluded.total_records,
       stream_count = excluded.stream_count,
       last_record_updated_at = excluded.last_record_updated_at,
       stream_records_json = excluded.stream_records_json,
       retained_bytes_json = excluded.retained_bytes_json,
       total_retained_bytes = excluded.total_retained_bytes,
       record_checkpoint_json = excluded.record_checkpoint_json,
       manifest_fingerprint = excluded.manifest_fingerprint,
       record_snapshot_state = excluded.record_snapshot_state,
       record_snapshot_reason_code = excluded.record_snapshot_reason_code,
       manifest_declaration_state = excluded.manifest_declaration_state,
       manifest_declaration_reason_code = excluded.manifest_declaration_reason_code,
       retained_bytes_state = excluded.retained_bytes_state,
       retained_bytes_reason_code = excluded.retained_bytes_reason_code,
       terminal_facts_state = excluded.terminal_facts_state,
       terminal_facts_reason_code = excluded.terminal_facts_reason_code,
       stream_latest_facts_json = excluded.stream_latest_facts_json,
       stream_facts_event_seq = excluded.stream_facts_event_seq,
       dirty = 0,
       computed_at = excluded.computed_at,
       state = 'fresh',
       last_error = NULL,
       manifest_generation = excluded.manifest_generation`
  ).run(
    row.connector_instance_id,
    row.connector_id,
    row.display_name,
    row.status,
    row.source_kind,
    row.revoked_at,
    row.total_records,
    row.stream_count,
    row.last_record_updated_at,
    row.stream_records_json,
    row.retained_bytes_json,
    row.total_retained_bytes,
    row.record_checkpoint_json,
    row.manifest_fingerprint,
    row.record_snapshot_state,
    row.record_snapshot_reason_code,
    row.manifest_declaration_state,
    row.manifest_declaration_reason_code,
    row.retained_bytes_state,
    row.retained_bytes_reason_code,
    // Record repairs preserve the independently-owned terminal component.
    // A fingerprint transition is the sole exception: it starts a new
    // declaration generation, so old terminal facts cannot be reattached to
    // a re-added stream. Advancing to the captured event high-water makes the
    // next fold consume only post-generation terminal evidence.
    terminalFacts.state,
    terminalFacts.reasonCode,
    terminalFacts.latestFactsJson,
    terminalFacts.eventSeq,
    row.computed_at,
    row.state,
    row.last_error,
    row.manifest_generation
  );
}

async function upsertPostgresEvidenceRow(client: Db, row: Row): Promise<void> {
  const existingResult = await client.query(
    "SELECT manifest_generation, stream_latest_facts_json, stream_facts_event_seq, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [row.connector_instance_id]
  );
  const existing = existingResult.rows[0] as Row | undefined;
  const manifestGenerationChanged =
    existing !== undefined && Number(existing.manifest_generation ?? 0) !== Number(row.manifest_generation);
  const terminalFacts = terminalFactsForRepair(existing, row, manifestGenerationChanged);
  await client.query(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name, status, source_kind,
       revoked_at, total_records, stream_count, last_record_updated_at,
       stream_records_json, retained_bytes_json, total_retained_bytes,
       record_checkpoint_json, manifest_fingerprint,
       record_snapshot_state, record_snapshot_reason_code,
       manifest_declaration_state, manifest_declaration_reason_code,
       retained_bytes_state, retained_bytes_reason_code,
       terminal_facts_state, terminal_facts_reason_code,
       stream_latest_facts_json, stream_facts_event_seq,
       dirty, computed_at, source_event_seq, state, last_error,
       manifest_generation
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24, 0, $25, NULL, $26, $27, $28)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       source_kind = EXCLUDED.source_kind,
       revoked_at = EXCLUDED.revoked_at,
       total_records = EXCLUDED.total_records,
       stream_count = EXCLUDED.stream_count,
       last_record_updated_at = EXCLUDED.last_record_updated_at,
       stream_records_json = EXCLUDED.stream_records_json,
       retained_bytes_json = EXCLUDED.retained_bytes_json,
       total_retained_bytes = EXCLUDED.total_retained_bytes,
       record_checkpoint_json = EXCLUDED.record_checkpoint_json,
       manifest_fingerprint = EXCLUDED.manifest_fingerprint,
       record_snapshot_state = EXCLUDED.record_snapshot_state,
       record_snapshot_reason_code = EXCLUDED.record_snapshot_reason_code,
       manifest_declaration_state = EXCLUDED.manifest_declaration_state,
       manifest_declaration_reason_code = EXCLUDED.manifest_declaration_reason_code,
       retained_bytes_state = EXCLUDED.retained_bytes_state,
       retained_bytes_reason_code = EXCLUDED.retained_bytes_reason_code,
       terminal_facts_state = EXCLUDED.terminal_facts_state,
       terminal_facts_reason_code = EXCLUDED.terminal_facts_reason_code,
       stream_latest_facts_json = EXCLUDED.stream_latest_facts_json,
       stream_facts_event_seq = EXCLUDED.stream_facts_event_seq,
       dirty = 0,
       computed_at = EXCLUDED.computed_at,
       state = 'fresh',
       last_error = NULL,
       manifest_generation = EXCLUDED.manifest_generation`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.display_name,
      row.status,
      row.source_kind,
      row.revoked_at,
      row.total_records,
      row.stream_count,
      row.last_record_updated_at,
      row.stream_records_json,
      row.retained_bytes_json,
      row.total_retained_bytes,
      row.record_checkpoint_json,
      row.manifest_fingerprint,
      row.record_snapshot_state,
      row.record_snapshot_reason_code,
      row.manifest_declaration_state,
      row.manifest_declaration_reason_code,
      row.retained_bytes_state,
      row.retained_bytes_reason_code,
      terminalFacts.state,
      terminalFacts.reasonCode,
      terminalFacts.latestFactsJson,
      terminalFacts.eventSeq,
      row.computed_at,
      row.state,
      row.last_error,
      row.manifest_generation,
    ]
  );
}

function terminalFactsForRepair(existing: Row | undefined, row: Row, manifestGenerationChanged: boolean) {
  if (manifestGenerationChanged) {
    return {
      state: "stale",
      reasonCode: REASON_CODES.MANIFEST_GENERATION_CHANGED,
      latestFactsJson: null,
      eventSeq: row.terminal_facts_generation_boundary,
    };
  }
  if (existing) {
    return {
      state: existing.terminal_facts_state,
      reasonCode: existing.terminal_facts_reason_code,
      latestFactsJson: existing.stream_latest_facts_json,
      eventSeq: existing.stream_facts_event_seq,
    };
  }
  return { state: "unobserved", reasonCode: null, latestFactsJson: null, eventSeq: null };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  readonly discovered: number;
  readonly failed: number;
  /**
   * Failed rows whose durable failure-marker write ALSO failed this call —
   * `repairCandidate`'s in-memory `row`, keyed by connector_instance_id, for
   * every candidate where `persisted` was `false`. A caller reading evidence
   * in the SAME barrier pass (`loadConnectorSummaryProjectionDeps`) merges
   * these over its subsequent durable read for the same instance ids, so a
   * simultaneous repair failure + failure-write failure still surfaces as
   * failed evidence this pass, not a stale `fresh`/`current` re-read (closes
   * Sol P1.1). Empty on every call where every failure was durably
   * persisted (the overwhelmingly common case) or where nothing failed.
   */
  readonly failedRows: ReadonlyMap<string, Row>;
  readonly repaired: number;
  /**
   * Count of classified candidates a bounded pass (see `options.maxCandidates`)
   * declined to repair this call, because the bound was reached. `0` for an
   * unbounded pass (every consumer except startup acceleration) — observation-
   * time repair on the next read remains the correctness gate regardless
   * (design.md "Startup is acceleration, not authority"), so a skipped
   * candidate is never lost, only deferred.
   */
  readonly skipped: number;
}

/**
 * The one scope-safe reconciliation primitive: batched fixed-query
 * discovery, then writer-fenced repair for exactly the classified
 * candidates. `connectorInstanceIds: null` runs a complete unscoped census
 * (which may also delete evidence rows absent from the complete
 * authoritative set); a non-null array runs a scoped pass that only
 * point-deletes an exact requested row proven gone — it never infers a
 * sibling is orphaned from a subset's absence.
 *
 * `options.maxCandidates`, when provided, caps the NUMBER of candidates THIS
 * call repairs — a bounded best-effort pass, never the correctness gate
 * (design.md "Startup is acceleration, not authority": every observation-
 * time read runs its own unbounded barrier regardless, so a candidate this
 * bound skips is repaired on the next read, not lost). Leave unset for every
 * read-time consumer, which genuinely needs the complete unbounded pass —
 * only startup's one-shot acceleration call bounds itself.
 *
 * `options.maxDurationMs`, when provided, ALSO bounds the repair loop's
 * total WALL-CLOCK time — checked between candidates (never mid-repair, so
 * a candidate already under its writer fence always finishes cleanly). A
 * small candidate COUNT does not bound total TIME when individual repairs
 * are slow (e.g. a connection with a very large canonical record set), so
 * `maxCandidates` alone is not a genuine work bound; `maxDurationMs`
 * closes that gap (Sol P2.2). The remaining unrepaired candidates are
 * reported in `skipped`, exactly like a count-bound cutoff — genuinely
 * deferred to the next observation, never lost. Discovery and orphan
 * pruning below are NOT time-bounded: discovery is already fixed-cost
 * (batched, not per-candidate — Sol P1.2), and orphan pruning requires the
 * COMPLETE canonical instance set to correctly distinguish "orphaned" from
 * "merely not yet discovered" — a partial discovery pass could not safely
 * prune at all without risking deleting a live connection's evidence.
 */
export async function reconcileConnectorSummaryEvidence(
  connectorInstanceIds: readonly string[] | null = null,
  options: { readonly maxCandidates?: number; readonly maxDurationMs?: number } = {}
): Promise<ReconcileResult> {
  const { instanceRows, candidates } = await discoverCandidates(connectorInstanceIds);

  const candidateEntries = [...candidates];
  const countBounded = typeof options.maxCandidates === "number" && options.maxCandidates >= 0;
  const timeBounded = typeof options.maxDurationMs === "number" && options.maxDurationMs >= 0;
  const countLimited = countBounded ? candidateEntries.slice(0, options.maxCandidates) : candidateEntries;
  const deadline = timeBounded ? Date.now() + options.maxDurationMs! : null;

  let repaired = 0;
  let failed = 0;
  const failedRows = new Map<string, Row>();
  for (const [connectorInstanceId] of countLimited) {
    if (deadline !== null && Date.now() >= deadline) {
      // Time budget exhausted between candidates — never mid-repair. The
      // remaining candidates (both count-limited-away and time-cut-off) are
      // reported via `skipped` below, deferred to the next observation.
      break;
    }
    const result = await repairCandidate(connectorInstanceId);
    repaired += 1;
    if (result.failed) {
      failed += 1;
      if (!result.persisted) {
        failedRows.set(connectorInstanceId, result.row);
      }
    }
  }
  const skipped = candidateEntries.length - repaired;

  // Orphan cleanup is a fixed-cost batched delete (not a per-candidate
  // repair loop), so it is never bounded — a startup pass that hit its
  // repair cap still fully prunes evidence for connections that no longer
  // exist at all.
  const dropped =
    connectorInstanceIds === null
      ? await pruneOrphanedEvidenceComplete(instanceRows)
      : await pruneOrphanedEvidenceScoped(connectorInstanceIds, instanceRows);

  return { discovered: instanceRows.length, repaired: repaired + dropped, failed, skipped, failedRows };
}

// ---------------------------------------------------------------------------
// Resumable bounded sweep — a genuine deadline spanning discovery + fold +
// repair across the COMPLETE set, not just the repair loop (Sol P2.2)
// ---------------------------------------------------------------------------

/**
 * Read one page of connector_instance_id values in stable ascending order,
 * strictly after `afterId` (keyset pagination — correct under concurrent
 * inserts/deletes between pages, unlike OFFSET). Cheap: id column only, no
 * join, no per-row work — used to size each bounded sweep batch before
 * handing the batch to the already-scoped `reconcileConnectorSummaryEvidence`
 * (via `connector-summary-read-model.ts`'s `runBoundedSummaryEvidenceSweep`,
 * which also needs the fold phase this engine module does not itself run).
 */
export async function readInstanceIdPage(afterId: string | null, limit: number): Promise<readonly string[]> {
  if (isPostgresStorageBackend()) {
    const result = afterId
      ? await postgresQuery(
          "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id > $1 ORDER BY connector_instance_id ASC LIMIT $2",
          [afterId, limit]
        )
      : await postgresQuery(
          "SELECT connector_instance_id FROM connector_instances ORDER BY connector_instance_id ASC LIMIT $1",
          [limit]
        );
    return (result.rows as Row[]).map((row) => String(row.connector_instance_id));
  }
  const db: Db = getDb();
  const rows = (
    afterId
      ? db
          .prepare(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id > ? ORDER BY connector_instance_id ASC LIMIT ?"
          )
          .all(afterId, limit)
      : db
          .prepare("SELECT connector_instance_id FROM connector_instances ORDER BY connector_instance_id ASC LIMIT ?")
          .all(limit)
  ) as Row[];
  return rows.map((row) => String(row.connector_instance_id));
}

/**
 * Lightweight complete id-only read, used by `connector-summary-read-model.ts`'s
 * `runBoundedSummaryEvidenceSweep` to complete-prune after a sweep genuinely
 * covered every page — the same cost class as `reconcileConnectorSummaryEvidence(null)`'s
 * own internal complete instance-row read (id column only here, not every
 * column). Exported: complete-set pruning requires this exact
 * (`pruneOrphanedEvidenceComplete`-compatible) live-id shape.
 */
export async function readAllInstanceIdsForPruning(): Promise<readonly Row[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery("SELECT connector_instance_id FROM connector_instances");
    return result.rows as Row[];
  }
  return getDb().prepare("SELECT connector_instance_id FROM connector_instances").all() as Row[];
}

/**
 * Complete-set orphan pruning as a standalone step: exported so
 * `connector-summary-read-model.ts`'s `runBoundedSummaryEvidenceSweep` can
 * run it after a genuinely complete sweep, using the same primitive
 * `reconcileConnectorSummaryEvidence(null)` uses internally.
 */
export async function pruneOrphanedEvidenceComplete(liveInstanceRows: readonly Row[]): Promise<number> {
  const liveIds = new Set(liveInstanceRows.map((row) => String(row.connector_instance_id)));
  if (isPostgresStorageBackend()) {
    const result =
      liveIds.size > 0
        ? await postgresQuery(
            "DELETE FROM connector_summary_evidence WHERE connector_instance_id <> ALL($1::text[]) RETURNING connector_instance_id",
            [[...liveIds]]
          )
        : await postgresQuery("DELETE FROM connector_summary_evidence RETURNING connector_instance_id");
    return result.rows.length;
  }
  const db: Db = getDb();
  const existing = db.prepare("SELECT connector_instance_id FROM connector_summary_evidence").all() as Row[];
  const stale = existing.map((row) => String(row.connector_instance_id)).filter((id) => !liveIds.has(id));
  if (stale.length === 0) {
    return 0;
  }
  const del = db.prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?");
  db.transaction(() => {
    for (const id of stale) {
      del.run(id);
    }
  })();
  return stale.length;
}

/**
 * Scoped orphan cleanup: for each requested id NOT found live in this scoped
 * discovery pass, prove via an exact point lookup that the connection is
 * really gone before deleting its evidence row. Absence from the requested
 * subset alone is never evidence a sibling connection is orphaned.
 *
 * Batched (one existence query + one delete query, not one query pair per
 * missing id — Sol P1.2): the missing-id set is typically small (usually 0
 * or 1 in real traffic — a scoped caller addresses a connection it already
 * resolved), but a caller passing many ids that all turn out to be gone
 * must not pay N point queries for it.
 */
async function pruneOrphanedEvidenceScoped(
  requestedIds: readonly string[],
  liveInstanceRows: readonly Row[]
): Promise<number> {
  const liveIds = new Set(liveInstanceRows.map((row) => String(row.connector_instance_id)));
  const missingIds = requestedIds.filter((id) => !liveIds.has(id));
  if (missingIds.length === 0) {
    return 0;
  }
  const stillGoneIds = await batchFilterConnectorInstancesMissing(missingIds);
  if (stillGoneIds.length === 0) {
    return 0;
  }
  if (isPostgresStorageBackend()) {
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ANY($1::text[])", [
      stillGoneIds,
    ]);
  } else {
    const placeholders = stillGoneIds.map(() => "?").join(", ");
    getDb()
      .prepare(`DELETE FROM connector_summary_evidence WHERE connector_instance_id IN (${placeholders})`)
      .run(...stillGoneIds);
  }
  return stillGoneIds.length;
}

/**
 * Batched existence check: returns the subset of `candidateIds` that are
 * NOT present in `connector_instances` (one query, not one point lookup per
 * id). Absence at THIS instant is what "still gone" means — the caller
 * already proved absence from the scoped discovery pass's own read; this is
 * the confirming re-check right before delete, batched the same way.
 */
async function batchFilterConnectorInstancesMissing(candidateIds: readonly string[]): Promise<readonly string[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[])",
      [candidateIds]
    );
    const present = new Set((result.rows as Row[]).map((row) => String(row.connector_instance_id)));
    return candidateIds.filter((id) => !present.has(id));
  }
  const placeholders = candidateIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(`SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id IN (${placeholders})`)
    .all(...candidateIds) as Row[];
  const present = new Set(rows.map((row) => String(row.connector_instance_id)));
  return candidateIds.filter((id) => !present.has(id));
}
