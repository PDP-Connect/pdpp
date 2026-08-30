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
import {
  asPostgresStatementTimeoutError,
  isPostgresStorageBackend,
  PostgresStatementTimeoutError,
  postgresQuery,
  postgresQueryBounded,
  withPostgresTransaction,
} from "./postgres-storage.ts";
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

/**
 * Row page size for the chunked canonical-count scan (see
 * `scanCanonicalStreamsChunked`). `RECONCILE_PAGE_SIZE` (25) paginates
 * CONNECTION ids for discovery; this paginates DATA ROWS within a single
 * whale connection's own `records`, so it is a different resource at a
 * different scale.
 *
 * This is the initial limit, not a promise that every database can serve
 * that many rows inside the bound. The connection-wide query uses the
 * `idx_pg_records_instance_deleted_id (connector_instance_id, deleted, id)`
 * index, but heap visibility, cache state, and retained-row width vary by
 * deployment. A timeout halves the next limit in the durable chunk receipt,
 * so a whale adapts to the largest page its database can serve without
 * raising the per-unit timeout or retrying the same doomed query forever.
 */
const CHUNK_SCAN_PAGE_SIZE = 20_000;
const MIN_CHUNK_SCAN_PAGE_SIZE = 1;

function normalizedChunkScanPageSize(value: unknown, fallback = CHUNK_SCAN_PAGE_SIZE): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(CHUNK_SCAN_PAGE_SIZE, Math.max(MIN_CHUNK_SCAN_PAGE_SIZE, parsed));
}

function reducedChunkScanPageSize(pageSize: number): number {
  return Math.max(MIN_CHUNK_SCAN_PAGE_SIZE, Math.floor(pageSize / 2));
}

/**
 * Per-unit Postgres statement-timeout floor (design review P1-2): the
 * cooperative `deadline` this module threads through `discoverCandidates`/
 * `repairCandidate` is a PASS ADMISSION deadline, checked only BETWEEN
 * units — it never bounds a single query's own server-side execution (see
 * `reconcileConnectorSummaryEvidence`'s doc for the reviewer's two-contract
 * framing). `remainingStatementBudgetMs` derives a `statement_timeout` for
 * `postgresQueryBounded` from the caller's remaining admission allowance so
 * a discovery/repair unit's own queries cannot, on their own, silently
 * consume more than what was left when the unit started (production,
 * 2026-08-18: `repair_duration_ms: 5322` against a 2000ms pass budget).
 *
 * Revised 2026-08-18 after a real production regression: the ORIGINAL 50ms
 * floor claimed "every query this floor applies to is index-bounded and
 * normally fast" — that claim was false for the discovery batch's own
 * `COUNT(*) GROUP BY` over `records`, which had NO index covering `deleted`
 * (the exact query this whole mechanism existed to bound). That query was a
 * redundant supplementary drift check — `source_revision` already catches
 * the same direct-writer-bypass scenario incrementally — and has since been
 * REMOVED from this hot path entirely (2026-08-18, see `classifyCandidate`'s
 * doc); this floor and the per-unit bound machinery below remain as general
 * protection for every OTHER discovery/repair query, which is why they are
 * kept even though the query that motivated 500ms specifically is gone.
 * Because the fold phase runs BEFORE discovery/repair in
 * `runBoundedObservationPhases`
 * (connector-summary-read-model.ts), discovery routinely starts with little
 * or no admission allowance left, so `remainingStatementBudgetMs` collapsed
 * to the 50ms floor on nearly every pass — cancelling that unindexed count
 * query (which realistically takes low hundreds of ms, not 50) on almost
 * every attempt. Within minutes this flipped 25 of 29 `connector_summary_
 * evidence` rows from `current` to `failed` with zero visible error (see
 * `PostgresStatementTimeoutError` handling below and in
 * connector-summary-read-model.ts — cancellation is now loud and non-fatal
 * to already-healthy rows).
 *
 * 500ms is a genuine minimum absolute timeout, not merely a "near-zero
 * allowance" floor: it is chosen to comfortably exceed the unindexed count
 * query's realistic healthy duration while still being well under the
 * round's 2000ms pass budget, so a single per-unit cancellation remains
 * possible for a genuinely pathological/runaway statement. `deadline ===
 * null` (every caller except the maintenance sweep) is unaffected — those
 * callers keep the exact prior unbounded `postgresQuery` behavior.
 */
const MIN_STATEMENT_TIMEOUT_MS = 500;

/**
 * Returns the statement budget for a unit starting NOW, or `0` when the
 * admission allowance is already gone.
 *
 * The 500ms floor (above) is an absolute MINIMUM for an admitted unit — not a
 * licence to admit a unit that has no allowance left. Returning the floor
 * unconditionally made those two things the same thing, and that is the
 * production starvation this closes (2026-08-26): a repair that CANNOT finish
 * inside 500ms is re-admitted on every single pass, is cancelled by
 * `statement_timeout` every time, and consumes the round. Measured on the
 * owner's instance: one connection (1,573,722 records) timed out 58 times in
 * one hour — roughly 29 minutes of wall clock — while the fleet as a whole
 * recomputed 3 rows in that hour and 0 in the final 15 minutes. Two other
 * connections sat unmeasured for 2h and 5h behind it.
 *
 * `0` means "no allowance" and callers must not begin a unit; it is distinct
 * from `null`, which means "no deadline at all" (every caller except the
 * maintenance sweep) and preserves the original unbounded behavior.
 */
export function remainingStatementBudgetMs(deadline: number | null): number | null {
  if (deadline === null) {
    return null;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return 0;
  }
  return Math.max(MIN_STATEMENT_TIMEOUT_MS, remaining);
}

/**
 * Headroom a chunked canonical scan requires before it will START another page.
 *
 * NOT an independently-picked constant: it is one fifth of
 * `MIN_STATEMENT_TIMEOUT_MS`, the floor already established (above) as a
 * genuine minimum that comfortably exceeds a realistic healthy statement's
 * duration on THIS deployment. Deriving from that floor rather than a fresh
 * literal means the two move together — if a slower host or a heavier fleet
 * ever forces `MIN_STATEMENT_TIMEOUT_MS` up, this headroom scales with it
 * instead of silently becoming the smaller fraction it was tuned against.
 *
 * A flat "measured one page at 16.96ms, multiply by six" bound was rejected:
 * this same file recorded a >10x gap between a query's happy-path cost and
 * its measured production cost under contention (3.3-6.1s against the exact
 * same 500ms floor, see the `MIN_STATEMENT_TIMEOUT_MS` history above) for a
 * DIFFERENT query on the SAME `records` table. A fixed multiple of a single
 * good-case sample has no such precedent to justify surviving that spread; a
 * fraction of the floor a slower host is already known to require does.
 *
 * A page that cannot start inside this headroom is deferred to the next
 * admission, which resumes from the boundary already committed. Being wrong
 * in the conservative direction costs one extra pass; being wrong the other
 * way costs a CANCELLED page, and the whole point of this mechanism is that a
 * cancelled page throws away its work.
 */
const CHUNK_SCAN_PAGE_HEADROOM_MS = MIN_STATEMENT_TIMEOUT_MS / 5;

/**
 * Is there enough ADMISSION allowance left to start another chunk-scan page?
 *
 * Deliberately separate from `remainingStatementBudgetMs`, which answers a
 * different question: what `statement_timeout` should ONE statement get. That
 * helper floors its answer at `MIN_STATEMENT_TIMEOUT_MS`, so with 100 ms of
 * real allowance left it reports 500 — a per-statement bound, never a claim
 * that 500 ms of admission remains. Using `=== 0` as a proxy for "expired"
 * therefore only fires AFTER the deadline has fully elapsed: with 100-499 ms
 * left the loop would start one more page believing it had 500 ms, and
 * Postgres would cancel it mid-page and discard its work — precisely the
 * failure this yield exists to remove.
 *
 * So this reads the raw, unfloored `deadline - Date.now()` and compares it
 * against the headroom a page actually needs. `null` means "no deadline at
 * all" (every caller except the maintenance sweep) and must preserve the
 * original unbounded behaviour, so it is never exhausted.
 *
 * This does NOT raise, extend, or reuse the per-unit bound. It only declines
 * to start a page it has no budget to finish.
 */
function admissionAllowanceExhausted(deadline: number | null): boolean {
  if (deadline === null) {
    return false;
  }
  return deadline - Date.now() < CHUNK_SCAN_PAGE_HEADROOM_MS;
}

/**
 * Exponential back-off for a repair unit that keeps being cancelled by the
 * per-unit `statement_timeout` bound.
 *
 * Zeroing the depleted allowance (above) stops a doomed unit from being
 * admitted with no budget, but it does not stop it being RE-SELECTED: a row
 * whose repair genuinely cannot finish inside the bound stays `dirty`, is
 * discovered again next pass, and — because `repairCandidates` guarantees the
 * FIRST selected candidate is always attempted regardless of the deadline
 * (deliberately, to close a different 2026-08-18 starvation) — consumes the
 * whole round before any other dirty row is reached. Measured on the owner's
 * instance 2026-08-26: 58 cancellations in one hour for a single connection,
 * while two healthy connections sat unmeasured for 2h and 5h behind it.
 *
 * So the unit backs off: retry after 1 minute, then 2, 4, 8 … capped at
 * `MAX_REPAIR_TIMEOUT_BACKOFF_MS`. It still retries — a connection that grew
 * past the bound must be able to recover on its own once the underlying cause
 * is fixed — just not once a minute at ~30s of wall clock each.
 *
 * Deliberately IN-PROCESS, not a new column on `connector_summary_evidence`:
 * this is scheduling state, not evidence about the owner's data, and it must
 * never be mistaken for a fact about a connection. A process restart clears
 * it, which costs exactly one extra attempt per affected row.
 */
const REPAIR_TIMEOUT_BACKOFF_BASE_MS = 60_000;
const MAX_REPAIR_TIMEOUT_BACKOFF_MS = 30 * 60_000;
const repairTimeoutBackoffUntil = new Map<string, number>();
const repairTimeoutStrikes = new Map<string, number>();

/**
 * Test-only: read the raw `repairTimeoutBackoffUntil` deadline for one row,
 * without going through the outer `repairCandidate` gate. Lets a
 * deterministic test assert the SURVIVING window's magnitude (e.g. "still
 * reflects strike 2's ~120s, not the flat function's own 60s base") directly,
 * rather than inferring it indirectly from whether a later call was skipped —
 * which conflates "the gate let this call through" with "the value it wrote
 * was correct," the exact distinction a de-escalation regression hides
 * behind.
 */
export function __testOnlyReadRepairTimeoutBackoffUntil(connectorInstanceId: string): number | undefined {
  return repairTimeoutBackoffUntil.get(connectorInstanceId);
}

/**
 * Test-only: clear one row's backoff window without waiting for it to
 * elapse. A test proving strike-ladder preservation needs several
 * back-to-back admissions of the SAME row within one process's lifetime —
 * waiting out a real 60s/120s/240s window between them would make the test
 * itself minutes long. This clears only the scheduling-gate map
 * (`repairTimeoutBackoffUntil`), never `repairTimeoutStrikes`, so the strike
 * COUNT a test is asserting against accumulates exactly as production would
 * accumulate it; only the wait between attempts is skipped.
 */
export function __testOnlyClearRepairTimeoutBackoffUntil(connectorInstanceId: string): void {
  repairTimeoutBackoffUntil.delete(connectorInstanceId);
}

// Test-only timing seam for the real timeout/retry test. Production keeps the
// fixed one-minute base unless this explicitly test-named variable is set.
function repairTimeoutBackoffBaseMs(): number {
  const raw = process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : REPAIR_TIMEOUT_BACKOFF_BASE_MS;
}

/**
 * Test-only: call the real `noteRepairTimeout` directly, bypassing
 * `repairCandidate`'s outer skip gate.
 *
 * The gate (`repairCandidate`, `repairTimeoutBackoffUntil.get(id) < Date.now()`)
 * is the ONLY caller of either backoff function in this process, and it never
 * lets a second call through while a prior window is still live — so a live
 * "genuine strikes still armed, then a completed-scan timeout arrives" race
 * cannot be constructed by driving `reconcileConnectorSummaryEvidence`
 * end-to-end: by the time the gate lets a retry through, the previous window
 * has always already elapsed. Testing `noteRepairTimeoutAfterCompletedScan`'s
 * `Math.max` contract — which must hold even for a window that has NOT yet
 * elapsed, since nothing in its own signature enforces that precondition —
 * requires calling both functions directly against the real, shared,
 * module-level maps, exactly as production's single call site does.
 */
export function __testOnlyNoteRepairTimeout(connectorInstanceId: string): void {
  noteRepairTimeout(connectorInstanceId);
}

/**
 * Test-only: call the real `noteRepairTimeoutAfterCompletedScan` directly,
 * for the same reason and against the same real maps as
 * `__testOnlyNoteRepairTimeout` above.
 */
export function __testOnlyNoteRepairTimeoutAfterCompletedScan(connectorInstanceId: string): void {
  noteRepairTimeoutAfterCompletedScan(connectorInstanceId);
}

function noteRepairTimeout(connectorInstanceId: string): void {
  const strikes = (repairTimeoutStrikes.get(connectorInstanceId) ?? 0) + 1;
  repairTimeoutStrikes.set(connectorInstanceId, strikes);
  const delayMs = Math.min(MAX_REPAIR_TIMEOUT_BACKOFF_MS, repairTimeoutBackoffBaseMs() * 2 ** (strikes - 1));
  repairTimeoutBackoffUntil.set(connectorInstanceId, Date.now() + delayMs);
  console.error(
    `[connector-summary-evidence] repair for ${connectorInstanceId} has now been cancelled by statement_timeout ${strikes} time(s); backing off ${Math.round(delayMs / 1000)}s so other dirty rows are not starved behind it`
  );
}

/**
 * A `PostgresStatementTimeoutError` that fires AFTER this attempt's canonical
 * scan already banked a COMPLETE accumulator (see `canonicalScanCompletedThisAttempt`
 * in `repairCandidatePostgres`) must not pace like a genuine scan timeout.
 *
 * `noteRepairTimeout`'s escalating strikes exist because a row whose scan
 * cannot finish inside the bound keeps re-attempting the SAME doomed work —
 * unpaced, it starves every other dirty row behind it, so slowing it down is
 * the correct trade. That reasoning does not hold here: the scan is already
 * done, so the next attempt's OWN scan resolves in one page query that finds
 * nothing past its committed boundary — the expensive part is not being
 * repeated. What failed is a trailing bookkeeping read (manifest, generation,
 * streams, retained size, terminal/schedule high-water, or the publication
 * CAS itself), which is cheap and has no reason to keep failing at the same
 * rate a canonical scan would.
 *
 * So this arms a single FLAT delay — not zero (an unpaced retry loop here
 * would still consume a round every pass under sustained contention, the
 * exact starvation `noteRepairTimeout` exists to prevent) and not escalating
 * (this row is not becoming less likely to succeed each time; nothing about
 * repeating this cheap read gets harder).
 *
 * `Math.max` against whatever is already in `repairTimeoutBackoffUntil` is
 * load-bearing, not defensive: this map is the SAME one `noteRepairTimeout`
 * writes, so a row that already accumulated genuine strikes (e.g. 5 strikes,
 * 960s remaining) and THEN has its scan complete before losing a trailing
 * read must not have that 960s window overwritten down to a flat 60s. An
 * unconditional `.set` here would let one cheap trailing-read collision
 * de-escalate a row by up to 30x, and because the scan stays banked, the row
 * can oscillate between a genuine strike and a flat trailing timeout
 * indefinitely, pinned at the 60s floor instead of the ladder its own strikes
 * already earned. Never shortens, only ever holds or extends.
 *
 * It deliberately does NOT touch `repairTimeoutStrikes`: this row's strike
 * count is preserved exactly as it was, so a LATER genuine first-page scan
 * timeout on this same row (e.g. after a source mutation invalidates the
 * banked prefix) resumes escalation from strike N+1, not a reset to strike 1
 * — a completed-scan trailing collision must not erase strikes this row has
 * already earned, any more than it should erase the backoff window they
 * bought.
 */
function noteRepairTimeoutAfterCompletedScan(connectorInstanceId: string): void {
  const existingBackoffUntil = repairTimeoutBackoffUntil.get(connectorInstanceId) ?? 0;
  const flatBackoffUntil = Date.now() + repairTimeoutBackoffBaseMs();
  repairTimeoutBackoffUntil.set(connectorInstanceId, Math.max(existingBackoffUntil, flatBackoffUntil));
  console.error(
    `[connector-summary-evidence] repair for ${connectorInstanceId} completed its canonical scan but a trailing read was then cancelled by statement_timeout; backing off at least ${Math.round(repairTimeoutBackoffBaseMs() / 1000)}s (flat, never escalating further, never shortening an existing window — the expensive scan work is already banked)`
  );
}

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
  /**
   * A repair unit's own pre-transaction read was cancelled by Postgres
   * (`PostgresStatementTimeoutError`, SQLSTATE 57014) under the per-unit
   * `statement_timeout` bound (design review P1-2) — the bound working as
   * designed under load, NOT a defect in this connection's own canonical
   * facts. Distinct from `RECORD_SNAPSHOT_FAILED` so an operator (or a
   * later reconcile pass) can tell "this row's data is suspect" apart from
   * "this row's read was merely cancelled by scheduling pressure and is
   * still exactly as trustworthy as it was before this attempt."
   */
  STATEMENT_TIMEOUT: "repair_statement_timeout",
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
  // A direct writer that mutates `records` without allocating a version
  // (bypassing the normal ingest/reset paths that advance `version_counter`
  // or `record_reset_generation`) used to be caught ONLY by a supplementary
  // `SELECT COUNT(*) ... GROUP BY connector_instance_id` full-table scan run
  // here on every discovery pass — see git history for
  // `readPostgresDiscoveryContext`'s removed `canonicalCountResult` (measured
  // 3.3-6.1s / ~578k buffers against production's `records` table,
  // 2026-08-18). That scan is now REDUNDANT, not merely slow: every write to
  // `records`, on every path including a direct bypass writer, already fires
  // the unconditional row-level trigger `pdpp_source_revision_records`
  // (`ensurePostgresConnectorSummarySourceRevisionPrimitive` in
  // postgres-storage.ts; SQLite has the equivalent in db.ts), which advances
  // `connector_instances.source_revision` on INSERT, UPDATE, and DELETE
  // regardless of whether the writer also touched `version_counter`. The
  // `currentSourceRevision`/`source_revision_mismatch` comparison below
  // already detects that exact scenario incrementally, from a single-row
  // read already fetched for this pass, with no dependence on how many
  // records the connection has. Do not reintroduce a canonical
  // `records`-count aggregate in this hot path; a fact whose cost grows with
  // total row count belongs in an incrementally-maintained signal (like
  // `source_revision`) or a periodic audit, never a per-pass discovery read.
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
  // A fleet-wide `SELECT COUNT(*) ... GROUP BY connector_instance_id` over
  // `records` used to run here as a supplementary drift check (see
  // `classifyCandidate`'s doc for why it was removed: `source_revision`,
  // driven by a row-level trigger on every write to `records`, already
  // catches the same direct-writer-bypass scenario incrementally). Removed
  // 2026-08-18 — do not reintroduce a canonical `records`-count aggregate in
  // this hot path.
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
  // Per-key MAX rather than a GROUP BY aggregate, matching the Postgres
  // branch -- see the long rationale there. SQLite recognizes the same
  // `MAX(indexed_column)` shape as a backward index walk, so this keeps the
  // two backends structurally identical instead of leaving SQLite on the
  // formulation whose cost grows with total event count.
  const maxLifecycleSeqRows: Row[] = scoped
    ? db
        .prepare(
          `SELECT i.connector_instance_id,
                  (SELECT MAX(e.event_seq) FROM spine_events e
                    WHERE e.connector_instance_id = i.connector_instance_id) AS max_seq
             FROM connector_instances i
            WHERE i.connector_instance_id IN (${placeholders})`
        )
        // biome-ignore lint/style/noNonNullAssertion: The trusted boundary invariant is established by the preceding validation.
        .all(...connectorInstanceIds!)
    : db
        .prepare(
          `SELECT i.connector_instance_id,
                  (SELECT MAX(e.event_seq) FROM spine_events e
                    WHERE e.connector_instance_id = i.connector_instance_id) AS max_seq
             FROM connector_instances i`
        )
        .all();
  // See the Postgres branch: a connection with no lifecycle events now
  // yields NULL where the GROUP BY emitted no row, and `Number(null)` is 0.
  const maxLifecycleEventSeqByInstance = new Map(
    maxLifecycleSeqRows
      .filter((row) => row.max_seq !== null && row.max_seq !== undefined)
      .map((row) => [String(row.connector_instance_id), Number(row.max_seq)])
  );
  return {
    evidenceByInstance,
    instanceRows: instanceRows as Row[],
    manifestByConnector,
    maxLifecycleEventSeqByInstance,
    retainedByteByInstance,
    scheduleUpdatedAtByInstance,
    versionCountersByInstance,
  };
}

/**
 * Issues one discovery-context statement bounded by the caller's remaining
 * cooperative admission allowance (design review P1-2, per-unit hard
 * bound). `deadline === null` reproduces the exact prior unbounded-
 * `postgresQuery` behavior for every caller that does not pass one (every
 * consumer of `discoverCandidates` today except the maintenance sweep —
 * see `reconcileConnectorSummaryEvidence`'s doc).
 */
function postgresDiscoveryQuery<R extends Row = Row>(
  sql: string,
  params: unknown[],
  deadline: number | null
): Promise<{ rowCount: number | null; rows: R[] }> {
  if (deadline === null) {
    return postgresQuery<R>(sql, params);
  }
  const budget = remainingStatementBudgetMs(deadline);
  if (budget === null) {
    return postgresQuery<R>(sql, params);
  }
  // A depleted allowance must NOT reach `postgresQueryBounded`: Postgres reads
  // `statement_timeout = 0` as UNLIMITED, so passing it through would remove
  // the very bound this path exists to enforce. Refuse admission instead —
  // callers already treat `PostgresStatementTimeoutError` as "this round made
  // no progress on this unit; leave its evidence untouched and retry later".
  if (budget === 0) {
    throw new PostgresStatementTimeoutError();
  }
  return postgresQueryBounded<R>(sql, params, budget);
}

async function readPostgresDiscoveryContext(connectorInstanceIds: readonly string[] | null, deadline: number | null) {
  // `null` = complete census (unscoped). A non-null, EMPTY array is a
  // genuine "scoped to nothing" request; short-circuit rather than issue
  // `= ANY($1::text[])` with an empty bind array (which IS valid Postgres
  // and correctly matches zero rows for `instanceResult`, but the same
  // short-circuit as SQLite keeps both backends' empty-scope behavior
  // identical and avoids six no-op round-trips).
  if (connectorInstanceIds !== null && connectorInstanceIds.length === 0) {
    return {
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
    ? await postgresDiscoveryQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds],
        deadline
      )
    : await postgresDiscoveryQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_instances ORDER BY connector_instance_id ASC",
        [],
        deadline
      );
  // Evidence/retained-bytes/version-counter/canonical-count reads are scoped
  // to the SAME requested id set (one batched `ANY($1::text[])` query each,
  // not a complete table scan) when the caller narrowed the discovery —
  // matches the SQLite `IN (...)` batching above; a scoped consumer must
  // not pay for, or even read, every other connection's rows.
  const evidenceResult = scoped
    ? await postgresDiscoveryQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_summary_evidence WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds],
        deadline
      )
    : await postgresDiscoveryQuery(
        "SELECT *, source_revision::text AS source_revision_text FROM connector_summary_evidence",
        [],
        deadline
      );
  const evidenceByInstance = new Map(
    (evidenceResult.rows as Row[]).map((row) => [String(row.connector_instance_id), row])
  );
  const connectorIds = [...new Set((instanceResult.rows as Row[]).map((row) => String(row.connector_id)))];
  const connectorRows = await readPostgresConnectorManifests(connectorIds);
  const manifestByConnector = new Map(connectorRows.map((row) => [String(row.connector_id), String(row.manifest)]));
  const retainedByteResult = scoped
    ? await postgresDiscoveryQuery(
        "SELECT * FROM retained_size_connection WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds],
        deadline
      )
    : await postgresDiscoveryQuery("SELECT * FROM retained_size_connection", [], deadline);
  const retainedByteByInstance = new Map(
    (retainedByteResult.rows as Row[]).map((row) => [String(row.connector_instance_id), row])
  );
  const versionCounterResult = scoped
    ? await postgresDiscoveryQuery(
        "SELECT connector_instance_id, stream, max_version::text AS max_version FROM version_counter WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds],
        deadline
      )
    : await postgresDiscoveryQuery(
        "SELECT connector_instance_id, stream, max_version::text AS max_version FROM version_counter",
        [],
        deadline
      );
  const versionCountersByInstance = new Map<string, Row[]>();
  for (const row of versionCounterResult.rows as Row[]) {
    const instanceId = String(row.connector_instance_id);
    const list = versionCountersByInstance.get(instanceId) ?? [];
    list.push(row);
    versionCountersByInstance.set(instanceId, list);
  }
  // A fleet-wide `SELECT connector_instance_id, COUNT(*) ... GROUP BY
  // connector_instance_id` over `records WHERE deleted = FALSE` used to run
  // here as a supplementary drift check for a direct writer that mutates
  // `records` without allocating a version. Removed 2026-08-18 — it is
  // strictly redundant, not merely slow.
  //
  // Production, 2026-08-18 (two incidents against this same query): first
  // unbounded, contending with unrelated heavy I/O and alone consuming the
  // round's entire deadline; then, even bounded by `MIN_STATEMENT_TIMEOUT_MS`,
  // still measured 3.3-6.1s / ~578k buffers (~4.5 GB) read via `EXPLAIN
  // (ANALYZE, BUFFERS)` against production's `records` table (5.46M rows,
  // only 11 ever `deleted = true`, so that predicate has no selectivity to
  // exploit — the scan is inherent to grouping the live rows, not fixable by
  // indexing `deleted`). Because it was, at the time, the ONLY discovery
  // query without its own failure isolation, its cancellation threw past
  // `discoverCandidates` entirely — aborting classification for EVERY row in
  // the batch, including rows already unambiguously `dirty`. A durably-dirty
  // backlog got zero candidates selected, pass after pass: `repaired: 0` AND
  // `skipped: 0`, because nothing was ever classified, not merely deferred.
  // That was fixed by isolating this query's own cancellation (kept as a
  // historical/regression guard, see
  // connector-summary-evidence-canonical-count-cancel-isolation.test.ts),
  // but isolation only stopped the SYMPTOM: even successfully isolated, the
  // query still burned 3+ seconds of database time every ~2-second sweep
  // pass before being cancelled, and the count-drift comparison it fed
  // silently never ran.
  //
  // The root fix is that this query was never necessary: `source_revision`
  // (`connector_instances.source_revision`, advanced by the row-level
  // trigger `pdpp_source_revision_records` on every INSERT/UPDATE/DELETE to
  // `records`, regardless of whether the writer also allocated a
  // `version_counter` entry) already detects the exact same "direct writer
  // bypassed the normal ingest path" scenario, incrementally, from a
  // single-row read already fetched for this pass — see
  // `classifyCandidate`'s `source_revision_mismatch` comparison. A fact
  // whose cost grows with total row count (this query) belongs in an
  // incrementally-maintained signal (`source_revision`, which already
  // existed) or a periodic audit, never a per-pass discovery read. Do not
  // reintroduce a canonical `records`-count aggregate here.
  // Terminal-gate revision (2026-07-29): schedule mutations have NO existing
  // dirty-independent backstop — `connector_schedules.updated_at` is already
  // written atomically with every schedule mutation on both backends (a
  // durable repair receipt), just never compared. One batched read of
  // exactly the requested (or complete) scope.
  const scheduleResult = scoped
    ? await postgresDiscoveryQuery(
        "SELECT connector_instance_id, updated_at FROM connector_schedules WHERE connector_instance_id = ANY($1::text[])",
        [connectorInstanceIds],
        deadline
      )
    : await postgresDiscoveryQuery("SELECT connector_instance_id, updated_at FROM connector_schedules", [], deadline);
  const scheduleUpdatedAtByInstance = new Map(
    (scheduleResult.rows as Row[]).map((row) => [String(row.connector_instance_id), String(row.updated_at)])
  );
  // Terminal-gate revision (2026-07-29): run-lifecycle events (e.g.
  // `run.started`) have no existing dirty-independent backstop either. This
  // per-connection lifecycle receipt deliberately excludes terminal outcomes,
  // which are solely owned by the terminal-fold path.
  // Reuses the spine's own already-durable, atomically-assigned `event_seq`
  // as the repair receipt, scoped per connection.
  // Per-key MAX, never a GROUP BY aggregate over the matched events.
  //
  // `GROUP BY connector_instance_id` forces Postgres to READ EVERY EVENT for
  // every in-scope connection just to keep the largest `event_seq` of each.
  // That cost grows with total event count; the answer is 13-76 numbers.
  // Production, 2026-08-21 (`EXPLAIN (ANALYZE, BUFFERS)`, 1.49M-row / 19 GB
  // `spine_events`): the scoped GROUP BY form read 220,928 index rows with
  // 201,795 heap fetches in 5,490ms against a 500ms per-unit allowance --
  // an 11x overrun that cancelled discovery on EVERY pass, so
  // `candidates_inspected` was 0 and 13 durably-dirty rows never cleared.
  // Fleet health read 3 healthy / 24 while every underlying run had
  // succeeded. The unscoped form measured 1,617ms (parallel seq scan).
  //
  // The correlated per-key MAX lets the planner walk
  // `idx_pg_spine_events_instance_seq (connector_instance_id, event_seq)`
  // BACKWARD and stop at the first row per key -- one index descent per
  // connection instead of a full group scan. Measured on the same database:
  // scoped 5,490ms -> 17.6ms (312x), unscoped 1,617ms -> 19.4ms, heap
  // fetches 201,795 -> 13. `IS NOT NULL` inside the subquery keeps it an
  // index-only scan (NULLs sort last on a backward walk).
  //
  // Driving the unscoped form off `connector_instances` rather than off the
  // events themselves is behavior-preserving BECAUSE the resulting map is
  // only ever read as `.get(instanceId)` while looping `ctx.instanceRows`
  // (see `discoverCandidates`) -- an entry for an id with no instance row is
  // unreachable by construction. Verified on production: 48 such orphan ids
  // exist in `spine_events`, and comparing both formulations across every
  // real instance row returned zero differing values.
  //
  // Do not "simplify" this back into a GROUP BY: this is the same
  // cost-grows-with-row-count defect already removed from the canonical
  // `records` count above, in a second place.
  const maxLifecycleSeqResult = scoped
    ? await postgresDiscoveryQuery(
        `SELECT ids.connector_instance_id,
                (SELECT MAX(e.event_seq) FROM spine_events e
                  WHERE e.connector_instance_id = ids.connector_instance_id) AS max_seq
           FROM unnest($1::text[]) AS ids(connector_instance_id)`,
        [connectorInstanceIds],
        deadline
      )
    : await postgresDiscoveryQuery(
        `SELECT i.connector_instance_id,
                (SELECT MAX(e.event_seq) FROM spine_events e
                  WHERE e.connector_instance_id = i.connector_instance_id) AS max_seq
           FROM connector_instances i`,
        [],
        deadline
      );
  // A connection with no lifecycle events yields `max_seq = NULL` here,
  // whereas the previous GROUP BY simply emitted no row for it. Both must
  // become "absent from the map": `classifyCandidate` treats a present
  // `currentLifecycleEventSeq` as a real receipt to compare against, and
  // `Number(null)` is 0 -- which would pass its `!== null` guard and, since
  // any stored seq is `< 0` is false / `null` is true, could latch a
  // connection dirty on every pass. Drop the NULLs instead of coercing them.
  const maxLifecycleEventSeqByInstance = new Map(
    (maxLifecycleSeqResult.rows as Row[])
      .filter((row) => row.max_seq !== null && row.max_seq !== undefined)
      .map((row) => [String(row.connector_instance_id), Number(row.max_seq)])
  );
  return {
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
 *
 * `deadline`, when provided (only the maintenance sweep provides one — see
 * `reconcileConnectorSummaryEvidence`), bounds each Postgres statement in
 * this batch with a `SET LOCAL statement_timeout` derived from the caller's
 * remaining allowance (`postgresDiscoveryQuery`/`postgresQueryBounded`,
 * design review P1-2). SQLite's `better-sqlite3` driver is synchronous and
 * exposes no interrupt/progress-handler hook on its public API, so
 * `deadline` has no effect on the SQLite branch — an honest, disclosed gap,
 * not a silent no-op pretending to be a fix.
 */
async function discoverCandidates(
  connectorInstanceIds: readonly string[] | null,
  deadline: number | null = null
): Promise<{ instanceRows: readonly Row[]; candidates: ReadonlyMap<string, RepairCandidateReason> }> {
  const ctx = isPostgresStorageBackend()
    ? await readPostgresDiscoveryContext(connectorInstanceIds, deadline)
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
 * The DEFERRED-NOT-FAILED outcome: this unit consumed its turn and wrote
 * nothing.
 *
 * The row keeps its existing durable evidence untouched, is NOT marked
 * `failed`, stays `dirty`, and is retried on a later pass. A deferred result's
 * `row` is never recorded (`recordRepairOutcome` is skipped for `deferred`), so
 * the id-only row below asserts nothing about this connection's facts — it is a
 * shape, not a claim.
 *
 * Two callers share this exact contract, and the distinction between them
 * matters:
 *
 *   - a `PostgresStatementTimeoutError`, where the unit was CANCELLED and made
 *     no progress — that caller additionally arms `noteRepairTimeout`, because
 *     an un-paced retry of a doomed unit consumes every round.
 *   - a PARTIAL canonical scan, where the unit yielded with committed page
 *     boundaries banked. That caller deliberately does NOT arm the back-off:
 *     this unit achieved real, durable progress, and pacing productive work
 *     behind an exponential delay (capped at 30 minutes) would stall a whale
 *     that legitimately needs many passes — reintroducing the same starvation
 *     in a new form. Nothing was cancelled, so there is no strike to record.
 */
function deferredNotFailedRepairResult(connectorInstanceId: string): RepairedEvidence {
  return {
    deferred: true,
    failed: false,
    persisted: true,
    row: { connector_instance_id: connectorInstanceId },
  };
}

/**
 * Repair exactly one connection's evidence row under the shared
 * connector-instance writer fence: re-read canonical facts fresh (not the
 * pre-lock discovery snapshot) and upsert. On lock/read/write failure,
 * returns row-shaped `stale`/`failed` evidence with a closed sanitized
 * reason code — never a fabricated clean row.
 *
 * `deadline`, when provided, bounds every Postgres read this unit issues
 * BEFORE its writer-fenced transaction (design review P1-2: same per-unit
 * `statement_timeout` contract as `discoverCandidates`). The writer-fenced
 * transaction itself (`withPostgresTransaction`/`withConnectorInstanceWrite`)
 * is deliberately left unbounded here: it is already fenced to exactly one
 * connector instance's rows and is the durable commit point, so timing it
 * out mid-write would risk leaving `dirty = 1` set without ever clearing
 * it — trading a bounded pre-read for an unbounded correctness question.
 */
async function repairCandidate(connectorInstanceId: string, deadline: number | null = null): Promise<RepairedEvidence> {
  const backoffUntil = repairTimeoutBackoffUntil.get(connectorInstanceId);
  if (backoffUntil !== undefined && Date.now() < backoffUntil) {
    // `deferred` is the established "consumed its turn, wrote nothing" outcome
    // (see `repairCandidates`' attempt-order doc): the fairness cursor advances
    // past this id and its existing evidence is left exactly as-is.
    return deferredNotFailedRepairResult(connectorInstanceId);
  }
  try {
    const repaired = isPostgresStorageBackend()
      ? await repairCandidatePostgres(connectorInstanceId, deadline)
      : await repairCandidateSqlite(connectorInstanceId);
    // Clear the back-off ONLY on a real repair. A `deferred` result is not
    // success: the Postgres branch returns `deferred` for exactly the
    // statement_timeout case that just armed the back-off, so clearing here
    // unconditionally would disarm it one frame after it was set and leave
    // the unit retrying unpaced — the same production defect, relocated.
    if (!repaired.deferred) {
      repairTimeoutBackoffUntil.delete(connectorInstanceId);
      repairTimeoutStrikes.delete(connectorInstanceId);
    }
    return repaired;
  } catch (err) {
    // A `PostgresStatementTimeoutError` does NOT reach this catch on the
    // Postgres branch — `repairCandidatePostgres` handles and returns it
    // (that unreachability is why the original wiring never fired). It is
    // still armed here for the lock-acquisition path and any future branch
    // that lets the error propagate, so the throttle cannot be lost again
    // by a change in who catches what.
    if (err instanceof PostgresStatementTimeoutError) {
      noteRepairTimeout(connectorInstanceId);
    }
    logRepairFailure(connectorInstanceId, REASON_CODES.LOCK_UNAVAILABLE, err);
    const failedRow = buildFailedRow(connectorInstanceId, REASON_CODES.LOCK_UNAVAILABLE, err);
    // The lock itself could not be acquired, so nothing about this
    // connection's canonical facts was even re-read this attempt — total
    // failure, every component fails closed (see `buildFailedRow`).
    const persisted = await persistFailedEvidence(connectorInstanceId, failedRow);
    return { deferred: false, failed: true, persisted, row: failedRow };
  }
}

/**
 * The single place a caught repair/discovery error is classified against
 * `REASON_CODES` — so a genuine Postgres `statement_timeout` cancellation
 * (the per-unit HARD bound design review P1-2 requires, working as
 * designed under load) is never confused with a real data/connectivity
 * defect on that connection's own canonical facts. `defaultReasonCode` is
 * the caller's existing classification for every OTHER error shape
 * (`LOCK_UNAVAILABLE` for a lock-acquisition failure, `RECORD_SNAPSHOT_FAILED`
 * for a genuine repair-read/write failure).
 */
function reasonCodeForRepairFailure(err: unknown, defaultReasonCode: string): string {
  return err instanceof PostgresStatementTimeoutError ? REASON_CODES.STATEMENT_TIMEOUT : defaultReasonCode;
}

/**
 * Make a cancelled/failed repair or discovery unit LOUD (production,
 * 2026-08-18: a `PostgresStatementTimeoutError` cancelling discovery was
 * silently converted into `summary_discovery_failed` evidence with NO
 * console output anywhere — 25 rows degraded from `current` to `failed`
 * with nothing in the container logs to explain why). This module has no
 * injected structured logger (it is a library called from many contexts,
 * including tests, without one), so `console.error` with a bracketed module
 * tag is this codebase's established convention for a library-level module
 * without one (see e.g. `records.ts`'s `[records] ...` lines) — durable
 * evidence (`buildFailedRow`'s persisted reason code) and a console line are
 * complementary, not substitutes for each other.
 */
function logRepairFailure(connectorInstanceId: string, reasonCode: string, err: unknown): void {
  const sanitized = sanitizeProjectionError(err);
  if (reasonCode === REASON_CODES.STATEMENT_TIMEOUT) {
    console.error(
      `[connector-summary-evidence] repair for ${connectorInstanceId} cancelled by Postgres statement_timeout (per-unit bound, design review P1-2) — this row's evidence is left as-is, not marked failed, and will be retried on a later pass: ${sanitized}`
    );
    return;
  }
  console.error(`[connector-summary-evidence] repair for ${connectorInstanceId} failed (${reasonCode}): ${sanitized}`);
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
    // disposable orphan and the saved scan position cannot be resumed after
    // the canonical row is gone.
    exec(referenceQueries.connectorInstancesDeleteSummaryEvidenceByConnectorInstance, [connectorInstanceId]);
    deleteSqliteRepairChunk(db, connectorInstanceId);
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
    await query("DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1", [
      connectorInstanceId,
    ]);
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

// ---------------------------------------------------------------------------
// Chunked/resumable canonical-count scan (whale repair)
//
// `records WHERE connector_instance_id = ? AND deleted = false GROUP BY
// stream` is index-covered (`idx_pg_records_canonical_count`) but its cost is
// still O(live rows for that ONE connection): a connection with millions of
// live records (Slack 1.57M, a Claude Code connection 2.5M, a Codex
// connection 1.3M, measured on the owner's instance 2026-08-26) cannot
// finish that single aggregate inside the `MIN_STATEMENT_TIMEOUT_MS` floor —
// af114c250 stops the resulting doomed re-admission from starving every
// other dirty row, but does not make the whale's own row ever converge.
//
// The fix scans the same rows via `idx_pg_records_instance_deleted_id
// (connector_instance_id, deleted, id)` as a keyset-paginated `id`
// range instead of one unbounded aggregate, folding each page into a durable
// per-stream accumulator (`connector_summary_evidence_repair_chunk`) that
// resumes across as many admissions as it takes. This is strictly additive
// bounded progress, never a bigger budget: every page uses the EXISTING,
// unraised `MIN_STATEMENT_TIMEOUT_MS`/2000ms bound, and a timed-out page
// teaches the next admission a smaller limit.
// ---------------------------------------------------------------------------

interface StreamAccumulatorEntry {
  readonly last_updated: string | null;
  readonly record_count: number;
}

type StreamAccumulator = Record<string, StreamAccumulatorEntry>;

interface CanonicalScanPageRow {
  readonly emitted_at: string | null;
  readonly id: number;
  readonly stream: string;
}

/**
 * Fold exactly one page of raw `records` rows into a running per-stream
 * accumulator. Pure — no I/O — so both backends share one accumulation
 * algorithm and cannot silently diverge (the same "shared by both backends"
 * principle `shouldSkipFailedEvidencePublication` already applies to failure
 * publication above).
 */
function foldCanonicalScanPage(
  accumulator: StreamAccumulator,
  page: readonly CanonicalScanPageRow[]
): StreamAccumulator {
  const next: StreamAccumulator = { ...accumulator };
  for (const row of page) {
    const existing = next[row.stream];
    const lastUpdated =
      row.emitted_at && (!existing?.last_updated || row.emitted_at > existing.last_updated)
        ? row.emitted_at
        : (existing?.last_updated ?? null);
    next[row.stream] = {
      last_updated: lastUpdated,
      record_count: (existing?.record_count ?? 0) + 1,
    };
  }
  return next;
}

/** Convert the finished accumulator into the `{stream, record_count, last_updated}` Row shape `buildRepairedRow`'s `canonicalByStream` already expects — no change to `buildRepairedRow` itself. */
function canonicalByStreamFromAccumulator(accumulator: StreamAccumulator): Map<string, Row> {
  return new Map(
    Object.entries(accumulator).map(([stream, entry]) => [
      stream,
      { last_updated: entry.last_updated, record_count: entry.record_count, stream },
    ])
  );
}

function readSqliteRepairChunk(db: Db, connectorInstanceId: string): Row | undefined {
  return db
    .prepare(
      "SELECT resume_after_id, accumulator_json, source_revision, page_size, started_at FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = ?"
    )
    .get(connectorInstanceId) as Row | undefined;
}

function deleteSqliteRepairChunk(db: Db, connectorInstanceId: string): void {
  db.prepare("DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = ?").run(
    connectorInstanceId
  );
}

function persistSqliteRepairChunk(
  connectorInstanceId: string,
  resumeAfterId: number,
  accumulator: StreamAccumulator,
  sourceRevision: string,
  startedAt: string,
  pageSize: number
): void {
  const now = nowIso();
  execDynamicSqlAcknowledged(
    `INSERT INTO connector_summary_evidence_repair_chunk(
       connector_instance_id, resume_after_id, accumulator_json, source_revision, started_at, updated_at, page_size
     ) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connector_instance_id) DO UPDATE SET
       resume_after_id = excluded.resume_after_id,
       accumulator_json = excluded.accumulator_json,
       source_revision = excluded.source_revision,
       page_size = excluded.page_size,
       updated_at = excluded.updated_at`,
    [
      connectorInstanceId,
      resumeAfterId,
      JSON.stringify(accumulator),
      sourceRevision,
      startedAt,
      now,
      pageSize,
    ] as BindValue[]
  );
}

/**
 * Test-only override for `CHUNK_SCAN_PAGE_SIZE` on the SQLite path. SQLite
 * has no `statement_timeout`/`deadline` to force an early return, so a
 * production SQLite scan always completes in one call regardless of page
 * size — this exists solely so a test can force MULTIPLE pages (and,
 * combined with `PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL`,
 * multiple separate admissions) over a small fixture without needing a
 * literal multi-million-row table to prove resumability. A complete no-op
 * unless set (never set in production).
 */
function sqliteChunkScanPageSize(): number {
  const raw = process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_CHUNK_PAGE_SIZE;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CHUNK_SCAN_PAGE_SIZE;
}

/**
 * Test-only: when set, `scanSqliteCanonicalStreams` persists its chunk state
 * and returns after exactly ONE page instead of looping to completion —
 * simulating a separate admission/sweep pass the way the Postgres path's
 * `deadline` naturally does. A complete no-op unless set (never set in
 * production, where SQLite has no deadline to force early return at all).
 */
function sqliteChunkScanOnePagePerCall(): boolean {
  return process.env.PDPP_TEST_REPAIR_CANDIDATE_SQLITE_ONE_PAGE_PER_CALL === "1";
}

/**
 * Scan `records` for one connection in page-size-sized pages, keyed by `id`,
 * resuming from a durable chunk row when a prior admission left one in
 * progress. In production this always
 * completes in one call — SQLite has no `deadline` to force an early
 * return — but shares the identical accumulation/persistence primitives the
 * Postgres path uses so the two backends cannot silently diverge, and a
 * test-only knob (`sqliteChunkScanOnePagePerCall`) can force the same
 * multi-admission resumability the Postgres path exercises in production.
 *
 * The receipt's resumability is deliberately independent of the broad
 * `sourceRevision`: the `records` source-revision triggers delete it when a
 * mutation touches its proven id prefix, while an append above the boundary
 * preserves it. That narrower invalidation is what makes append progress
 * safe without repeatedly restarting a whale scan.
 */
function scanSqliteCanonicalStreams(
  db: Db,
  connectorInstanceId: string,
  sourceRevision: string
): { readonly canonicalByStream: Map<string, Row>; readonly complete: boolean } {
  const pageSize = sqliteChunkScanPageSize();
  const onePagePerCall = sqliteChunkScanOnePagePerCall();
  const existingChunk = readSqliteRepairChunk(db, connectorInstanceId);
  const resumable = existingChunk !== undefined;
  let resumeAfterId = resumable ? Number(existingChunk?.resume_after_id ?? 0) : 0;
  let accumulator: StreamAccumulator = resumable
    ? parseJsonColumn<StreamAccumulator>(existingChunk?.accumulator_json, {})
    : {};
  const startedAt = resumable && typeof existingChunk?.started_at === "string" ? existingChunk.started_at : nowIso();

  for (;;) {
    const page = db
      .prepare(
        `SELECT id, stream, emitted_at FROM records
          WHERE connector_instance_id = ? AND deleted = 0 AND id > ?
          ORDER BY id ASC LIMIT ?`
      )
      .all(connectorInstanceId, resumeAfterId, pageSize) as CanonicalScanPageRow[];
    if (page.length === 0) {
      break;
    }
    accumulator = foldCanonicalScanPage(accumulator, page);
    resumeAfterId = page.at(-1)?.id ?? resumeAfterId;
    const exhausted = page.length < pageSize;
    if (exhausted) {
      break;
    }
    if (onePagePerCall) {
      persistSqliteRepairChunk(connectorInstanceId, resumeAfterId, accumulator, sourceRevision, startedAt, pageSize);
      return { canonicalByStream: canonicalByStreamFromAccumulator(accumulator), complete: false };
    }
  }
  deleteSqliteRepairChunk(db, connectorInstanceId);
  return { canonicalByStream: canonicalByStreamFromAccumulator(accumulator), complete: true };
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
      // Intentionally KEEPS the manifest/generation/streams reads BEFORE the
      // scan here, unlike `repairCandidatePostgres` (which moved the
      // equivalent reads to AFTER its scan). That reorder exists solely to
      // conserve Postgres's per-unit `statement_timeout` admission budget
      // (`postgresRepairReadQuery`/`remainingStatementBudgetMs`) across a
      // chunked, multi-admission scan that can itself exhaust it. Neither
      // condition applies here: `better-sqlite3` is synchronous with no
      // deadline to conserve (there is no `deadline` parameter on this
      // function at all), and `scanSqliteCanonicalStreams` runs to completion
      // in one call — there is no budget to protect and nothing this
      // ordering could win by moving. Read order therefore stays whichever
      // one was simplest to write, and this branch is fenced by the exact
      // same publication CAS (`writeTransaction` below) regardless of order.
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
      const canonicalScan = scanSqliteCanonicalStreams(db, connectorInstanceId, sourceRevision);
      if (!canonicalScan.complete) {
        // Test-only path (`sqliteChunkScanOnePagePerCall`): this admission's
        // scan persisted its resume point and stopped short of the keyset —
        // the SAME "consumed its turn, wrote nothing to evidence, retried
        // next pass" outcome the Postgres path's `PostgresStatementTimeoutError`
        // branch returns. Production SQLite never takes this branch (no
        // deadline forces an early return), so it is unreachable outside
        // tests.
        return {
          deferred: true,
          failed: false,
          persisted: true,
          row: { connector_instance_id: connectorInstanceId },
        };
      }
      const { canonicalByStream } = canonicalScan;
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
            `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', source_revision = ?, list_summary_projection_reason_code = ?, last_error = NULL WHERE connector_instance_id = ?`,
            [sourceRevision, sourceRevisionDeferredReason(Boolean(activeRun), sourceRevision), connectorInstanceId]
          );
        } else {
          upsertSqliteEvidenceRow(db, built);
        }
        return { deferred, failed: false, persisted: true, row: built };
      })
    );
  } catch (err) {
    // `PostgresStatementTimeoutError` cannot occur on this branch —
    // `better-sqlite3` has no interrupt/progress-handler hook, so nothing
    // here can be cancelled — but `reasonCodeForRepairFailure` is still
    // used (rather than a bare constant) so both backends share one
    // classification path and cannot silently diverge if that ever changes.
    logRepairFailure(connectorInstanceId, reasonCodeForRepairFailure(err, REASON_CODES.RECORD_SNAPSHOT_FAILED), err);
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

/**
 * Repair's own pre-transaction reads are always scoped to exactly ONE
 * `connector_instance_id` (unlike discovery's optionally-unscoped batch), so
 * these were never full-table scans — but they still carried no
 * statement-level bound (design review P1-2): a slow one (e.g. lock
 * contention on `records`) could still consume the round's remaining
 * allowance on its own. Bounded the same way as `postgresDiscoveryQuery`;
 * `deadline === null` (every caller except the maintenance sweep)
 * reproduces the exact prior behavior.
 */
function postgresRepairReadQuery<R extends Row = Row>(
  sql: string,
  params: unknown[],
  deadline: number | null
): Promise<{ rowCount: number | null; rows: R[] }> {
  testOnlyThrowStatementTimeoutAtStage(sql);
  if (deadline === null) {
    return postgresQuery<R>(sql, params);
  }
  const budget = remainingStatementBudgetMs(deadline);
  if (budget === null) {
    return postgresQuery<R>(sql, params);
  }
  // A depleted allowance must NOT reach `postgresQueryBounded`: Postgres reads
  // `statement_timeout = 0` as UNLIMITED, so passing it through would remove
  // the very bound this path exists to enforce. Refuse admission instead —
  // callers already treat `PostgresStatementTimeoutError` as "this round made
  // no progress on this unit; leave its evidence untouched and retry later".
  if (budget === 0) {
    throw new PostgresStatementTimeoutError();
  }
  return postgresQueryBounded<R>(testOnlySlowRepairRead(sql), params, budget);
}

/**
 * Test-only: make a repair unit's own read genuinely slow, so Postgres itself
 * cancels it under the real per-unit bound. Production is a no-op (the env var
 * is unset), matching this file's existing seam convention
 * (`PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS`, `PDPP_TEST_REPAIR_FAILURE_*`).
 *
 * This exists because the condition is otherwise unreachable in a test: a
 * scratch row's repair finishes far inside the 500ms floor, while production
 * only times out on connections holding ~1.3M records. Faking the error
 * instead — or mirroring the handler's contract — is what let a back-off ship
 * wired to an unreachable catch (2026-08-26); the timeout has to be REAL, from
 * Postgres, on the real call path.
 *
 * The sleep runs in a leading CTE so it costs real server time while the
 * original statement — and therefore the caller's result shape — is returned
 * completely unchanged.
 */
const LEADING_SELECT_PATTERN = /^\s*select\b/i;

// Test-only per-admission call counter for `PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT`
// (below). Production never reads it (the env var is unset), matching this
// file's every other test seam.
let testOnlyCanonicalScanPageCallCount = 0;

/**
 * Test-only: reset the page-call counter between admissions so a prior
 * admission's page count cannot leak into the next one's "after page N"
 * seam. A complete no-op unless a test imports and calls it directly.
 */
export function __resetTestOnlyCanonicalScanPageCallCountForTest(): void {
  testOnlyCanonicalScanPageCallCount = 0;
}

/**
 * Test-only: read the page-call counter without resetting it. Lets a
 * deterministic ordering test assert the canonical scan actually ran (one or
 * more `records` page queries were issued) DURING an admission whose
 * publication was blocked by an unrelated failing read elsewhere in the same
 * call — a fact that cannot be inferred from the admission's return value or
 * from durable evidence state alone, since a blocked publication leaves
 * neither of those changed regardless of whether the scan ran first.
 */
export function __testOnlyCanonicalScanPageCallCount(): number {
  return testOnlyCanonicalScanPageCallCount;
}

function testOnlySlowRepairRead(sql: string): string {
  const isCanonicalPageQuery =
    LEADING_SELECT_PATTERN.test(sql) &&
    sql.includes("FROM records") &&
    sql.includes("ORDER BY connector_instance_id ASC, deleted ASC, id ASC LIMIT $3");
  if (isCanonicalPageQuery) {
    testOnlyCanonicalScanPageCallCount += 1;
  }
  const canonicalSecondsRaw = process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_SECONDS;
  const canonicalSeconds = canonicalSecondsRaw ? Number.parseFloat(canonicalSecondsRaw) : 0;
  const canonicalLimitRaw = process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_MIN_LIMIT;
  const canonicalLimit = canonicalLimitRaw ? Number.parseInt(canonicalLimitRaw, 10) : 0;
  if (
    isCanonicalPageQuery &&
    Number.isFinite(canonicalSeconds) &&
    canonicalSeconds > 0 &&
    Number.isSafeInteger(canonicalLimit) &&
    canonicalLimit > 0
  ) {
    return `WITH pdpp_test_slow_read AS MATERIALIZED (
               SELECT pg_sleep(${canonicalSeconds}) AS slept
                WHERE $3 >= ${canonicalLimit}
             ),
             pdpp_test_original AS (${sql})
        SELECT pdpp_test_original.* FROM pdpp_test_original
         WHERE (SELECT count(*) FROM pdpp_test_slow_read) >= 0`;
  }
  // `PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT`: slows only the page
  // whose 1-based call count is STRICTLY GREATER than this value, unlike the
  // `MIN_LIMIT` seam above which keys off the page size and so cannot
  // discriminate an early page from a later one when the size is constant
  // across an admission. Needed to reproduce the exact production shape
  // (2026-08-28, `cin_ece4bfe5096b8bf67a1468c2`): page 1 commits a durable
  // boundary, then page 2 of the SAME admission is cancelled by Postgres —
  // proving a timeout after banked progress is possible, not only a timeout
  // on a call's first page.
  const afterPageCountRaw = process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT;
  const afterPageCount = afterPageCountRaw ? Number.parseInt(afterPageCountRaw, 10) : Number.NaN;
  if (
    isCanonicalPageQuery &&
    Number.isSafeInteger(afterPageCount) &&
    afterPageCount > 0 &&
    testOnlyCanonicalScanPageCallCount > afterPageCount &&
    Number.isFinite(canonicalSeconds) &&
    canonicalSeconds > 0
  ) {
    return `WITH pdpp_test_slow_read AS MATERIALIZED (SELECT pg_sleep(${canonicalSeconds}) AS slept),
             pdpp_test_original AS (${sql})
        SELECT pdpp_test_original.* FROM pdpp_test_original
         WHERE (SELECT count(*) FROM pdpp_test_slow_read) >= 0`;
  }
  const raw = process.env.PDPP_TEST_SLOW_REPAIR_READ_SECONDS;
  const seconds = raw ? Number.parseFloat(raw) : 0;
  // Only the repair unit's own `connector_instances` read is slowed. Wrapping
  // every statement that flows through here also rewrote the advisory-lock
  // acquisition query, which recursed in `tryAcquire` — the seam must target
  // exactly the read whose cancellation this test is about, and leave the
  // lock/transaction machinery alone.
  if (
    Number.isFinite(seconds) &&
    seconds > 0 &&
    LEADING_SELECT_PATTERN.test(sql) &&
    sql.includes("FROM connector_instances")
  ) {
    return `WITH pdpp_test_slow_read AS MATERIALIZED (SELECT pg_sleep(${seconds}) AS slept),
               pdpp_test_original AS (${sql})
          SELECT pdpp_test_original.* FROM pdpp_test_original
          WHERE (SELECT count(*) FROM pdpp_test_slow_read) >= 0`;
  }
  return sql;
}

/**
 * Test-only, deterministic: throw a REAL `PostgresStatementTimeoutError` the
 * instant a specific named repair-read stage is reached, instead of racing a
 * real `pg_sleep` against the per-unit deadline.
 *
 * `repairCandidatePostgres`'s pre-scan/post-scan ordering and the
 * completed-scan-vs-not backoff distinction (`canonicalScanCompletedThisAttempt`)
 * are both about WHICH read fails, not about how long any read takes — a
 * wall-clock race (`pg_sleep` vs. a short admission window) proves the same
 * claim only probabilistically, at the mercy of scheduler/network jitter on
 * ~30-900 sequential real round trips. This seam instead throws synchronously
 * and unconditionally once the caller-identified stage's query is about to
 * run, so the same test produces the same outcome on every run.
 *
 * `PDPP_TEST_THROW_STATEMENT_TIMEOUT_AT_STAGE` names exactly one stage:
 *   - `"streams_read"`: the `version_counter` read `repairCandidatePostgres`
 *     issues to build `checkpoint`. Chosen because it is one of the three
 *     reads the ordering fix moved (with `connectors`/manifest and
 *     `connector_instances`/generation) from before the canonical scan to
 *     after it. Throwing HERE, unconditionally, deterministically proves two
 *     independent things without any timing dependency:
 *       (a) whether the canonical scan ran BEFORE this read fires — if the
 *           read still ran first (pre-fix ordering), the scan never starts
 *           and no page's boundary is ever banked; if the scan runs first
 *           (post-fix), its pages commit their durable boundary regardless
 *           of what this read does afterward.
 *       (b) once the scan HAS completed, whether the resulting timeout is
 *           classified as a completed-scan timeout (flat backoff) or a
 *           from-scratch one (escalating backoff).
 *   - `"instance_read"`: the VERY FIRST read `repairCandidatePostgres` issues
 *     (`connector_instances` by id, selecting `source_revision_text`). This
 *     throw happens before the canonical scan is even reachable — a genuine,
 *     zero-progress, first-page-equivalent timeout, deterministically arming
 *     `noteRepairTimeout`'s ESCALATING strikes. Needed to test that a later
 *     completed-scan timeout (`noteRepairTimeoutAfterCompletedScan`) never
 *     shortens a backoff window this strike ladder already earned — a claim
 *     that requires a row with genuine strikes already on it, which
 *     `"streams_read"` alone cannot produce (it always fires after or in
 *     place of a completed scan, never as a from-scratch timeout).
 *
 * Production is a no-op — the env var is unset — matching this file's other
 * test-only seams (`PDPP_TEST_REPAIR_CANDIDATE_SQLITE_DELAY_MS`,
 * `PDPP_TEST_REPAIR_FAILURE_*`).
 */
function testOnlyThrowStatementTimeoutAtStage(sql: string): void {
  const stage = process.env.PDPP_TEST_THROW_STATEMENT_TIMEOUT_AT_STAGE;
  if (!stage) {
    return;
  }
  const isStreamsRead = LEADING_SELECT_PATTERN.test(sql) && sql.includes("FROM version_counter");
  if (stage === "streams_read" && isStreamsRead) {
    throw new PostgresStatementTimeoutError();
  }
  const isInstanceRead =
    LEADING_SELECT_PATTERN.test(sql) &&
    sql.includes("source_revision_text FROM connector_instances WHERE connector_instance_id = $1") &&
    !sql.includes("FOR UPDATE");
  if (stage === "instance_read" && isInstanceRead) {
    throw new PostgresStatementTimeoutError();
  }
}

/**
 * Run one page-transaction statement under the existing per-unit statement budget.
 * `postgresQueryBounded` cannot be used here because it owns a different
 * transaction; this helper keeps the timeout local to the caller's already
 * fenced page transaction and preserves the same SQLSTATE-57014 contract.
 */
async function postgresRepairTransactionQuery<R extends Row = Row>(
  client: Db,
  sql: string,
  params: unknown[],
  deadline: number | null
): Promise<{ rowCount: number | null; rows: R[] }> {
  try {
    if (deadline !== null) {
      const budget = remainingStatementBudgetMs(deadline);
      if (budget === 0) {
        throw new PostgresStatementTimeoutError();
      }
      if (budget !== null) {
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(budget))}`);
      }
    }
    const result = (await client.query(testOnlySlowRepairRead(sql), params)) as {
      rowCount: number | null;
      rows: R[];
    };
    return { rowCount: result.rowCount, rows: result.rows };
  } catch (err) {
    const statementTimeout = asPostgresStatementTimeoutError(err);
    if (statementTimeout) {
      throw statementTimeout;
    }
    throw err;
  }
}

async function upsertPostgresRepairChunk(
  client: Db,
  connectorInstanceId: string,
  resumeAfterId: number,
  accumulator: StreamAccumulator,
  sourceRevision: string,
  startedAt: string,
  pageSize: number,
  deadline: number | null
): Promise<void> {
  // Merge of two concurrent fixes. `page_size` is fa3a79f1a's adaptive page
  // size, persisted so a whale converges on the largest page ITS database can
  // serve. The write runs through `postgresRepairTransactionQuery` on the
  // CALLER's already-fenced page transaction rather than opening its own
  // `withConnectorInstanceWrite`/`withPostgresTransaction`: the page fence is
  // what makes the boundary atomic with the fold, and nesting a second
  // transaction inside it would break that atomicity.
  await postgresRepairTransactionQuery(
    client,
    `INSERT INTO connector_summary_evidence_repair_chunk(
       connector_instance_id, resume_after_id, accumulator_json, source_revision, started_at, updated_at, page_size
     ) VALUES($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       resume_after_id = EXCLUDED.resume_after_id,
       accumulator_json = EXCLUDED.accumulator_json,
       source_revision = EXCLUDED.source_revision,
       page_size = EXCLUDED.page_size,
       updated_at = EXCLUDED.updated_at`,
    [connectorInstanceId, resumeAfterId, JSON.stringify(accumulator), sourceRevision, startedAt, nowIso(), pageSize],
    deadline
  );
}

async function deletePostgresRepairChunk(connectorInstanceId: string, client?: Db): Promise<void> {
  const sql = "DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1";
  if (client) {
    await client.query(sql, [connectorInstanceId]);
    return;
  }
  await postgresQuery(sql, [connectorInstanceId]);
}

type PostgresCanonicalScanPageResult =
  | {
      readonly accumulator: StreamAccumulator;
      readonly complete: boolean;
      readonly missing: false;
    }
  | { readonly missing: true };

async function readAndPersistPostgresCanonicalScanPage(
  client: Db,
  connectorInstanceId: string,
  deadline: number | null
): Promise<PostgresCanonicalScanPageResult> {
  const instanceResult = await postgresRepairTransactionQuery(
    client,
    "SELECT source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
    [connectorInstanceId],
    deadline
  );
  const sourceRevision = decimalText((instanceResult.rows[0] as Row | undefined)?.source_revision_text);
  if (sourceRevision === null) {
    await postgresRepairTransactionQuery(
      client,
      "DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1",
      [connectorInstanceId],
      deadline
    );
    return { missing: true };
  }
  const chunkResult = await postgresRepairTransactionQuery(
    client,
    "SELECT resume_after_id, accumulator_json, started_at, page_size FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1",
    [connectorInstanceId],
    deadline
  );
  const existingChunk = chunkResult.rows[0] as Row | undefined;
  let resumeAfterId = existingChunk ? Number(existingChunk.resume_after_id ?? 0) : 0;
  let accumulator: StreamAccumulator = existingChunk
    ? parseJsonColumn<StreamAccumulator>(existingChunk.accumulator_json, {})
    : {};
  const startedAt = existingChunk && typeof existingChunk.started_at === "string" ? existingChunk.started_at : nowIso();
  // fa3a79f1a's adaptive page size, carried on the receipt. A page that could
  // not finish inside the bound persists a HALVED size (below), so the next
  // admission retries smaller instead of re-running the same doomed LIMIT.
  const pageSize = normalizedChunkScanPageSize(existingChunk?.page_size);
  let recordsResult: { rowCount: number | null; rows: Row[] };
  try {
    // The leading equality keys preserve the public id order while making the
    // required btree order explicit to PostgreSQL.
    recordsResult = await postgresRepairTransactionQuery<Row>(
      client,
      `SELECT id, stream, emitted_at FROM records
        WHERE connector_instance_id = $1 AND deleted = FALSE AND id > $2
        ORDER BY connector_instance_id ASC, deleted ASC, id ASC LIMIT $3`,
      [connectorInstanceId, resumeAfterId, pageSize],
      deadline
    );
  } catch (err) {
    if (err instanceof PostgresStatementTimeoutError) {
      // Shrink for next time, seeding a receipt when none exists yet. The FIRST
      // timeout is the case that matters: without a seeded row the scan repeats
      // the same oversized LIMIT forever. The write happens outside this
      // rolling-back transaction; nothing here raises or extends the timeout.
      await recordReducedPostgresRepairChunkPageSize(connectorInstanceId, pageSize, sourceRevision);
    }
    throw err;
  }
  const page = (recordsResult.rows as Row[]).map((row) => ({
    emitted_at: (row.emitted_at as string | null) ?? null,
    id: Number(row.id),
    stream: String(row.stream),
  }));
  if (page.length === 0) {
    return { accumulator, complete: true, missing: false };
  }
  accumulator = foldCanonicalScanPage(accumulator, page);
  resumeAfterId = page.at(-1)?.id ?? resumeAfterId;
  await upsertPostgresRepairChunk(
    client,
    connectorInstanceId,
    resumeAfterId,
    accumulator,
    sourceRevision,
    startedAt,
    pageSize,
    deadline
  );
  return { accumulator, complete: page.length < pageSize, missing: false };
}

/**
 * Persist the shrunken page size OUTSIDE the page transaction that is rolling
 * back, SEEDING a receipt when none exists yet.
 *
 * This is what got the first attempt reverted (`26584aebe`: "did not pass its
 * live PostgreSQL acceptance gate"). The earlier version ran only when a
 * receipt already existed and issued a bare `UPDATE`, which is a no-op on the
 * FIRST timeout — precisely the case that matters. A whale whose very first
 * page cannot finish inside the bound therefore persisted nothing, restarted
 * from id 0 on every admission, and never converged: the exact defect this
 * change exists to fix, reintroduced by its own recovery path.
 *
 * The seeded row is deliberately a ZERO-progress receipt (`resume_after_id 0`,
 * empty accumulator). It claims no scanned prefix — it only records the
 * page size this database proved it cannot serve, so the next admission
 * retries smaller instead of repeating the same doomed LIMIT. `source_revision`
 * is written so the receipt is subject to the same prefix-invalidation rules as
 * any other; it is never a shortcut around them.
 *
 * Still best-effort: failing to record the shrink must never mask the original
 * timeout, which the caller rethrows as the deferred-not-failed signal.
 */
async function recordReducedPostgresRepairChunkPageSize(
  connectorInstanceId: string,
  pageSize: number,
  sourceRevision: string | null
): Promise<void> {
  try {
    const reduced = reducedChunkScanPageSize(pageSize);
    const now = nowIso();
    await postgresQuery(
      `INSERT INTO connector_summary_evidence_repair_chunk(
         connector_instance_id, resume_after_id, accumulator_json, source_revision, started_at, updated_at, page_size
       ) VALUES($1, 0, '{}'::jsonb, $2, $3, $3, $4)
       ON CONFLICT (connector_instance_id) DO UPDATE SET
         page_size = EXCLUDED.page_size,
         updated_at = EXCLUDED.updated_at`,
      [connectorInstanceId, sourceRevision ?? "0", now, reduced]
    );
  } catch {
    // Best effort. Failing to shrink must never mask the original timeout,
    // which the caller is about to rethrow as the deferred-not-failed signal.
  }
}

async function scanPostgresCanonicalStreamsPage(
  connectorInstanceId: string,
  deadline: number | null
): Promise<PostgresCanonicalScanPageResult> {
  try {
    return await withConnectorInstanceWrite(connectorInstanceId, async () =>
      withPostgresTransaction(
        (client: Db) => readAndPersistPostgresCanonicalScanPage(client, connectorInstanceId, deadline),
        { lockConnectorInstanceId: connectorInstanceId }
      )
    );
  } catch (err) {
    // `SET LOCAL statement_timeout` remains active for the receipt upsert
    // after the bounded page read. Translate a cancellation from any
    // statement in this transaction, not only from the read helper.
    const statementTimeout = asPostgresStatementTimeoutError(err);
    if (statementTimeout) {
      throw statementTimeout;
    }
    throw err;
  }
}

/**
 * Scan `records` for one connection in ADAPTIVE pages via
 * `idx_pg_records_instance_deleted_id (connector_instance_id, deleted, id)`,
 * resuming from a durable chunk row when a prior admission left one in
 * progress. Each page runs in its own short transaction: it locks the
 * `connector_instances` row before it reads records, reloads the chunk under
 * that fence, folds one page, and upserts the new boundary before releasing
 * the lock.
 *
 * This carries BOTH concurrent fixes to this mechanism, which are
 * complementary and neither of which alone is sufficient:
 *
 *   - fa3a79f1a: the page size is not a promise every database can serve that
 *     many rows inside the bound, so a timeout halves it in the durable
 *     receipt and the whale converges on the largest page it CAN serve —
 *     without raising the per-unit timeout.
 *   - 331fc20cc: resumption is NO LONGER conditioned on the chunk's
 *     `source_revision` still matching. That revision is bumped by a trigger
 *     on every records INSERT/UPDATE/DELETE, so an ordinary append discarded a
 *     receipt the append could not corrupt, restarting the scan at 0 forever
 *     under continuous ingestion. Invalidation is now PREFIX-SCOPED: the
 *     records trigger deletes the chunk only when a write touches
 *     `id <= resume_after_id`, so an append survives while a prefix mutation
 *     makes the next page restart at zero.
 *
 * `source_revision` is still WRITTEN to the receipt and still gates
 * PUBLICATION via the final compare-and-set, so a mixed-revision count can
 * never be published; it just no longer throws away proven scan progress.
 *
 * A page timeout rolls back only its own short transaction. Earlier pages
 * already committed their receipts, and SQLSTATE 57014 becomes the existing
 * `PostgresStatementTimeoutError`, preserving deferred-not-failed/backoff.
 */
/**
 * YIELD when the admission budget is spent, instead of scanning until killed.
 *
 * Each page already commits its own receipt in its own transaction
 * (`scanPostgresCanonicalStreamsPage`), so the durable-progress primitive was
 * always here. What was missing is an exit: this loop ran until `complete` or
 * until Postgres cancelled it, which for a whale is always the latter.
 *
 * Measured in production 2026-08-28, connection cin_2de5ede05c8cc8d45935c414:
 *
 *     one 10,000-row page          16.96 ms   (index-only scan, 2065 heap fetches)
 *     rows ahead of its prefix     1,891,516
 *     pages still required         189  (~3.2 s of query time)
 *     observed outcome             cancelled 5x, backing off 960s, prefix frozen
 *
 * The page is not slow — 17 ms against a 500 ms floor. The unit simply cannot
 * finish 189 sequential pages inside ONE admission, so it was cancelled
 * mid-loop every pass. Worse, adaptive shrinking made it WORSE: a smaller page
 * means MORE pages for the same rows, all still inside one bounded admission.
 *
 * Yielding inverts that. Progress banks page by page and the next admission
 * resumes from the committed boundary, so a 1.89M-row projection converges
 * across passes instead of restarting. Adaptive paging then helps as intended:
 * smaller pages fit the bound, and the extra pages are simply spread over more
 * admissions rather than lost.
 *
 * `PARTIAL` is deliberately distinct from `complete`. The caller must NOT
 * publish a count folded from a partial scan — an unfinished accumulator is not
 * an answer, and treating it as one is exactly the false-green this subsystem
 * exists to prevent.
 *
 * The per-unit bound is untouched: nothing here raises, extends, or reuses an
 * allowance. It only declines to start a page it has no budget to finish.
 *
 * A page that WAS admitted (passed `admissionAllowanceExhausted`'s headroom
 * check) can still be cancelled by Postgres itself: `admissionAllowanceExhausted`
 * reads the raw deadline, but the page's own `SET LOCAL statement_timeout`
 * (`remainingStatementBudgetMs`) is floored at `MIN_STATEMENT_TIMEOUT_MS`, so a
 * page starting with headroom between the 100 ms admission threshold and the
 * 500 ms floor is granted the full 500 ms and can still run past the caller's
 * true remaining time. Measured in production 2026-08-28,
 * `cin_ece4bfe5096b8bf67a1468c2`: a page committed `resume_after_id=21022443`
 * at 09:39:56.135Z, then the NEXT page in that same admission was cancelled by
 * statement_timeout 96 ms later — a genuine `PostgresStatementTimeoutError`,
 * thrown from a call this loop does not wrap, so it propagated past this
 * function's `partial` return entirely and reached `repairCandidatePostgres`'s
 * outer catch, which cannot see that an earlier page already banked real
 * progress and arms the full un-paced back-off (`noteRepairTimeout`) as if
 * this unit had achieved nothing. A whale that banks one page and is then
 * cancelled on the next is throttled for up to 30 minutes despite converging.
 *
 * So a timeout on any page AFTER the first is caught here and treated
 * identically to the clean `admissionAllowanceExhausted` yield: `partial:
 * true`, durable progress banked, no back-off armed. Only a timeout on the
 * FIRST page of this call — where nothing in this call committed — still
 * propagates, because that case genuinely made zero progress and the
 * existing `noteRepairTimeout` pacing is correct there.
 */
async function scanPostgresCanonicalStreamsChunked(
  connectorInstanceId: string,
  deadline: number | null
): Promise<
  | { readonly canonicalByStream: Map<string, Row>; readonly missing: false }
  | { readonly missing: true }
  | { readonly missing: false; readonly partial: true }
> {
  let bankedProgressThisCall = false;
  for (;;) {
    let pageResult: PostgresCanonicalScanPageResult;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Pages are intentionally sequential; each commits the durable boundary the next page reloads.
      pageResult = await scanPostgresCanonicalStreamsPage(connectorInstanceId, deadline);
    } catch (err) {
      if (bankedProgressThisCall && err instanceof PostgresStatementTimeoutError) {
        return { missing: false, partial: true };
      }
      throw err;
    }
    if (pageResult.missing) {
      return { missing: true };
    }
    if (pageResult.complete) {
      return { canonicalByStream: canonicalByStreamFromAccumulator(pageResult.accumulator), missing: false };
    }
    bankedProgressThisCall = true;
    // The page above COMMITTED its boundary. If there is no longer enough
    // allowance to START another page, stop here with that progress banked
    // rather than beginning a page that will be cancelled and re-running this
    // one next pass forever.
    //
    // This asks `admissionAllowanceExhausted`, NOT
    // `remainingStatementBudgetMs(deadline) === 0`. The latter is a
    // per-statement timeout floored at `MIN_STATEMENT_TIMEOUT_MS`, so it
    // reports 500 when only 100 ms of admission actually remains and the loop
    // would start a page it cannot finish.
    if (admissionAllowanceExhausted(deadline)) {
      return { missing: false, partial: true };
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One ordered repair protocol — read canonical facts, then publish under a single compare-and-set. The early exits (missing instance, deferred source revision, partial scan) are guard clauses that must stay in this scope: each decides whether publication may proceed at all, and hoisting them behind a helper would separate that decision from the fenced transaction it protects.
async function repairCandidatePostgres(
  connectorInstanceId: string,
  deadline: number | null = null
): Promise<RepairedEvidence> {
  let sourceRevisionAtRead: string | null | undefined;
  // Set once the canonical scan itself returns a COMPLETE (non-`partial`,
  // non-`missing`) accumulator in this call. A `PostgresStatementTimeoutError`
  // from a read AFTER this point (manifest/generation/streams/retained-size/
  // terminal or schedule high-water/the publication CAS) is a fundamentally
  // different situation from one before it: the scan already banked its
  // FULL prefix, so the next attempt's own scan resolves in one cheap
  // "no rows past the boundary" page instead of re-walking the connection.
  // See the outer catch below for what this changes.
  let canonicalScanCompletedThisAttempt = false;
  try {
    const instanceResult = await postgresRepairReadQuery(
      "SELECT *, source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1",
      [connectorInstanceId],
      deadline
    );
    const instance = instanceResult.rows[0] as Row | undefined;
    if (!instance) {
      const deleted = await deleteEvidenceIfConnectorInstanceMissing(connectorInstanceId);
      return missingInstanceRepairResult(connectorInstanceId, deleted);
    }
    const sourceRevision = decimalText(instance.source_revision_text);
    sourceRevisionAtRead = sourceRevision;
    const activeRunResult = await postgresRepairReadQuery(
      "SELECT 1 AS present FROM controller_active_runs WHERE connector_instance_id = $1 LIMIT 1",
      [connectorInstanceId],
      deadline
    );
    let built: Row;
    const deferred =
      activeRunResult.rowCount !== 0 || sourceRevision === null || sourceRevisionIsExhausted(sourceRevision);
    if (deferred) {
      built = { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" };
    } else {
      // The manifest/generation/streams reads below are consumed only by
      // `buildRepairedRow`, after the canonical scan succeeds — so they run
      // AFTER `scanPostgresCanonicalStreamsChunked`, not before it.
      //
      // A whale's canonical scan (or even the read immediately above this
      // comment) is exactly the read most likely to exhaust the per-unit
      // statement-timeout budget or lose a lock/IO race under contention. Every
      // attempt that ends in `missing`/`partial`/a rethrown
      // `PostgresStatementTimeoutError` discards these three reads' results
      // unused; running them first only spent shared admission budget the
      // canonical scan needed, and added three more round trips of contention
      // against `connectors`/`connector_instances`/`version_counter` on every
      // failed retry with no compensating improvement in the next attempt's
      // odds. Deferring them until they are actually needed hands that budget
      // to the read that determines whether this attempt makes progress at
      // all, on every attempt — not only the one that finally succeeds.
      const canonicalScan = await scanPostgresCanonicalStreamsChunked(connectorInstanceId, deadline);
      if (canonicalScan.missing) {
        const deleted = await deleteEvidenceIfConnectorInstanceMissing(connectorInstanceId);
        return missingInstanceRepairResult(connectorInstanceId, deleted);
      }
      if ("partial" in canonicalScan) {
        // The scan banked committed page boundaries but ran out of admission
        // allowance before reaching the end of this connection's records.
        //
        // Return here, BEFORE `built` exists. This is deliberately a structural
        // guarantee rather than a checked one: the partial accumulator is never
        // bound to a variable in this scope, so there is no value a later edit
        // could accidentally hand to `buildRepairedRow`, and the publication
        // CAS below is unreachable on this path. An unfinished accumulator has
        // seen only a PREFIX of `records`, so folding it would publish a count
        // strictly LOWER than the connection actually holds — a confident,
        // durable under-report of the owner's own data, which is precisely the
        // false-green this subsystem exists to prevent.
        return deferredNotFailedRepairResult(connectorInstanceId);
      }
      const { canonicalByStream } = canonicalScan;
      canonicalScanCompletedThisAttempt = true;
      const manifestResult = await postgresRepairReadQuery(
        "SELECT manifest::text AS manifest FROM connectors WHERE connector_id = $1",
        [instance.connector_id],
        deadline
      );
      const manifest = parseManifestDeclaration((manifestResult.rows[0] as Row | undefined)?.manifest);
      const generationResult = await postgresRepairReadQuery(
        "SELECT record_reset_generation::text AS reset_generation FROM connector_instances WHERE connector_instance_id = $1",
        [connectorInstanceId],
        deadline
      );
      const streamsResult = await postgresRepairReadQuery(
        "SELECT stream, max_version::text AS max_version FROM version_counter WHERE connector_instance_id = $1",
        [connectorInstanceId],
        deadline
      );
      const checkpoint = normalizeRecordSourceCheckpoint({
        resetGeneration: String((generationResult.rows[0] as Row | undefined)?.reset_generation ?? "0"),
        streams: (streamsResult.rows as Row[]).map((row) => ({
          maxVersion: String(row.max_version),
          stream: String(row.stream),
        })),
      });
      const retainedByteResult = await postgresRepairReadQuery(
        "SELECT * FROM retained_size_connection WHERE connector_instance_id = $1",
        [connectorInstanceId],
        deadline
      );
      const retainedByteRow = retainedByteResult.rows[0] as Row | undefined;
      const retainedStreamResult = await postgresRepairReadQuery(
        "SELECT stream, record_count FROM retained_size_stream WHERE connector_instance_id = $1",
        [connectorInstanceId],
        deadline
      );
      const retainedByStream = new Map(
        (retainedStreamResult.rows as Row[]).map((row) => [String(row.stream), Number(row.record_count || 0)])
      );
      const unexpectedResult = manifest.ok
        ? await postgresRepairReadQuery(
            "SELECT stream FROM manifest_write_violations WHERE connector_instance_id = $1 AND manifest_generation = $2",
            [connectorInstanceId, Number(instance.manifest_generation ?? 0)],
            deadline
          )
        : { rows: [] as Row[] };
      const unexpectedStreams = new Set((unexpectedResult.rows as Row[]).map((row) => String(row.stream)));
      const terminalHighWaterResult = await postgresRepairReadQuery(
        `SELECT MAX(event_seq) AS max_seq FROM spine_events
          WHERE connector_instance_id = $1
            AND event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`,
        [connectorInstanceId],
        deadline
      );
      const terminalHighWater = (terminalHighWaterResult.rows[0] as Row | undefined)?.max_seq;
      // Terminal-gate revision (2026-07-29): repair also refreshes the
      // schedule/lifecycle repair-receipt checkpoints so a repaired row
      // records the current values it was JUST verified against, not the
      // stale ones that triggered the repair.
      const scheduleResult = await postgresRepairReadQuery(
        "SELECT updated_at FROM connector_schedules WHERE connector_instance_id = $1",
        [connectorInstanceId],
        deadline
      );
      const scheduleCheckpoint = (scheduleResult.rows[0] as Row | undefined)?.updated_at;
      const lifecycleHighWaterResult = await postgresRepairReadQuery(
        "SELECT MAX(event_seq) AS max_seq FROM spine_events WHERE connector_instance_id = $1",
        [connectorInstanceId],
        deadline
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
            "SELECT source_revision::text AS source_revision_text FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
            [connectorInstanceId]
          );
          const currentRow = current.rows[0] as Row | undefined;
          if (!currentRow) {
            await deletePostgresRepairChunk(connectorInstanceId, client);
            return {
              deferred: true,
              failed: false,
              persisted: true,
              row: { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" },
            };
          }
          if (!sourceRevisionsEqual(currentRow.source_revision_text, sourceRevision)) {
            // A later source mutation moved the final publication receipt.
            // Keep the completed chunk: if its scanned prefix survived the
            // records trigger, the next admission can fold only the tail and
            // retry this CAS with a short window. Prefix mutations have
            // already deleted the chunk in their own writer transaction.
            return {
              deferred: true,
              failed: false,
              persisted: true,
              row: { connector_instance_id: connectorInstanceId, dirty: 1, state: "stale" },
            };
          }
          if (deferred) {
            await client.query(
              `UPDATE connector_summary_evidence SET dirty = 1, state = 'stale', source_revision = $2, list_summary_projection_reason_code = $1, last_error = NULL WHERE connector_instance_id = $3`,
              [
                sourceRevisionDeferredReason(activeRunResult.rowCount !== 0, sourceRevision),
                sourceRevision,
                connectorInstanceId,
              ]
            );
          } else {
            // Successful publication consumes the completed scan receipt in
            // the SAME transaction. A failed CAS above deliberately retains
            // it so harmless appends can resume from its boundary.
            await deletePostgresRepairChunk(connectorInstanceId, client);
            await upsertPostgresEvidenceRow(client, built);
          }
          return { deferred, failed: false, persisted: true, row: built };
        },
        { lockConnectorInstanceId: connectorInstanceId }
      )
    );
  } catch (err) {
    logRepairFailure(connectorInstanceId, reasonCodeForRepairFailure(err, REASON_CODES.RECORD_SNAPSHOT_FAILED), err);
    if (err instanceof PostgresStatementTimeoutError) {
      // The per-unit HARD bound (design review P1-2) fired as designed —
      // this unit's own pre-transaction read was cancelled by Postgres
      // under load, which says NOTHING about whether this connection's
      // canonical facts have actually changed. Marking the row `failed`
      // here is exactly the production regression (2026-08-18): a healthy
      // row was degraded solely because its repair got scheduled late in a
      // busy pass. Leave the row's durable evidence completely untouched
      // and defer — the SAME candidate reclassifies and retries on the
      // next observation pass (design.md "Startup is acceleration, not
      // authority": nothing here is ever permanently lost, only deferred).
      //
      // Arm the back-off HERE, at the only site this error is actually
      // handled. It was originally wired into `repairCandidate`'s outer
      // catch, which this `return` makes unreachable — so the throttle
      // never fired in production (2026-08-26: codex, 1,311,001 records,
      // 14 cancelled attempts in 15 minutes, back-off activations 0, row
      // frozen over an hour). "Retries on the next pass" is only honest
      // when the retries are paced; unpaced, this unit consumes the round
      // every pass and the rows behind it never recompute.
      //
      // BUT a timeout that fires after the canonical scan already completed
      // in this call is not that situation: the expensive, contention-prone
      // work is already banked, and only a cheap trailing read (or the
      // publication CAS) collided. Escalating this row's backoff the same
      // way a genuine scan timeout does would make its retries rarer while
      // giving it nothing that makes the next one more likely to succeed —
      // the exact generic gap this file's fail-before regression test
      // demonstrates. Pace it flat instead.
      if (canonicalScanCompletedThisAttempt) {
        noteRepairTimeoutAfterCompletedScan(connectorInstanceId);
      } else {
        noteRepairTimeout(connectorInstanceId);
      }
      return deferredNotFailedRepairResult(connectorInstanceId);
    }
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
  // checkpoint (`version_counter`) is the orthogonal observation axis that
  // separates them: a checkpoint entry exists only once ingest allocated a
  // version for that stream, so it is positive proof that the stream WAS
  // canonically observed. Absent that proof, an absent canonical row is
  // `unobserved`, never `known_zero`.
  //
  // This read and the canonical scan are NOT in the same transaction — the
  // scan is many short, independently committed page transactions
  // (`scanPostgresCanonicalStreamsChunked`), and this checkpoint read now
  // runs strictly AFTER all of them finish, as its own autocommit statement.
  // A stream whose version_counter row is allocated by a concurrent ingest
  // AFTER the scan's last page but BEFORE this read would appear in
  // `observedStreams` with no matching canonical row — the `known_zero` shape
  // this axis exists to prevent, not the safe `unobserved` one.
  //
  // What actually prevents that from landing is the publication CAS below
  // (`sourceRevisionsEqual` under `FOR UPDATE`): that same concurrent ingest
  // bumps `source_revision` via the `version_counter` trigger
  // (`postgres-storage.ts`'s `sourceTables` list), so the CAS comparing this
  // attempt's captured `sourceRevisionAtRead` against the current row fails
  // and `built` — including this observation — is discarded whole, never
  // published. The CAS is the sole guarantee against this hazard reaching
  // durable evidence; this read ordering makes that coupling load-bearing
  // where the pre-fix ordering did not.
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
      "SELECT manifest_generation, manifest_fingerprint, stream_latest_facts_json, stream_facts_event_seq, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?"
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
    "SELECT manifest_generation, manifest_fingerprint, stream_latest_facts_json, stream_facts_event_seq, terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = $1",
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

/**
 * Whether a generation advance actually invalidates this row's terminal facts.
 *
 * The generation counter is the OUTER, conservative fence: it advances on any
 * byte of any manifest (`auth.ts` `persistManifestAndAdvanceGenerations`), so
 * it answers "could this evidence be stale", never "is it". Editing
 * `capabilities.refresh_policy.recommended_mode` across the fleet advanced 24
 * generations at once and blanked terminal facts on every one of them, though
 * the fold reads no such field.
 *
 * The declaration fingerprint is the INNER, exact fence. It is the sorted set
 * of declared stream names (`parseManifestDeclaration`) — precisely the
 * manifest section the terminal fold depends on. The fold itself reads no
 * manifest content at all: it folds `collection_facts.streams` off the spine
 * event, keyed by stream name. The only way a manifest edit can change which
 * facts are attributable is by changing which streams are declared, which is
 * exactly what moves this fingerprint. This is the dependency edge Salsa
 * records by observing a read and Bazel's Skyframe records via `getValue()`;
 * here the read-set is small and static enough to declare directly.
 *
 * So a generation advance is necessary but NOT sufficient: facts are discarded
 * only when the declaration they were folded under actually changed. This is
 * the rule the write path already believed it was applying — see the
 * "A fingerprint transition is the sole exception" note on the upsert's
 * terminal-facts bindings, which describes this predicate rather than the
 * generation equality that was actually being tested.
 *
 * Fail closed on absence: a NULL stored or incoming fingerprint means the
 * declaration is unknown for one side of the comparison, so the coarse
 * generation verdict stands.
 *
 * Fail closed on UNOBSERVED generations too, and this is the subtle one. The
 * fingerprint is a value, not a history, so it cannot distinguish "never
 * changed" from "changed and changed back". A stream removed and re-added
 * before any reconcile ran advances the generation twice and returns to a
 * byte-identical declaration — the classic ABA problem — yet the facts folded
 * before the removal must not be reattached to the re-added stream. The
 * monotonic counter is precisely the thing that does not have that blind spot,
 * so the fingerprint is only trusted to overrule it across a single-step
 * advance the row actually witnessed. A jump of more than one generation means
 * at least one declaration state passed unobserved, and an unobserved state is
 * not evidence of continuity. On the live instance every evidence row tracks
 * its instance generation exactly, so the ordinary boot-time reconcile path
 * takes the single-step branch.
 */
function manifestDeclarationChanged(existing: Row | undefined, row: Row): boolean {
  if (existing === undefined) {
    return false;
  }
  const storedGeneration = Number(existing.manifest_generation ?? 0);
  const incomingGeneration = Number(row.manifest_generation ?? 0);
  if (!(Number.isFinite(storedGeneration) && Number.isFinite(incomingGeneration))) {
    return true;
  }
  if (incomingGeneration - storedGeneration !== 1) {
    return true;
  }
  const storedFingerprint = existing.manifest_fingerprint;
  const incomingFingerprint = row.manifest_fingerprint;
  if (typeof storedFingerprint !== "string" || typeof incomingFingerprint !== "string") {
    return true;
  }
  return storedFingerprint !== incomingFingerprint;
}

function terminalFactsForRepair(existing: Row | undefined, row: Row, manifestGenerationChanged: boolean) {
  if (manifestGenerationChanged && manifestDeclarationChanged(existing, row)) {
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
 * `options.maxDurationMs`, when provided, is NOT a wall-clock duration
 * bound on this call's total running time — despite its name, it is a
 * cooperative PASS ADMISSION DEADLINE, checked only BETWEEN candidates
 * (never mid-repair, so a candidate already under its writer fence always
 * finishes cleanly): no NEW repair unit begins once it has passed, but a
 * unit already admitted always runs to completion (design review P1-2
 * naming correction, 2026-08-18 — see the reviewer's exact framing: "The
 * 2-second budget is not a wall-clock bound... It is a soft hint checked
 * between some operations." Renaming the option was considered and
 * rejected in favor of documenting it precisely everywhere it is described,
 * to avoid a disruptive rename across every existing caller for a
 * still-true admission-deadline contract). A small candidate COUNT does not
 * bound total TIME when individual repairs are slow (e.g. a connection with
 * a very large canonical record set), so `maxCandidates` alone is not a
 * genuine work bound; the admission deadline closes that gap for NEW units
 * (Sol P2.2). The remaining unrepaired candidates are reported in
 * `skipped`, exactly like a count-bound cutoff — genuinely deferred to the
 * next observation, never lost.
 *
 * Discovery and orphan pruning below are admission-deadline-CHECKED only
 * BETWEEN phases, never mid-phase (each is a fixed, small, batched query
 * count REGARDLESS of N/K, Sol P1.2, but that only bounds query COUNT,
 * never a single query's own server-side latency — the PASS SOFT DEADLINE
 * contract above, not a duration bound). A discovery query slow enough
 * under contention to exceed the caller's ENTIRE admission deadline on its
 * own (production, 2026-08-18: `repair_duration_ms: 5322` against a 2000ms
 * pass budget — a canonical-count aggregate contending with unrelated heavy
 * I/O) could previously consume the whole round before the repair loop ever
 * ran. Two independent things now close that gap:
 *
 *   1. PER-UNIT HARD BOUND (design review P1-2's second, distinct
 *      contract): on Postgres, every discovery/repair pre-transaction read
 *      (`discoverCandidates`/`repairCandidate` below) now runs under a
 *      transaction-local `SET LOCAL statement_timeout`
 *      (`postgresDiscoveryQuery`/`postgresRepairReadQuery` in this file,
 *      `postgresQueryBounded` in postgres-storage.ts) derived from the
 *      caller's own remaining admission allowance, so a single slow query
 *      can no longer silently consume more than that unit had left when it
 *      started. SQLite has NO equivalent — `better-sqlite3` is synchronous
 *      and exposes no interrupt/progress-handler hook on its public API, so
 *      a slow SQLite discovery/repair query cannot be cancelled once
 *      started. This is a disclosed, unclosed gap on SQLite, not a silent
 *      omission: every hot-path SQLite query in this file is index-bounded
 *      (`WHERE connector_instance_id IN (...)`/`= ?`, or an indexed
 *      `MAX`/`GROUP BY` aggregate), so it is expected to be fast in
 *      practice, but nothing here can force-cancel one that isn't.
 *   2. FORWARD PROGRESS UNDER STARVATION: even when a discovery unit
 *      legitimately uses its whole per-unit allowance, `repairCandidates`
 *      (connector-summary-evidence-bounded-reconciliation.ts) always
 *      attempts its first selected candidate regardless of the admission
 *      deadline, so a slow-but-not-runaway discovery cannot reduce a round
 *      to zero repairs.
 *
 * Orphan pruning additionally requires the COMPLETE canonical instance set
 * to correctly distinguish "orphaned" from "merely not yet discovered" — a
 * partial discovery pass could not safely prune at all without risking
 * deleting a live connection's evidence.
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
      discover: (ids) => discoverCandidates(ids, deadline),
      maxCandidates:
        typeof options.maxCandidates === "number" && options.maxCandidates >= 0 ? options.maxCandidates : undefined,
      pageSize: RECONCILE_PAGE_SIZE,
      prune: pruneReconciledEvidence,
      pruneComplete: pruneOrphanedEvidenceCompleteByKeyset,
      readPage: readConnectorInstanceIdPage,
      repair: (id) => repairCandidate(id, deadline),
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
    discover: (ids) => discoverCandidates(ids, deadline),
    maxCandidates:
      typeof options.maxCandidates === "number" && options.maxCandidates >= 0 ? options.maxCandidates : undefined,
    prune: pruneReconciledEvidence,
    repair: (id) => repairCandidate(id, deadline),
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
              // This id was absent from discovery but exists under the exact
              // fence, so it may have been deleted and recreated. Preserve
              // its evidence, but never resume scan state from before that
              // possible identity change.
              await deletePostgresRepairChunk(connectorInstanceId, client);
              return false;
            }
            const deleted = await client.query(
              "DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1",
              [connectorInstanceId]
            );
            await deletePostgresRepairChunk(connectorInstanceId, client);
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
            deleteSqliteRepairChunk(db, connectorInstanceId);
            return false;
          }
          const deleted = db
            .prepare("DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?")
            .run(connectorInstanceId);
          deleteSqliteRepairChunk(db, connectorInstanceId);
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
