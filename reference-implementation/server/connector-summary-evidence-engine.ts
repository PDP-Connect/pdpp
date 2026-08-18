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

import { existsSync, writeFileSync } from "node:fs";
import {
  type BindValue,
  exec,
  execDynamicSqlAcknowledged,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  writeTransaction,
} from "../lib/db.ts";
import {
  type ConnectorInstanceWriteOwnership,
  withConnectorInstanceWrite,
} from "./connector-instance-write-coordinator.ts";
import {
  readConnectorInstanceIdPage,
  readEvidenceIdPage,
  readPostgresConnectorManifests,
  readSqliteConnectorManifests,
  runBoundedConnectorReconciliation,
  runScopedConnectorReconciliation,
} from "./connector-summary-evidence-bounded-reconciliation.ts";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "./postgres-storage.ts";
import {
  normalizeRecordSourceCheckpoint,
  type RecordSourceCheckpoint,
  recordSourceCheckpointsEqual,
} from "./record-source-checkpoint.ts";

// biome-ignore lint/suspicious/noExplicitAny: the db.js/pg boundary is untyped.
type Db = any;
type Row = Record<string, unknown>;
const DECIMAL_TEXT_RE = /^\d+$/;
const LEADING_ZEROES_RE = /^0+(?=\d)/;
const MAX_SOURCE_REVISION = "9223372036854775807";
const RECONCILE_PAGE_SIZE = 25;

function decimalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  if (!DECIMAL_TEXT_RE.test(text)) {
    return null;
  }
  return text.replace(LEADING_ZEROES_RE, "");
}

function sourceRevisionsEqual(left: unknown, right: unknown): boolean {
  const leftText = decimalText(left);
  const rightText = decimalText(right);
  return leftText !== null && rightText !== null && leftText === rightText;
}

function sourceRevisionIsExhausted(value: unknown): boolean {
  return decimalText(value) === MAX_SOURCE_REVISION;
}

function sourceRevisionDeferredReason(activeRun: boolean, sourceRevision: string | null): string {
  if (activeRun) {
    return REASON_CODES.SOURCE_REVISION_DEFERRED;
  }
  if (sourceRevisionIsExhausted(sourceRevision)) {
    return REASON_CODES.SOURCE_REVISION_EXHAUSTED;
  }
  return "canonical_source_revision_unknown";
}

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

/**
 * Test-only pause after a repair transaction rolls back and before its
 * failure marker publication. A second process can use the released window
 * to publish newer canonical evidence, proving the failed row is fenced by
 * the revision captured by the failed read. Production is a no-op.
 */
async function testOnlyRepairFailurePause(): Promise<void> {
  const markerPath = process.env.PDPP_TEST_REPAIR_FAILURE_MARKER_PATH;
  const releasePath = process.env.PDPP_TEST_REPAIR_FAILURE_RELEASE_PATH;
  if (!(markerPath && releasePath)) {
    return;
  }
  writeFileSync(markerPath, `${process.pid}\n`, "utf8");
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 30_000;
    const interval = setInterval(() => {
      if (existsSync(releasePath) || Date.now() >= deadline) {
        clearInterval(interval);
        resolve();
      }
    }, 5);
  });
}

export type ComponentState = "current" | "unobserved" | "stale" | "failed";
export type ManifestState = "current" | "unavailable" | "failed";
export type DeclarationState = "declared" | "dormant" | "unexpected" | "unavailable";
export type CountState = "known" | "known_zero" | "unobserved" | "stale" | "unknown";

/**
 * The one place a fresh per-stream `count_state` is derived, so the
 * "`known_zero` needs positive proof" invariant cannot drift between
 * callers. `observed` is the orthogonal observation axis (a record-source
 * checkpoint entry for the stream), NOT an attempt outcome: whether a run
 * failed is carried by the run/attempt surfaces and must never be folded
 * into a count state.
 *
 *   - observed + records    -> `known`      (exact count)
 *   - observed + no records -> `known_zero` (proven exact zero)
 *   - never observed        -> `unobserved` (no count claim of any kind)
 */
export function deriveStreamCountState({
  observed,
  recordCount,
}: {
  readonly observed: boolean;
  readonly recordCount: number;
}): CountState {
  if (recordCount > 0) {
    return "known";
  }
  return observed ? "known_zero" : "unobserved";
}

export type RepairCandidateReason =
  | "missing"
  | "dirty"
  | "state_stale"
  | "component_stale"
  | "record_checkpoint_mismatch"
  | "identity_mismatch"
  | "manifest_mismatch"
  | "retained_bytes_changed_or_unavailable"
  | "schedule_mismatch"
  | "lifecycle_checkpoint_lag"
  | "source_revision_mismatch"
  | "source_revision_exhausted";

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
  LOCK_UNAVAILABLE: "repair_lock_unavailable",
  MANIFEST_GENERATION_CHANGED: "manifest_generation_changed",
  MANIFEST_INVALID: "manifest_invalid",
  MANIFEST_UNAVAILABLE: "manifest_unavailable",
  MISSING: "summary_missing",
  RECORD_CHECKPOINT_LAG: "record_checkpoint_lag",
  RECORD_SNAPSHOT_FAILED: "record_snapshot_failed",
  RETAINED_BYTES_UNAVAILABLE: "retained_bytes_unavailable",
  SOURCE_REVISION_DEFERRED: "canonical_source_revision_deferred",
  SOURCE_REVISION_EXHAUSTED: "canonical_source_revision_exhausted",
  TERMINAL_FOLD_FAILED: "terminal_fold_failed",
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeProjectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null) {
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
    return { fingerprint: null, ok: false, streams: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fingerprint: null, ok: false, streams: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fingerprint: null, ok: false, streams: [] };
  }
  const streamsRaw = (parsed as Row).streams;
  if (!Array.isArray(streamsRaw) || streamsRaw.length === 0) {
    return { fingerprint: null, ok: false, streams: [] };
  }
  const streams = streamsRaw
    .map((entry) => (entry && typeof entry === "object" ? (entry as Row).name : null))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (streams.length === 0) {
    return { fingerprint: null, ok: false, streams: [] };
  }
  const sorted = [...new Set(streams)].sort();
  return { fingerprint: sorted.join(""), ok: true, streams: sorted };
}

// ---------------------------------------------------------------------------
// Batched, fixed-query discovery
// ---------------------------------------------------------------------------

interface DiscoveryInput {
  readonly canonicalTotalRecords: number;
  readonly currentCheckpoint: RecordSourceCheckpoint;
  /** Live `MAX(spine_events.event_seq)` for this connection, unfiltered by event_type. `null` when no spine events exist for it. */
  readonly currentLifecycleEventSeq: number | null;
  /** Live `connector_schedules.updated_at` for this connection, or `"absent"` when no schedule row exists. */
  readonly currentScheduleCheckpoint: string;
  /** Decimal text from connector_instances.source_revision; null is legacy/unknown. */
  readonly currentSourceRevision: string | null;
  readonly existingEvidence: Row | null;
  readonly instance: Row;
  readonly manifest: ManifestDeclaration;
  readonly retainedByteRow: Row | null;
}

/**
 * Evidence components whose per-component state column must never read
 * `"stale"`/`"failed"` on a row that needs no repair — components with NO
 * legitimate steady non-current state while the row itself is genuinely
 * fresh, so a `"stale"`/`"failed"` reading here can only mean a stale
 * component the authority comparisons below never re-derive on their own
 * (this closes exactly that gap). Deliberately excludes:
 *   - `manifest_declaration_state`: parks at `"unavailable"` forever for a
 *     genuinely malformed manifest (`parseManifestDeclaration`) — that is a
 *     stable, correct terminal state, not staleness to repair-loop on.
 *   - `retained_bytes_state`: its own convergence is fully covered by
 *     `retainedBytesNeedsRepair`'s source-vs-stored comparison below, which
 *     already handles a source-legitimately-absent `"stale"` value.
 *
 * `"unobserved"` is deliberately NOT treated as needing repair here: it is
 * this engine's own legitimate baseline before the separate terminal-fold
 * phase (`rowNeedsFoldParticipation` in connector-summary-read-model.ts, run
 * by the `rebuildConnectorSummaryEvidence` barrier immediately after this
 * engine's reconcile) has ever run for a connection — the fold, not this
 * repair, is what resolves `unobserved`, and it already retries independent
 * of this engine's own candidate classification. Treating `unobserved` as a
 * candidate here would make every standalone reconcile pass over a
 * fold-never-run connection repair-loop forever, which the "retained bytes
 * convergence is stable" test guards against.
 */
const COMPONENT_STATE_COLUMNS = ["terminal_facts_state"] as const;
const NON_REPAIRABLE_COMPONENT_STATES = new Set(["current", "unobserved"]);

/**
 * Classify one connection against canonical authorities. Returns the exact
 * repair reason (highest-precedence first) or `null` when the row is
 * `current` and needs no repair. Never reads the evidence row's own claim
 * about its state — only whether its stored facts still match the
 * authorities.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
function classifyCandidate(input: DiscoveryInput): RepairCandidateReason | null {
  const { instance, existingEvidence, manifest, currentCheckpoint, retainedByteRow } = input;

  if (!existingEvidence) {
    return "missing";
  }
  if (Number(existingEvidence.dirty || 0) !== 0) {
    return "dirty";
  }
  // `state` is an evidence claim, not a scheduling hint. A stale row with
  // dirty=0 is still not publishable and must re-enter the ordinary bounded
  // repair path. Without this check, terminal folding can advance the
  // canonical facts while the stale generic envelope permanently blocks the
  // projection publisher.
  if (existingEvidence.state !== "fresh") {
    return "state_stale";
  }
  // A fresh, clean envelope can still carry an individually stale/failed
  // component: e.g. a prior repair's `manifestGenerationChanged` branch
  // (`terminalFactsForRepair`) persists `terminal_facts_state: "stale"` while
  // leaving `state`/`dirty` clean, and no later authority comparison below
  // ever re-derives that same reason once the generation itself stops
  // changing. Without this check such a component can never converge again.
  for (const column of COMPONENT_STATE_COLUMNS) {
    if (!NON_REPAIRABLE_COMPONENT_STATES.has(String(existingEvidence[column]))) {
      return "component_stale";
    }
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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
    existingEvidence.manifest_fingerprint === null ? null : String(existingEvidence.manifest_fingerprint);
  const currentFingerprint = manifest.ok ? manifest.fingerprint : null;
  if (storedFingerprint !== currentFingerprint) {
    return "manifest_mismatch";
  }
  if (Number(existingEvidence.manifest_generation ?? 0) !== Number(instance.manifest_generation ?? 0)) {
    return "manifest_mismatch";
  }
  // Terminal-gate revision (2026-07-29): schedule mutations (pause/resume/
  // delete/upsert) have no other durable backstop — `connector_schedules.
  // updated_at` is the repair receipt, written atomically with every
  // mutation on both backends. `existingEvidence.schedule_checkpoint`
  // defaults to 'unobserved' for a pre-migration row, which never equals a
  // real `updated_at` value OR the 'absent' sentinel, so an old row is
  // always classified once and then converges.
  const storedScheduleCheckpoint = String(existingEvidence.schedule_checkpoint ?? "unobserved");
  if (storedScheduleCheckpoint !== input.currentScheduleCheckpoint) {
    return "schedule_mismatch";
  }
  // Terminal-gate revision (2026-07-29): run-lifecycle events (e.g.
  // `run.started`) beyond terminal outcomes have no other durable backstop
  // either — reuses the spine's own event_seq, scoped per connection.
  const storedLifecycleSeq =
    existingEvidence.run_lifecycle_event_seq === null || existingEvidence.run_lifecycle_event_seq === undefined
      ? null
      : Number(existingEvidence.run_lifecycle_event_seq);
  if (
    input.currentLifecycleEventSeq !== null &&
    (storedLifecycleSeq === null || storedLifecycleSeq < input.currentLifecycleEventSeq)
  ) {
    return "lifecycle_checkpoint_lag";
  }
  if (retainedBytesNeedsRepair(existingEvidence, retainedByteRow)) {
    return "retained_bytes_changed_or_unavailable";
  }
  if (sourceRevisionIsExhausted(input.currentSourceRevision)) {
    return sourceRevisionsEqual(existingEvidence.source_revision_text, input.currentSourceRevision)
      ? null
      : "source_revision_exhausted";
  }
  if (!sourceRevisionsEqual(existingEvidence.source_revision_text, input.currentSourceRevision)) {
    return "source_revision_mismatch";
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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
  if (connectorInstanceIds !== null && connectorInstanceIds.length === 0) {
    return {
      canonicalTotalRecordsByInstance: new Map<string, number>(),
      evidenceByInstance: new Map<string, Row>(),
      instanceRows: [] as Row[],
      manifestByConnector: new Map<string, string>(),
      maxLifecycleEventSeqByInstance: new Map<string, number>(),
      retainedByteByInstance: new Map<string, Row>(),
      scheduleUpdatedAtByInstance: new Map<string, string>(),
      versionCountersByInstance: new Map<string, Row[]>(),
    };
  }
  const scoped = connectorInstanceIds !== null;
  // REVIEWED-DYNAMIC: IN-list cardinality is bounded by the caller's own
  // requested scope (a route resolves at most one connection today; a
  // future bulk caller would still bind the same count of `?` placeholders
  // it requests), and every value is a bound parameter — never
  // string-interpolated into the SQL text.
  // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
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
  const instanceRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT *, CAST(source_revision AS TEXT) AS source_revision_text
             FROM connector_instances WHERE connector_instance_id IN (${placeholders})`
        )
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : [
        ...iterateDynamicSqlAcknowledged<Row>(
          "SELECT *, CAST(source_revision AS TEXT) AS source_revision_text FROM connector_instances ORDER BY connector_instance_id ASC"
        ),
      ];
  // Evidence/retained-bytes/version-counter/canonical-count reads are scoped
  // to the SAME requested id set (one batched query each, not a complete
  // table scan) when the caller narrowed the discovery — a scoped consumer
  // must not pay for every OTHER connection's rows, and must never even
  // read (let alone repair) a sibling connection's evidence row.
  const evidenceRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT *, CAST(source_revision AS TEXT) AS source_revision_text
             FROM connector_summary_evidence WHERE connector_instance_id IN (${placeholders})`
        )
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : [
        ...iterateDynamicSqlAcknowledged<Row>(
          "SELECT *, CAST(source_revision AS TEXT) AS source_revision_text FROM connector_summary_evidence"
        ),
      ];
  const evidenceByInstance = new Map(evidenceRows.map((row) => [String(row.connector_instance_id), row]));
  const connectorIds = [...new Set(instanceRows.map((row) => String(row.connector_id)))];
  const connectorRows = readSqliteConnectorManifests(db, connectorIds, sqlitePlaceholders(connectorIds));
  const manifestByConnector = new Map(connectorRows.map((row) => [String(row.connector_id), String(row.manifest)]));
  const retainedByteRows: Row[] = scoped
    ? db
        .prepare(`SELECT * FROM retained_size_connection WHERE connector_instance_id IN (${placeholders})`)
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : [...iterateDynamicSqlAcknowledged<Row>("SELECT * FROM retained_size_connection")];
  const retainedByteByInstance = new Map(retainedByteRows.map((row) => [String(row.connector_instance_id), row]));
  const versionCounterRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT connector_instance_id, stream, CAST(max_version AS TEXT) AS max_version FROM version_counter
            WHERE connector_instance_id IN (${placeholders})`
        )
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
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
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : db
        .prepare(
          "SELECT connector_instance_id, COUNT(*) AS total_records FROM records WHERE deleted = 0 GROUP BY connector_instance_id"
        )
        .all();
  const canonicalTotalRecordsByInstance = new Map(
    canonicalCountRows.map((row) => [String(row.connector_instance_id), Number(row.total_records || 0)])
  );
  // Terminal-gate revision (2026-07-29): schedule mutations have NO existing
  // dirty-independent backstop — `connector_schedules.updated_at` is already
  // written atomically with every schedule mutation on both backends (a
  // durable repair receipt), just never compared. One batched read of
  // exactly the requested (or complete) scope, same shape as the canonical
  // record-count read above.
  const scheduleRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT connector_instance_id, updated_at FROM connector_schedules
            WHERE connector_instance_id IN (${placeholders})`
        )
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : [...iterateDynamicSqlAcknowledged<Row>("SELECT connector_instance_id, updated_at FROM connector_schedules")];
  const scheduleUpdatedAtByInstance = new Map(
    scheduleRows.map((row) => [String(row.connector_instance_id), String(row.updated_at)])
  );
  // Terminal-gate revision (2026-07-29): run-lifecycle events (e.g.
  // `run.started`) have no existing dirty-independent backstop either. This
  // per-connection lifecycle receipt deliberately excludes terminal outcomes,
  // which are solely owned by the terminal-fold path.
  // Reuses the spine's own already-durable, atomically-assigned `event_seq`
  // as the repair receipt, scoped per connection (unlike the fleet-wide
  // terminal scalar, since run-lifecycle freshness is a per-connection fact).
  const maxLifecycleSeqRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
            WHERE connector_instance_id IN (${placeholders})
            GROUP BY connector_instance_id`
        )
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : db
        .prepare(
          `SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
            WHERE connector_instance_id IS NOT NULL
            GROUP BY connector_instance_id`
        )
        .all();
  const maxLifecycleEventSeqByInstance = new Map(
    maxLifecycleSeqRows.map((row) => [String(row.connector_instance_id), Number(row.max_seq)])
  );
  return {
    canonicalTotalRecordsByInstance,
    evidenceByInstance,
    instanceRows: instanceRows as Row[],
    manifestByConnector,
    maxLifecycleEventSeqByInstance,
    retainedByteByInstance,
    scheduleUpdatedAtByInstance,
    versionCountersByInstance,
  };
}

async function readPostgresDiscoveryContext(connectorInstanceIds: readonly string[] | null) {
  // `null` = complete census (unscoped). A non-null, EMPTY array is a
  // genuine "scoped to nothing" request; short-circuit rather than issue
  // `= ANY($1::text[])` with an empty bind array (which IS valid Postgres
  // and correctly matches zero rows for `instanceResult`, but the same
  // short-circuit as SQLite keeps both backends' empty-scope behavior
  // identical and avoids six no-op round-trips).
  if (connectorInstanceIds !== null && connectorInstanceIds.length === 0) {
    return {
      canonicalTotalRecordsByInstance: new Map<string, number>(),
      evidenceByInstance: new Map<string, Row>(),
      instanceRows: [] as Row[],
      manifestByConnector: new Map<string, string>(),
      maxLifecycleEventSeqByInstance: new Map<string, number>(),
      retainedByteByInstance: new Map<string, Row>(),
      scheduleUpdatedAtByInstance: new Map<string, string>(),
      versionCountersByInstance: new Map<string, Row[]>(),
    };
  }
  const scoped = connectorInstanceIds !== null;
  // See the SQLite branch's identical comment (Sol P1.3): unscoped
  // discovery reads the COMPLETE canonical connector_instances set across
  // every subject, matching the unfiltered evidence reads/prunes below —
  // an owner_subject_id filter here would let a distinct subject's
  // genuinely-live connection be pruned as orphaned.
  const instanceResult = scoped
    ? await postgresQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds]
      )
    : await postgresQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_instances ORDER BY connector_instance_id ASC"
      );
  // Evidence/retained-bytes/version-counter/canonical-count reads are scoped
  // to the SAME requested id set (one batched `ANY($1::text[])` query each,
  // not a complete table scan) when the caller narrowed the discovery —
  // matches the SQLite `IN (...)` batching above; a scoped consumer must
  // not pay for, or even read, every other connection's rows.
  const evidenceResult = scoped
    ? await postgresQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_summary_evidence WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds]
      )
    : await postgresQuery("SELECT *, source_revision::text AS source_revision_text FROM connector_summary_evidence");
  const evidenceByInstance = new Map(
    (evidenceResult.rows as Row[]).map((row) => [String(row.connector_instance_id), row])
  );
  const connectorIds = [...new Set((instanceResult.rows as Row[]).map((row) => String(row.connector_id)))];
  const connectorRows = await readPostgresConnectorManifests(connectorIds);
  const manifestByConnector = new Map(connectorRows.map((row) => [String(row.connector_id), String(row.manifest)]));
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
  // Terminal-gate revision (2026-07-29): schedule mutations have NO existing
  // dirty-independent backstop — `connector_schedules.updated_at` is already
  // written atomically with every schedule mutation on both backends (a
  // durable repair receipt), just never compared. One batched read of
  // exactly the requested (or complete) scope, same shape as the canonical
  // record-count read above.
  const scheduleResult = scoped
    ? await postgresQuery(
        "SELECT connector_instance_id, updated_at FROM connector_schedules WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds]
      )
    : await postgresQuery("SELECT connector_instance_id, updated_at FROM connector_schedules");
  const scheduleUpdatedAtByInstance = new Map(
    (scheduleResult.rows as Row[]).map((row) => [String(row.connector_instance_id), String(row.updated_at)])
  );
  // Terminal-gate revision (2026-07-29): run-lifecycle events (e.g.
  // `run.started`) have no existing dirty-independent backstop either. This
  // per-connection lifecycle receipt deliberately excludes terminal outcomes,
  // which are solely owned by the terminal-fold path.
  // Reuses the spine's own already-durable, atomically-assigned `event_seq`
  // as the repair receipt, scoped per connection.
  const maxLifecycleSeqResult = scoped
    ? await postgresQuery(
        `SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
          WHERE connector_instance_id = ANY($1::text[])
          GROUP BY connector_instance_id`,
        [connectorInstanceIds]
      )
    : await postgresQuery(
        `SELECT connector_instance_id, MAX(event_seq) AS max_seq FROM spine_events
          WHERE connector_instance_id IS NOT NULL
          GROUP BY connector_instance_id`
      );
  const maxLifecycleEventSeqByInstance = new Map(
    (maxLifecycleSeqResult.rows as Row[]).map((row) => [String(row.connector_instance_id), Number(row.max_seq)])
  );
  return {
    canonicalTotalRecordsByInstance,
    evidenceByInstance,
    instanceRows: instanceResult.rows as Row[],
    manifestByConnector,
    maxLifecycleEventSeqByInstance,
    retainedByteByInstance,
    scheduleUpdatedAtByInstance,
    versionCountersByInstance,
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
        maxVersion: String(row.max_version),
        stream: String(row.stream),
      })),
    });
    const reason = classifyCandidate({
      canonicalTotalRecords: ctx.canonicalTotalRecordsByInstance.get(instanceId) ?? 0,
      currentCheckpoint,
      currentLifecycleEventSeq: ctx.maxLifecycleEventSeqByInstance.get(instanceId) ?? null,
      currentScheduleCheckpoint: ctx.scheduleUpdatedAtByInstance.get(instanceId) ?? "absent",
      currentSourceRevision: decimalText(instance.source_revision_text),
      existingEvidence,
      instance,
      manifest,
      retainedByteRow: ctx.retainedByteByInstance.get(instanceId) ?? null,
    });
    if (reason) {
      candidates.set(instanceId, reason);
    }
  }
  return { candidates, instanceRows: ctx.instanceRows };
}

// ---------------------------------------------------------------------------
// Fenced repair — exactly the candidates, re-read + upsert in one transaction
// ---------------------------------------------------------------------------

interface RepairedEvidence {
  /** The canonical source was at the explicit BIGINT exhaustion sentinel. */
  readonly deferred: boolean;
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

function missingInstanceRepairResult(connectorInstanceId: string, deleted: boolean): RepairedEvidence {
  return {
    deferred: !deleted,
    failed: false,
    persisted: true,
    row: {
      connector_instance_id: connectorInstanceId,
      ...(deleted && { __deleted: true }),
      ...(!deleted && { dirty: 1, state: "stale" }),
    },
  };
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
    if (isPostgresStorageBackend()) {
      return await repairCandidatePostgres(connectorInstanceId);
    }
    return await repairCandidateSqlite(connectorInstanceId);
  } catch (err) {
    const failedRow = buildFailedRow(connectorInstanceId, REASON_CODES.LOCK_UNAVAILABLE, err);
    // The lock itself could not be acquired, so nothing about this
    // connection's canonical facts was even re-read this attempt — total
    // failure, every component fails closed (see `buildFailedRow`).
    const persisted = await persistFailedEvidence(connectorInstanceId, failedRow);
    return { deferred: false, failed: true, persisted, row: failedRow };
  }
}

function buildFailedRow(
  connectorInstanceId: string,
  reasonCode: string,
  err: unknown,
  sourceRevision?: string | null
): Row {
  const sanitized = sanitizeProjectionError(err);
  return {
    connector_instance_id: connectorInstanceId,
    dirty: 1,
    last_error: sanitized,
    manifest_declaration_reason_code: reasonCode,
    manifest_declaration_state: "failed",
    record_snapshot_reason_code: reasonCode,
    record_snapshot_state: "failed",
    retained_bytes_reason_code: reasonCode,
    retained_bytes_state: "failed",
    state: "failed",
    terminal_facts_reason_code: reasonCode,
    terminal_facts_state: "failed",
    ...(sourceRevision === undefined ? {} : { source_revision: sourceRevision }),
  };
}

function isFreshEvidenceRow(row: Row): boolean {
  return Number(row.dirty || 0) === 0 && row.state === "fresh";
}

/**
 * Decide whether a failed repair belongs to an older or unverified
 * publication. This is shared by both backends so saturation, stale-revision,
 * and admission-failure behavior cannot diverge between SQLite and Postgres.
 */
function shouldSkipFailedEvidencePublication(
  existing: Row | undefined,
  sourceRevision: string | null,
  failedRow: Row
): boolean {
  if (!existing) {
    return false;
  }
  // A stale evidence receipt is the normal reason this repair was admitted:
  // canonical source revision has advanced, so the repair rereads the new
  // revision while the existing row still carries the old one. If that
  // current-revision read then fails, the failure must advance the row to the
  // revision it failed to verify. Only failures without a captured current
  // revision (for example, admission/lock failure) need the old receipt match
  // as a guard against publishing an unscoped failure over newer evidence.
  const failureCapturedCurrentRevision =
    failedRow.source_revision !== undefined && sourceRevisionsEqual(failedRow.source_revision, sourceRevision);
  if (!(failureCapturedCurrentRevision || sourceRevisionsEqual(existing.source_revision, sourceRevision))) {
    return true;
  }
  const existingIsFresh = isFreshEvidenceRow(existing);
  if (existingIsFresh && sourceRevisionIsExhausted(sourceRevision)) {
    return true;
  }
  return existingIsFresh && failedRow.record_snapshot_reason_code === REASON_CODES.LOCK_UNAVAILABLE;
}

function failureTerminalFields(
  existing: Row | undefined,
  failedRow: Row
): {
  readonly terminalReason: unknown;
  readonly terminalState: unknown;
} {
  if (existing?.terminal_facts_state === "current") {
    return {
      terminalReason: existing.terminal_facts_reason_code,
      terminalState: existing.terminal_facts_state,
    };
  }
  return {
    terminalReason: failedRow.terminal_facts_reason_code,
    terminalState: failedRow.terminal_facts_state,
  };
}

/**
 * Durably persist a repair-candidate failure in a fenced transaction after
 * the failed repair transaction rolled back: an UPDATE that degrades exactly the columns
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
async function persistFailedEvidence(
  connectorInstanceId: string,
  failedRow: Row,
  ownership?: ConnectorInstanceWriteOwnership
): Promise<boolean> {
  try {
    await withConnectorInstanceWrite(
      connectorInstanceId,
      async () => {
        if (isPostgresStorageBackend()) {
          await withPostgresTransaction(
            (client: Db) => persistFailedEvidencePostgres(connectorInstanceId, failedRow, client),
            { lockConnectorInstanceId: connectorInstanceId }
          );
          return;
        }
        writeTransaction(() => persistFailedEvidenceSqlite(connectorInstanceId, failedRow));
      },
      ownership
    );
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
  const instance = db
    .prepare(
      "SELECT CAST(source_revision AS TEXT) AS source_revision_text FROM connector_instances WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as Row | undefined;
  if (!instance) {
    // Deletion wins over a late failure publication. The evidence row is a
    // disposable orphan and must not be recreated after the canonical row is
    // gone.
    exec(referenceQueries.connectorInstancesDeleteSummaryEvidenceByConnectorInstance, [connectorInstanceId]);
    return;
  }
  const sourceRevision = decimalText(instance.source_revision_text);
  const failedSourceRevision =
    failedRow.source_revision === undefined ? undefined : decimalText(failedRow.source_revision);
  if (failedSourceRevision !== undefined && !sourceRevisionsEqual(failedSourceRevision, sourceRevision)) {
    // This failure belongs to an older canonical read. A later writer may
    // already have published newer evidence; never let the old failure roll
    // that publication back to failed.
    return;
  }
  const existing = db
    .prepare(
      "SELECT source_revision, dirty, state, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as Row | undefined;
  if (shouldSkipFailedEvidencePublication(existing, sourceRevision, failedRow)) {
    // The failure belongs to an older canonical read, or this attempt never
    // verified canonical state. Preserve newer/fresh evidence.
    return;
  }
  const { terminalReason, terminalState } = failureTerminalFields(existing, failedRow);
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
              source_revision = ?,
              dirty = 1,
              state = 'failed',
              last_error = ?,
              list_summary_projection_state = 'stale',
              list_summary_projection_reason_code = 'canonical_evidence_failed',
              canonical_evidence_revision = canonical_evidence_revision + 1
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
      sourceRevision,
      failedRow.last_error,
      connectorInstanceId
    );
  if (updateResult.changes > 0) {
    return;
  }
  // No prior row: first-ever observation that immediately failed. Insert a
  // visible failed row rather than silently no-op'ing on a missing row.
  // REVIEWED-DYNAMIC: this fixed upsert is part of the evidence engine's
  // transaction-local SQLite repair seam.
  execDynamicSqlAcknowledged(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name,
       record_snapshot_state, record_snapshot_reason_code,
       manifest_declaration_state, manifest_declaration_reason_code,
       retained_bytes_state, retained_bytes_reason_code,
       terminal_facts_state, terminal_facts_reason_code,
       source_revision,
       dirty, state, last_error
     )
     VALUES(?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'failed', ?)
     ON CONFLICT(connector_instance_id) DO UPDATE SET
       record_snapshot_state = excluded.record_snapshot_state,
       record_snapshot_reason_code = excluded.record_snapshot_reason_code,
       manifest_declaration_state = excluded.manifest_declaration_state,
       manifest_declaration_reason_code = excluded.manifest_declaration_reason_code,
       retained_bytes_state = excluded.retained_bytes_state,
       retained_bytes_reason_code = excluded.retained_bytes_reason_code,
       terminal_facts_state = excluded.terminal_facts_state,
       terminal_facts_reason_code = excluded.terminal_facts_reason_code,
       source_revision = excluded.source_revision,
       dirty = 1,
       state = 'failed',
       last_error = excluded.last_error,
       list_summary_projection_state = 'stale',
       list_summary_projection_reason_code = 'canonical_evidence_failed',
       canonical_evidence_revision = canonical_evidence_revision + 1`,
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
      sourceRevision,
      failedRow.last_error,
    ] as BindValue[]
  );
}

async function persistFailedEvidencePostgres(
  connectorInstanceId: string,
  failedRow: Row,
  transactionClient: Db
): Promise<void> {
  const query = (sql: string, params?: readonly unknown[]) => transactionClient.query(sql, params);
  const instanceResult = await query(
    "SELECT source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
    [connectorInstanceId]
  );
  const instance = instanceResult.rows[0] as Row | undefined;
  if (!instance) {
    await query("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [connectorInstanceId]);
    return;
  }
  const sourceRevision = decimalText(instance.source_revision_text);
  const failedSourceRevision =
    failedRow.source_revision === undefined ? undefined : decimalText(failedRow.source_revision);
  if (failedSourceRevision !== undefined && !sourceRevisionsEqual(failedSourceRevision, sourceRevision)) {
    // This failure belongs to an older canonical read. A later writer may
    // already have published newer evidence; never let the old failure roll
    // that publication back to failed.
    return;
  }
  const existingResult = await query(
    "SELECT source_revision, dirty, state, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const existing = existingResult.rows[0] as Row | undefined;
  if (shouldSkipFailedEvidencePublication(existing, sourceRevision, failedRow)) {
    // The failure belongs to an older canonical read, or this attempt never
    // verified canonical state. Preserve newer/fresh evidence.
    return;
  }
  const { terminalReason, terminalState } = failureTerminalFields(existing, failedRow);
  const updateResult = await query(
    `UPDATE connector_summary_evidence
        SET record_snapshot_state = $2,
            record_snapshot_reason_code = $3,
            manifest_declaration_state = $4,
            manifest_declaration_reason_code = $5,
            retained_bytes_state = $6,
            retained_bytes_reason_code = $7,
            terminal_facts_state = $8,
            terminal_facts_reason_code = $9,
            source_revision = $10,
            dirty = 1,
            state = 'failed',
            last_error = $11,
            list_summary_projection_state = 'stale',
            list_summary_projection_reason_code = 'canonical_evidence_failed',
            canonical_evidence_revision = canonical_evidence_revision + 1
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
      sourceRevision,
      failedRow.last_error,
    ]
  );
  if ((updateResult.rowCount ?? 0) > 0) {
    return;
  }
  await query(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name,
       record_snapshot_state, record_snapshot_reason_code,
       manifest_declaration_state, manifest_declaration_reason_code,
       retained_bytes_state, retained_bytes_reason_code,
       terminal_facts_state, terminal_facts_reason_code,
       source_revision,
       dirty, state, last_error
     )
     VALUES($1, '', '', $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'failed', $11)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       record_snapshot_state = EXCLUDED.record_snapshot_state,
       record_snapshot_reason_code = EXCLUDED.record_snapshot_reason_code,
       manifest_declaration_state = EXCLUDED.manifest_declaration_state,
       manifest_declaration_reason_code = EXCLUDED.manifest_declaration_reason_code,
       retained_bytes_state = EXCLUDED.retained_bytes_state,
       retained_bytes_reason_code = EXCLUDED.retained_bytes_reason_code,
       terminal_facts_state = EXCLUDED.terminal_facts_state,
       terminal_facts_reason_code = EXCLUDED.terminal_facts_reason_code,
       source_revision = EXCLUDED.source_revision,
       dirty = 1,
       state = 'failed',
       last_error = EXCLUDED.last_error,
       list_summary_projection_state = 'stale',
       list_summary_projection_reason_code = 'canonical_evidence_failed',
       canonical_evidence_revision = connector_summary_evidence.canonical_evidence_revision + 1`,
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
      sourceRevision,
      failedRow.last_error,
    ]
  );
}

async function repairCandidateSqlite(connectorInstanceId: string): Promise<RepairedEvidence> {
  const db: Db = getDb();
  let sourceRevisionAtRead: string | null | undefined;
  try {
    const instance = db
      .prepare(
        "SELECT *, CAST(source_revision AS TEXT) AS source_revision_text FROM connector_instances WHERE connector_instance_id = ?"
      )
      .get(connectorInstanceId) as Row | undefined;
    if (!instance) {
      const deleted = await deleteEvidenceIfConnectorInstanceMissing(connectorInstanceId);
      return missingInstanceRepairResult(connectorInstanceId, deleted);
    }
    const sourceRevision = decimalText(instance.source_revision_text);
    sourceRevisionAtRead = sourceRevision;
    const activeRun = db
      .prepare("SELECT 1 AS present FROM controller_active_runs WHERE connector_instance_id = ? LIMIT 1")
      .get(connectorInstanceId) as Row | undefined;
    let built: Row;
    let deferred = false;
    if (activeRun || sourceRevision === null || sourceRevisionIsExhausted(sourceRevision)) {
      deferred = true;
      built = { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" };
    } else {
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
        streams: streamRows.map((row) => ({ maxVersion: String(row.max_version), stream: String(row.stream) })),
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
            WHERE connector_instance_id = ?
              AND event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`
        )
        .get(connectorInstanceId) as Row | undefined;
      // Terminal-gate revision (2026-07-29): repair also refreshes the
      // schedule/lifecycle repair-receipt checkpoints so a repaired row
      // records the current values it was JUST verified against, not the
      // stale ones that triggered the repair.
      const scheduleRow = db
        .prepare("SELECT updated_at FROM connector_schedules WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as Row | undefined;
      const lifecycleHighWaterRow = db
        .prepare("SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE connector_instance_id = ?")
        .get(connectorInstanceId) as Row | undefined;

      // Test-only: the delay is deliberately outside the writer fence so the
      // contention oracle proves expensive summary work does not monopolize it.
      testOnlyRepairCandidateSqliteDelay();

      built = buildRepairedRow({
        canonicalByStream,
        checkpoint,
        instance,
        lifecycleEventSeq:
          lifecycleHighWaterRow?.max_seq === null || lifecycleHighWaterRow?.max_seq === undefined
            ? null
            : Number(lifecycleHighWaterRow.max_seq),
        manifest,
        retainedByStream,
        retainedByteRow,
        scheduleCheckpoint: scheduleRow?.updated_at === undefined ? "absent" : String(scheduleRow.updated_at),
        sourceRevision,
        terminalFactsGenerationBoundary:
          terminalHighWaterRow?.max_seq === null || terminalHighWaterRow?.max_seq === undefined
            ? 0
            : Number(terminalHighWaterRow.max_seq),
        unexpectedStreams,
      });
    }
    return await withConnectorInstanceWrite(connectorInstanceId, async () =>
      writeTransaction(() => {
        const current = db
          .prepare(
            "SELECT CAST(source_revision AS TEXT) AS source_revision_text FROM connector_instances WHERE connector_instance_id = ?"
          )
          .get(connectorInstanceId) as Row | undefined;
        if (!(current && sourceRevisionsEqual(current.source_revision_text, sourceRevision))) {
          return {
            deferred: true,
            failed: false,
            persisted: true,
            row: { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" },
          };
        }
        if (deferred) {
          execDynamicSqlAcknowledged(
            `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', source_revision = ?, list_summary_projection_state = 'stale', list_summary_projection_reason_code = ?, last_error = NULL WHERE connector_instance_id = ?`,
            [sourceRevision, sourceRevisionDeferredReason(Boolean(activeRun), sourceRevision), connectorInstanceId]
          );
        } else {
          upsertSqliteEvidenceRow(db, built);
        }
        return { deferred, failed: false, persisted: true, row: built };
      })
    );
  } catch (err) {
    const failedRow = buildFailedRow(
      connectorInstanceId,
      REASON_CODES.RECORD_SNAPSHOT_FAILED,
      err,
      sourceRevisionAtRead
    );
    await testOnlyRepairFailurePause();
    // Best-effort durable persist of the failure after the failed
    // transaction has rolled back. This is the same fault surface
    // Sol P1.1 reproduced (a trigger/fault rejecting BOTH the repair upsert
    // AND this write): `persistFailedEvidenceSqlite` can itself throw, so
    // it is wrapped exactly like the outer lock-failure branch — never left
    // to propagate uncaught, and `persisted: false` on failure so the
    // caller carries `failedRow` through in memory (see `ReconcileResult.failedRows`).
    const persisted = await persistFailedEvidence(connectorInstanceId, failedRow);
    return { deferred: false, failed: true, persisted, row: failedRow };
  }
}

async function repairCandidatePostgres(connectorInstanceId: string): Promise<RepairedEvidence> {
  let sourceRevisionAtRead: string | null | undefined;
  try {
    const instanceResult = await postgresQuery(
      "SELECT *, source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId]
    );
    const instance = instanceResult.rows[0] as Row | undefined;
    if (!instance) {
      const deleted = await deleteEvidenceIfConnectorInstanceMissing(connectorInstanceId);
      return missingInstanceRepairResult(connectorInstanceId, deleted);
    }
    const sourceRevision = decimalText(instance.source_revision_text);
    sourceRevisionAtRead = sourceRevision;
    const activeRunResult = await postgresQuery(
      "SELECT 1 AS present FROM controller_active_runs WHERE connector_instance_id = $1 LIMIT 1",
      [connectorInstanceId]
    );
    let built: Row;
    const deferred =
      activeRunResult.rowCount !== 0 || sourceRevision === null || sourceRevisionIsExhausted(sourceRevision);
    if (deferred) {
      built = { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" };
    } else {
      const manifestResult = await postgresQuery(
        "SELECT manifest::text AS manifest FROM connectors WHERE connector_id = $1",
        [instance.connector_id]
      );
      const manifest = parseManifestDeclaration((manifestResult.rows[0] as Row | undefined)?.manifest);
      const generationResult = await postgresQuery(
        "SELECT record_reset_generation::text AS reset_generation FROM connector_instances WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const streamsResult = await postgresQuery(
        "SELECT stream, max_version::text AS max_version FROM version_counter WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const checkpoint = normalizeRecordSourceCheckpoint({
        resetGeneration: String((generationResult.rows[0] as Row | undefined)?.reset_generation ?? "0"),
        streams: (streamsResult.rows as Row[]).map((row) => ({
          maxVersion: String(row.max_version),
          stream: String(row.stream),
        })),
      });
      const canonicalResult = await postgresQuery(
        `SELECT stream, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
           FROM records WHERE connector_instance_id = $1 AND deleted = FALSE
          GROUP BY stream`,
        [connectorInstanceId]
      );
      const canonicalByStream = new Map((canonicalResult.rows as Row[]).map((row) => [String(row.stream), row]));
      const retainedByteResult = await postgresQuery(
        "SELECT * FROM retained_size_connection WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const retainedByteRow = retainedByteResult.rows[0] as Row | undefined;
      const retainedStreamResult = await postgresQuery(
        "SELECT stream, record_count FROM retained_size_stream WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const retainedByStream = new Map(
        (retainedStreamResult.rows as Row[]).map((row) => [String(row.stream), Number(row.record_count || 0)])
      );
      const unexpectedResult = manifest.ok
        ? await postgresQuery(
            "SELECT stream FROM manifest_write_violations WHERE connector_instance_id = $1 AND manifest_generation = $2",
            [connectorInstanceId, Number(instance.manifest_generation ?? 0)]
          )
        : { rows: [] as Row[] };
      const unexpectedStreams = new Set((unexpectedResult.rows as Row[]).map((row) => String(row.stream)));
      const terminalHighWaterResult = await postgresQuery(
        `SELECT MAX(event_seq) AS max_seq FROM spine_events
          WHERE connector_instance_id = $1
            AND event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`,
        [connectorInstanceId]
      );
      const terminalHighWater = (terminalHighWaterResult.rows[0] as Row | undefined)?.max_seq;
      // Terminal-gate revision (2026-07-29): repair also refreshes the
      // schedule/lifecycle repair-receipt checkpoints so a repaired row
      // records the current values it was JUST verified against, not the
      // stale ones that triggered the repair.
      const scheduleResult = await postgresQuery(
        "SELECT updated_at FROM connector_schedules WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const scheduleCheckpoint = (scheduleResult.rows[0] as Row | undefined)?.updated_at;
      const lifecycleHighWaterResult = await postgresQuery(
        "SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const lifecycleHighWater = (lifecycleHighWaterResult.rows[0] as Row | undefined)?.max_seq;

      built = buildRepairedRow({
        canonicalByStream,
        checkpoint,
        instance,
        lifecycleEventSeq:
          lifecycleHighWater === null || lifecycleHighWater === undefined ? null : Number(lifecycleHighWater),
        manifest,
        retainedByStream,
        retainedByteRow,
        scheduleCheckpoint: scheduleCheckpoint === undefined ? "absent" : String(scheduleCheckpoint),
        sourceRevision,
        terminalFactsGenerationBoundary: terminalHighWater === null ? 0 : Number(terminalHighWater),
        unexpectedStreams,
      });
    }
    return await withConnectorInstanceWrite(connectorInstanceId, async () =>
      withPostgresTransaction(
        async (client: Db) => {
          const current = await client.query(
            "SELECT source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1",
            [connectorInstanceId]
          );
          const currentRow = current.rows[0] as Row | undefined;
          if (!(currentRow && sourceRevisionsEqual(currentRow.source_revision_text, sourceRevision))) {
            return {
              deferred: true,
              failed: false,
              persisted: true,
              row: { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" },
            };
          }
          if (deferred) {
            await client.query(
              `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', source_revision = $2, list_summary_projection_state = 'stale', list_summary_projection_reason_code = $1, last_error = NULL WHERE connector_instance_id = $3`,
              [
                sourceRevisionDeferredReason(activeRunResult.rowCount !== 0, sourceRevision),
                sourceRevision,
                connectorInstanceId,
              ]
            );
          } else {
            await upsertPostgresEvidenceRow(client, built);
          }
          return { deferred, failed: false, persisted: true, row: built };
        },
        { lockConnectorInstanceId: connectorInstanceId }
      )
    );
  } catch (err) {
    const failedRow = buildFailedRow(
      connectorInstanceId,
      REASON_CODES.RECORD_SNAPSHOT_FAILED,
      err,
      sourceRevisionAtRead
    );
    await testOnlyRepairFailurePause();
    // See the SQLite branch's identical comment: this write can itself
    // fail under the same fault (Sol P1.1), so it is wrapped rather than
    // left to propagate uncaught, and `persisted: false` on failure so the
    // caller carries `failedRow` through in memory.
    const persisted = await persistFailedEvidence(connectorInstanceId, failedRow);
    return { deferred: false, failed: true, persisted, row: failedRow };
  }
}

interface RepairInputs {
  readonly canonicalByStream: ReadonlyMap<string, Row>;
  readonly checkpoint: RecordSourceCheckpoint;
  readonly instance: Row;
  /** Live `MAX(spine_events.event_seq)` for this connection at repair time, unfiltered by event_type. `null` when none exist. */
  readonly lifecycleEventSeq: number | null;
  readonly manifest: ManifestDeclaration;
  readonly retainedByStream: ReadonlyMap<string, number>;
  readonly retainedByteRow: Row | undefined;
  /** Live `connector_schedules.updated_at` for this connection at repair time, or `"absent"` when no schedule row exists. */
  readonly scheduleCheckpoint: string;
  /** Exact decimal source receipt captured by the fenced canonical read. */
  readonly sourceRevision: string;
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
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

  // The canonical `GROUP BY stream` read is SPARSE: a stream with no live
  // records produces no row at all, so `canonical === undefined` conflates
  // "provably zero" with "never successfully observed". The record-source
  // checkpoint (`version_counter`, read in the same transaction) is the
  // orthogonal observation axis that separates them: a checkpoint entry
  // exists only once ingest allocated a version for that stream, so it is
  // positive proof that the stream WAS canonically observed. Absent that
  // proof, an absent canonical row is `unobserved`, never `known_zero`.
  const observedStreams = new Set(checkpoint.streams.map((entry) => entry.stream));

  const streamRecords: StreamEvidence[] = [...unionStreams].sort().map((stream) => {
    const canonical = canonicalByStream.get(stream);
    // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
    const retainedCount = retainedByStream.has(stream) ? retainedByStream.get(stream)! : null;
    const declaration_state: DeclarationState = manifest.ok
      ? // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
        declaredStreams.has(stream)
        ? "declared"
        : // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
          unexpectedStreams.has(stream)
          ? "unexpected"
          : "dormant"
      : "unavailable";
    const record_count = canonical ? Number(canonical.record_count || 0) : 0;
    // `known_zero` requires POSITIVE canonical proof of an exact zero: the
    // stream was observed (checkpoint entry) and the canonical read returned
    // no live records for it — e.g. everything it held was deleted. An
    // absence of any observation carries no count claim at all.
    const count_state: CountState = deriveStreamCountState({
      observed: observedStreams.has(stream),
      recordCount: record_count,
    });
    return {
      count_state,
      declaration_state,
      record_count,
      retained_record_count: retainedCount,
      stream,
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
        blob_bytes: Number(retainedByteRow?.blob_bytes || 0),
        record_changes_json_bytes: Number(retainedByteRow?.record_history_json_bytes || 0),
        record_json_bytes: Number(retainedByteRow?.current_record_json_bytes || 0),
        total_bytes:
          Number(retainedByteRow?.current_record_json_bytes || 0) +
          Number(retainedByteRow?.record_history_json_bytes || 0) +
          Number(retainedByteRow?.blob_bytes || 0),
      }
    : null;

  return {
    computed_at: as_of,
    connector_id: instance.connector_id,
    connector_instance_id: instance.connector_instance_id,
    dirty: 0,
    display_name: instance.display_name,
    last_error: null,
    last_record_updated_at: lastRecordUpdatedAt,
    manifest_declaration_reason_code: manifest.ok ? null : REASON_CODES.MANIFEST_UNAVAILABLE,
    manifest_declaration_state: manifest.ok ? "current" : "unavailable",
    manifest_fingerprint: manifest.ok ? manifest.fingerprint : null,
    manifest_generation: Number(instance.manifest_generation ?? 0),
    record_checkpoint_json: JSON.stringify(checkpoint),
    record_snapshot_reason_code: null,
    record_snapshot_state: "current",
    retained_bytes_json: JSON.stringify(retainedBytes ?? {}),
    retained_bytes_reason_code: retainedBytesClean ? null : REASON_CODES.RETAINED_BYTES_UNAVAILABLE,
    retained_bytes_state: retainedBytesClean ? "current" : "stale",
    revoked_at: instance.revoked_at || null,
    run_lifecycle_event_seq: inputs.lifecycleEventSeq,
    schedule_checkpoint: inputs.scheduleCheckpoint,
    source_kind: instance.source_kind,
    source_revision: inputs.sourceRevision,
    state: "fresh",
    status: instance.status,
    stream_count: streamCount,
    stream_records_json: JSON.stringify(streamRecords),
    terminal_facts_generation_boundary: inputs.terminalFactsGenerationBoundary,
    total_records: totalRecords,
    total_retained_bytes: retainedBytes?.total_bytes ?? 0,
  };
}

const PROJECTION_RELEVANT_EVIDENCE_COLUMNS = [
  "connector_id",
  "display_name",
  "status",
  "source_kind",
  "revoked_at",
  "total_records",
  "stream_count",
  "last_record_updated_at",
  "stream_records_json",
  "retained_bytes_json",
  "total_retained_bytes",
  "record_checkpoint_json",
  "manifest_fingerprint",
  "record_snapshot_state",
  "record_snapshot_reason_code",
  "manifest_declaration_state",
  "manifest_declaration_reason_code",
  "retained_bytes_state",
  "retained_bytes_reason_code",
  "terminal_facts_state",
  "terminal_facts_reason_code",
  "stream_latest_facts_json",
  "stream_facts_event_seq",
  "manifest_generation",
  "schedule_checkpoint",
  "run_lifecycle_event_seq",
  "source_revision",
] as const;

function projectionRelevantEvidenceChanged(dialect: "postgres" | "sqlite"): string {
  const excluded = dialect === "postgres" ? "EXCLUDED" : "excluded";
  const distinctOperator = dialect === "postgres" ? "IS DISTINCT FROM" : "IS NOT";
  return PROJECTION_RELEVANT_EVIDENCE_COLUMNS.map(
    (column) => `connector_summary_evidence.${column} ${distinctOperator} ${excluded}.${column}`
  ).join("\n            OR ");
}

const SQLITE_PROJECTION_RELEVANT_EVIDENCE_CHANGED = projectionRelevantEvidenceChanged("sqlite");
const POSTGRES_PROJECTION_RELEVANT_EVIDENCE_CHANGED = projectionRelevantEvidenceChanged("postgres");

function upsertSqliteEvidenceRow(db: Db, row: Row): void {
  const existing = db
    .prepare(
      "SELECT manifest_generation, stream_latest_facts_json, stream_facts_event_seq, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?"
    )
    .get(row.connector_instance_id) as Row | undefined;
  const manifestGenerationChanged =
    existing !== undefined && Number(existing.manifest_generation ?? 0) !== Number(row.manifest_generation);
  const terminalFacts = terminalFactsForRepair(existing, row, manifestGenerationChanged);
  // REVIEWED-DYNAMIC: this fixed upsert is part of the evidence engine's
  // transaction-local SQLite repair seam.
  execDynamicSqlAcknowledged(
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
       manifest_generation, schedule_checkpoint, run_lifecycle_event_seq, source_revision
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?)
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
       canonical_evidence_revision = canonical_evidence_revision + 1,
       manifest_generation = excluded.manifest_generation,
       schedule_checkpoint = excluded.schedule_checkpoint,
       run_lifecycle_event_seq = excluded.run_lifecycle_event_seq,
       source_revision = excluded.source_revision,
       list_summary_projection_state = CASE
         WHEN ${SQLITE_PROJECTION_RELEVANT_EVIDENCE_CHANGED}
         THEN 'stale' ELSE connector_summary_evidence.list_summary_projection_state END,
       list_summary_projection_reason_code = CASE
         WHEN ${SQLITE_PROJECTION_RELEVANT_EVIDENCE_CHANGED}
         THEN 'canonical_evidence_rebuilt' ELSE connector_summary_evidence.list_summary_projection_reason_code END`,
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
      row.manifest_generation,
      row.schedule_checkpoint,
      row.run_lifecycle_event_seq,
      row.source_revision,
    ] as BindValue[]
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
       manifest_generation, schedule_checkpoint, run_lifecycle_event_seq, source_revision
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24, 0, $25, NULL, $26, $27, $28, $29, $30, $31)
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
       canonical_evidence_revision = connector_summary_evidence.canonical_evidence_revision + 1,
       manifest_generation = EXCLUDED.manifest_generation,
       schedule_checkpoint = EXCLUDED.schedule_checkpoint,
       run_lifecycle_event_seq = EXCLUDED.run_lifecycle_event_seq,
       source_revision = EXCLUDED.source_revision,
       list_summary_projection_state = CASE
         WHEN ${POSTGRES_PROJECTION_RELEVANT_EVIDENCE_CHANGED}
         THEN 'stale' ELSE connector_summary_evidence.list_summary_projection_state END,
       list_summary_projection_reason_code = CASE
         WHEN ${POSTGRES_PROJECTION_RELEVANT_EVIDENCE_CHANGED}
         THEN 'canonical_evidence_rebuilt' ELSE connector_summary_evidence.list_summary_projection_reason_code END`,
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
      row.schedule_checkpoint,
      row.run_lifecycle_event_seq,
      row.source_revision,
    ]
  );
}

function terminalFactsForRepair(existing: Row | undefined, row: Row, manifestGenerationChanged: boolean) {
  if (manifestGenerationChanged) {
    return {
      eventSeq: row.terminal_facts_generation_boundary,
      latestFactsJson: null,
      reasonCode: REASON_CODES.MANIFEST_GENERATION_CHANGED,
      state: "stale",
    };
  }
  if (existing) {
    return {
      eventSeq: existing.stream_facts_event_seq,
      latestFactsJson: existing.stream_latest_facts_json,
      reasonCode: existing.terminal_facts_reason_code,
      state: existing.terminal_facts_state,
    };
  }
  return { eventSeq: null, latestFactsJson: null, reasonCode: null, state: "unobserved" };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /**
   * Every id `repair()` was actually invoked for this call, in attempt
   * order — success, failure, and deferred outcomes all count as
   * "attempted"; an id fetched but never reached because the deadline
   * expired, or an id that was never classified as a candidate at all
   * (e.g. it turned out clean), is excluded. See
   * `runDirtyPriorityAcceleration` (connector-summary-read-model.ts) for
   * the fairness-rotation cursor this feeds.
   */
  readonly attemptedIds: readonly string[];
  /** Safe, finite classification labels and their candidate counts. */
  readonly candidateReasonCounts: Readonly<Record<RepairCandidateReason, number>>;
  /** Number of canonical connection rows inspected during discovery. */
  readonly candidatesInspected: number;
  /** Candidates whose repair attempted but failed. */
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

function resolveReconcileDeadline(options: {
  readonly deadline?: number;
  readonly maxDurationMs?: number;
}): number | null {
  if (typeof options.deadline === "number") {
    return options.deadline;
  }
  if (typeof options.maxDurationMs === "number" && options.maxDurationMs >= 0) {
    return Date.now() + options.maxDurationMs;
  }
  return null;
}

function pruneReconciledEvidence(
  connectorInstanceIds: readonly string[] | null,
  instanceRows: readonly Row[],
  deadline: number | null
): Promise<number> {
  if (deadline !== null && Date.now() >= deadline) {
    return Promise.resolve(0);
  }
  if (connectorInstanceIds === null) {
    return pruneOrphanedEvidenceComplete(deadline);
  }
  return pruneOrphanedEvidenceScoped(connectorInstanceIds, instanceRows);
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
 * `options.deadline`, when provided, is an absolute cooperative deadline for
 * the repair loop. It is checked before each repair unit; a unit already
 * under its writer fence finishes cleanly, but no later repair begins after
 * the deadline. `options.maxDurationMs` remains the standalone relative
 * form for callers that do not already own an absolute deadline.
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
 * pruning below are NOT deadline-CHECKED (there is no seam to check a
 * deadline partway through either one — each is a fixed, small, batched
 * query count REGARDLESS of N/K, Sol P1.2, but that only bounds query
 * COUNT, never a single query's own latency). A discovery query slow
 * enough under contention to exceed the caller's ENTIRE deadline on its own
 * (production, 2026-08-18: a canonical-count aggregate contending with
 * unrelated heavy I/O) silently consumes the whole round before the repair
 * loop ever runs — closed not here but in `repairCandidates`
 * (connector-summary-evidence-bounded-reconciliation.ts), which always
 * attempts its first selected candidate regardless of the deadline so a
 * slow discovery cannot reduce a round to zero repairs. Orphan pruning
 * additionally requires the COMPLETE canonical instance set to correctly
 * distinguish "orphaned" from "merely not yet discovered" — a partial
 * discovery pass could not safely prune at all without risking deleting a
 * live connection's evidence.
 */
export function reconcileConnectorSummaryEvidence(
  connectorInstanceIds: readonly string[] | null = null,
  options: {
    readonly candidateReasons?: readonly RepairCandidateReason[];
    readonly deadline?: number;
    readonly maxCandidates?: number;
    readonly maxDurationMs?: number;
  } = {}
): Promise<ReconcileResult> {
  if (connectorInstanceIds === null) {
    const deadline = resolveReconcileDeadline(options);
    return runBoundedConnectorReconciliation<Row, RepairCandidateReason, Row>({
      candidateReasons: options.candidateReasons,
      deadline,
      discover: discoverCandidates,
      maxCandidates:
        typeof options.maxCandidates === "number" && options.maxCandidates >= 0 ? options.maxCandidates : undefined,
      pageSize: RECONCILE_PAGE_SIZE,
      prune: pruneReconciledEvidence,
      pruneComplete: pruneOrphanedEvidenceCompleteByKeyset,
      readPage: readConnectorInstanceIdPage,
      repair: repairCandidate,
    });
  }

  // A maintenance caller passes its one absolute deadline through every
  // phase. Standalone callers retain the existing relative-duration API.
  const deadline = resolveReconcileDeadline(options);
  // A deadline-expired maintenance round defers even the fixed-cost prune:
  // it must not begin another SQL work unit after its owner deadline. An
  // unbounded or still-live call retains the original complete cleanup.
  return runScopedConnectorReconciliation<Row, RepairCandidateReason, Row>({
    candidateReasons: options.candidateReasons,
    connectorInstanceIds,
    deadline,
    discover: discoverCandidates,
    maxCandidates:
      typeof options.maxCandidates === "number" && options.maxCandidates >= 0 ? options.maxCandidates : undefined,
    prune: pruneReconciledEvidence,
    repair: repairCandidate,
  });
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
async function pruneOrphanedEvidenceCompleteByKeyset(deadline: number | null): Promise<number> {
  let afterId: string | null = null;
  let dropped = 0;
  for (;;) {
    if (deadline !== null && Date.now() >= deadline) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Evidence pages are intentionally sequential so deletions cannot invalidate the keyset cursor.
    const evidenceIds = await readEvidenceIdPage(afterId, RECONCILE_PAGE_SIZE);
    if (evidenceIds.length === 0) {
      break;
    }
    const stillGoneIds = await batchFilterConnectorInstancesMissing(evidenceIds);
    for (const id of stillGoneIds) {
      // biome-ignore lint/performance/noAwaitInLoops: each deletion must reacquire the exact connector-instance fence.
      if (await deleteEvidenceIfConnectorInstanceMissing(id)) {
        dropped += 1;
      }
    }
    afterId = evidenceIds.at(-1) ?? afterId;
    if (evidenceIds.length < RECONCILE_PAGE_SIZE) {
      break;
    }
  }
  return dropped;
}

/**
 * Complete-set orphan pruning as a standalone step: exported so
 * `connector-summary-read-model.ts`'s `runBoundedSummaryEvidenceSweep` can
 * run it after a genuinely complete sweep, using the same primitive
 * `reconcileConnectorSummaryEvidence(null)` uses internally.
 */
export function pruneOrphanedEvidenceComplete(deadline: number | null = null): Promise<number> {
  return pruneOrphanedEvidenceCompleteByKeyset(deadline);
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
  let dropped = 0;
  for (const id of stillGoneIds) {
    // biome-ignore lint/performance/noAwaitInLoops: each deletion must reacquire the exact connector-instance fence.
    if (await deleteEvidenceIfConnectorInstanceMissing(id)) {
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Delete an orphan only after the exact connector-instance fence has been
 * acquired and the canonical row has been reread. A stale discovery result
 * must not delete evidence for a same-id instance that was recreated while
 * the deletion was waiting.
 */
async function deleteEvidenceIfConnectorInstanceMissing(connectorInstanceId: string): Promise<boolean> {
  try {
    return await withConnectorInstanceWrite(connectorInstanceId, () => {
      if (isPostgresStorageBackend()) {
        return withPostgresTransaction(
          async (client: Db) => {
            const live = await client.query(
              "SELECT 1 FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
              [connectorInstanceId]
            );
            if ((live.rowCount ?? 0) !== 0) {
              return false;
            }
            const deleted = await client.query(
              "DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1",
              [connectorInstanceId]
            );
            return (deleted.rowCount ?? 0) > 0;
          },
          { lockConnectorInstanceId: connectorInstanceId }
        );
      }
      return Promise.resolve(
        writeTransaction(() => {
          const db: Db = getDb();
          const live = db
            .prepare("SELECT 1 AS present FROM connector_instances WHERE connector_instance_id = ?")
            .get(connectorInstanceId);
          if (live) {
            return false;
          }
          const deleted = db
            .prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?")
            .run(connectorInstanceId);
          return deleted.changes > 0;
        })
      );
    });
  } catch {
    // A failed fence acquisition leaves the disposable evidence row in place;
    // the next scoped observation will retry the exact recheck.
    return false;
  }
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
