// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type BindValue, iterateDynamicSqlAcknowledged } from "../lib/db.ts";

/**
 * Provider-neutral keyset traversal for complete reconciliation.
 *
 * The callbacks own domain work for one bounded page. This module owns the
 * correctness boundary around that work: stable cursor advancement,
 * cooperative deadlines, complete exhaustion, bounded-result aggregation,
 * and the separate complete cleanup pass. No provider-specific query or
 * connector-summary fact crosses this boundary.
 */

export interface BoundedPageResult<TFailure> {
  /**
   * Every id `repair()` was actually invoked for this page, in attempt
   * order — success, failure, and deferred outcomes all count as
   * "attempted" (only a candidate never reached because the deadline
   * expired, or an id that was never even classified as a candidate, is
   * excluded). A scoped caller (`runScopedConnectorReconciliation`) uses
   * this to advance a fairness-rotation cursor to the LAST id it genuinely
   * gave a turn, not merely the last id it fetched — see
   * `runDirtyPriorityAcceleration` in connector-summary-read-model.ts.
   */
  readonly attemptedIds: readonly string[];
  readonly candidateReasonCounts: Readonly<Record<string, number>>;
  readonly candidatesInspected: number;
  readonly discovered: number;
  readonly failed: number;
  readonly failedRows: ReadonlyMap<string, TFailure>;
  readonly repaired: number;
  readonly skipped: number;
}

export type BoundedReconciliationResult<TFailure> = BoundedPageResult<TFailure>;

async function readPostgresKeysetPage(
  table: string,
  afterId: string | null,
  limit: number
): Promise<readonly string[]> {
  const result = afterId
    ? await postgresQuery(
        `SELECT connector_instance_id FROM ${table} WHERE connector_instance_id > $1 ORDER BY connector_instance_id ASC LIMIT $2`,
        [afterId, limit]
      )
    : await postgresQuery(`SELECT connector_instance_id FROM ${table} ORDER BY connector_instance_id ASC LIMIT $1`, [
        limit,
      ]);
  return (result.rows as Row[]).map((row) => String(row.connector_instance_id));
}

function readSqliteKeysetPage(table: string, afterId: string | null, limit: number): readonly string[] {
  // REVIEWED-DYNAMIC: table is one of the two fixed internal keyset tables;
  // values remain bound and each query has an explicit page LIMIT.
  const sql = afterId
    ? `SELECT connector_instance_id FROM ${table} WHERE connector_instance_id > ? ORDER BY connector_instance_id ASC LIMIT ?`
    : `SELECT connector_instance_id FROM ${table} ORDER BY connector_instance_id ASC LIMIT ?`;
  const params: readonly BindValue[] = afterId === null ? [limit] : [afterId, limit];
  const rows = [...iterateDynamicSqlAcknowledged<Row>(sql, params)];
  return rows.map((row) => String(row.connector_instance_id));
}

export function readConnectorInstanceIdPage(afterId: string | null, limit: number): Promise<readonly string[]> {
  return readKeysetPage("connector_instances", afterId, limit);
}

export function readEvidenceIdPage(afterId: string | null, limit: number): Promise<readonly string[]> {
  return readKeysetPage("connector_summary_evidence", afterId, limit);
}

function readKeysetPage(table: string, afterId: string | null, limit: number): Promise<readonly string[]> {
  return isPostgresStorageBackend()
    ? readPostgresKeysetPage(table, afterId, limit)
    : Promise.resolve(readSqliteKeysetPage(table, afterId, limit));
}

interface CandidateSelection<TReason extends string> {
  readonly all: readonly (readonly [string, TReason])[];
  readonly counts: Readonly<Record<string, number>>;
  readonly selected: readonly (readonly [string, TReason])[];
}

function countCandidateReasons<TReason extends string>(
  entries: readonly (readonly [string, TReason])[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, reason] of entries) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function limitCandidates<TReason extends string>(
  entries: readonly (readonly [string, TReason])[],
  maxCandidates: number | undefined,
  candidateBudgetUsed: number
): readonly (readonly [string, TReason])[] {
  if (maxCandidates === undefined) {
    return entries;
  }
  return entries.slice(0, Math.max(0, maxCandidates - candidateBudgetUsed));
}

function selectCandidates<TReason extends string>(
  candidates: ReadonlyMap<string, TReason>,
  allowedReasons: readonly TReason[] | undefined,
  maxCandidates: number | undefined,
  candidateBudgetUsed = 0
): CandidateSelection<TReason> {
  const allowed = allowedReasons === undefined ? null : new Set(allowedReasons);
  const all = [...candidates].filter(([, reason]) => allowed === null || allowed.has(reason));
  return {
    all,
    counts: countCandidateReasons(all),
    selected: limitCandidates(all, maxCandidates, candidateBudgetUsed),
  };
}

function recordRepairOutcome<TFailure>(
  state: { failed: number; failedRows: Map<string, TFailure>; repaired: number },
  id: string,
  result: { readonly failed: boolean; readonly persisted: boolean; readonly row: TFailure }
): void {
  state.repaired += 1;
  if (result.failed) {
    state.failed += 1;
    if (!result.persisted) {
      state.failedRows.set(id, result.row);
    }
  }
}

async function repairCandidates<TFailure>({
  deadline,
  repair,
  selected,
}: {
  readonly deadline: number | null;
  readonly repair: (id: string) => Promise<{
    readonly deferred: boolean;
    readonly failed: boolean;
    readonly persisted: boolean;
    readonly row: TFailure;
  }>;
  readonly selected: readonly (readonly [string, string])[];
}): Promise<{
  readonly attemptedIds: readonly string[];
  readonly failed: number;
  readonly failedRows: ReadonlyMap<string, TFailure>;
  readonly processed: number;
  readonly repaired: number;
}> {
  interface RepairState {
    failed: number;
    failedRows: Map<string, TFailure>;
    repaired: number;
  }
  let processed = 0;
  // Every id `repair()` was actually invoked for, in attempt order —
  // regardless of whether it succeeded, failed, or was deferred (a
  // deferred candidate — e.g. one with an active run — still consumed its
  // turn and must not be re-selected as if it had never been tried). This
  // is the fairness-rotation primitive `runDirtyPriorityAcceleration` needs
  // to advance its cursor to the LAST ATTEMPTED id rather than the last
  // FETCHED id (see that function's doc for the production starvation this
  // closes).
  const attemptedIds: string[] = [];
  const state: RepairState = { failed: 0, failedRows: new Map(), repaired: 0 };
  for (const [id] of selected) {
    // Guaranteed forward progress (2026-08-18): the FIRST selected candidate
    // always gets attempted, even if `discover`'s own batched read (never
    // deadline-checked — it is one indivisible await, not a per-candidate
    // loop) already consumed the whole round's budget by the time this loop
    // starts. Production: a discovery read contending with unrelated heavy
    // I/O took 8.9s against a 2s round budget, so `Date.now() >= deadline`
    // was ALREADY true before candidate #1 — every one of 16 dirty
    // candidates was reported `skipped` with zero repair attempts, forever,
    // because the SAME slow discovery repeated every round. A repair unit
    // already selected represents real, already-spent discovery work; never
    // attempting even one wastes that work and guarantees the backlog can
    // never shrink. Every candidate AFTER the first still obeys the
    // ordinary cooperative-deadline contract (no unit begins once expired).
    if (processed > 0 && deadline !== null && Date.now() >= deadline) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Repairs are intentionally sequential to preserve lease and revision ordering.
    const result = await repair(id);
    processed += 1;
    attemptedIds.push(id);
    if (!result.deferred) {
      recordRepairOutcome(state, id, result);
    }
  }
  return { ...state, attemptedIds, processed };
}

export async function processBoundedReconciliationPage<TInstance, TReason extends string, TFailure>({
  candidateBudgetUsed,
  candidateReasons,
  deadline,
  discover,
  ids,
  maxCandidates,
  prune,
  repair,
}: {
  readonly candidateBudgetUsed: number;
  readonly candidateReasons: readonly TReason[] | undefined;
  readonly deadline: number | null;
  readonly discover: (ids: readonly string[]) => Promise<{
    readonly candidates: ReadonlyMap<string, TReason>;
    readonly instanceRows: readonly TInstance[];
  }>;
  readonly ids: readonly string[];
  readonly maxCandidates: number | undefined;
  readonly prune: (
    ids: readonly string[],
    instanceRows: readonly TInstance[],
    deadline: number | null
  ) => Promise<number>;
  readonly repair: (id: string) => Promise<{
    readonly deferred: boolean;
    readonly failed: boolean;
    readonly persisted: boolean;
    readonly row: TFailure;
  }>;
}): Promise<{ readonly candidateBudgetUsed: number; readonly page: BoundedPageResult<TFailure> }> {
  const { instanceRows, candidates } = await discover(ids);
  const selection = selectCandidates(candidates, candidateReasons, maxCandidates, candidateBudgetUsed);
  const repairs = await repairCandidates({ deadline, repair, selected: selection.selected });
  const candidateRepairs = repairs.repaired + (await prune(ids, instanceRows, deadline));
  return {
    candidateBudgetUsed: candidateBudgetUsed + repairs.processed,
    page: {
      attemptedIds: repairs.attemptedIds,
      candidateReasonCounts: selection.counts,
      candidatesInspected: instanceRows.length,
      discovered: instanceRows.length,
      failed: repairs.failed,
      failedRows: repairs.failedRows,
      repaired: candidateRepairs,
      skipped: selection.all.length - repairs.repaired,
    },
  };
}

export function runBoundedConnectorReconciliation<TInstance, TReason extends string, TFailure>({
  candidateReasons,
  deadline,
  discover,
  maxCandidates,
  pageSize,
  prune,
  pruneComplete,
  readPage,
  repair,
}: {
  readonly candidateReasons: readonly TReason[] | undefined;
  readonly deadline: number | null;
  readonly discover: (ids: readonly string[]) => Promise<{
    readonly candidates: ReadonlyMap<string, TReason>;
    readonly instanceRows: readonly TInstance[];
  }>;
  readonly maxCandidates: number | undefined;
  readonly pageSize: number;
  readonly prune: (ids: readonly string[], rows: readonly TInstance[], deadline: number | null) => Promise<number>;
  readonly pruneComplete: (deadline: number | null) => Promise<number>;
  readonly readPage: (afterId: string | null, limit: number) => Promise<readonly string[]>;
  readonly repair: (id: string) => Promise<{
    readonly deferred: boolean;
    readonly failed: boolean;
    readonly persisted: boolean;
    readonly row: TFailure;
  }>;
}): Promise<BoundedReconciliationResult<TFailure>> {
  let candidateBudgetUsed = 0;
  return runBoundedKeysetReconciliation({
    deadline,
    pageSize,
    processPage: async (ids, pageDeadline) => {
      const result = await processBoundedReconciliationPage({
        candidateBudgetUsed,
        candidateReasons,
        deadline: pageDeadline,
        discover,
        ids,
        maxCandidates,
        prune,
        repair,
      });
      ({ candidateBudgetUsed } = result);
      return result.page;
    },
    pruneComplete,
    readPage,
  });
}

export async function runScopedConnectorReconciliation<TInstance, TReason extends string, TFailure>({
  candidateReasons,
  connectorInstanceIds,
  deadline,
  discover,
  maxCandidates,
  prune,
  repair,
}: {
  readonly candidateReasons: readonly TReason[] | undefined;
  readonly connectorInstanceIds: readonly string[];
  readonly deadline: number | null;
  readonly discover: (ids: readonly string[]) => Promise<{
    readonly candidates: ReadonlyMap<string, TReason>;
    readonly instanceRows: readonly TInstance[];
  }>;
  readonly maxCandidates: number | undefined;
  readonly prune: (ids: readonly string[], rows: readonly TInstance[], deadline: number | null) => Promise<number>;
  readonly repair: (id: string) => Promise<{
    readonly deferred: boolean;
    readonly failed: boolean;
    readonly persisted: boolean;
    readonly row: TFailure;
  }>;
}): Promise<BoundedPageResult<TFailure>> {
  const { instanceRows, candidates } = await discover(connectorInstanceIds);
  const selection = selectCandidates(candidates, candidateReasons, maxCandidates);
  const repairs = await repairCandidates({ deadline, repair, selected: selection.selected });
  const repaired = repairs.repaired + (await prune(connectorInstanceIds, instanceRows, deadline));
  return {
    attemptedIds: repairs.attemptedIds,
    candidateReasonCounts: selection.counts,
    candidatesInspected: instanceRows.length,
    discovered: instanceRows.length,
    failed: repairs.failed,
    failedRows: repairs.failedRows,
    repaired,
    skipped: selection.all.length - repairs.repaired,
  };
}

function mergeBoundedPage<TFailure>(
  result: {
    attemptedIds: string[];
    candidateReasonCounts: Record<string, number>;
    candidatesInspected: number;
    discovered: number;
    failed: number;
    failedRows: Map<string, TFailure>;
    repaired: number;
    skipped: number;
  },
  page: BoundedPageResult<TFailure>
): void {
  for (const [reason, count] of Object.entries(page.candidateReasonCounts)) {
    result.candidateReasonCounts[reason] = (result.candidateReasonCounts[reason] ?? 0) + count;
  }
  result.candidatesInspected += page.candidatesInspected;
  result.discovered += page.discovered;
  result.failed += page.failed;
  result.repaired += page.repaired;
  result.skipped += page.skipped;
  result.attemptedIds.push(...page.attemptedIds);
  for (const [id, row] of page.failedRows) {
    result.failedRows.set(id, row);
  }
}

async function* iterateKeysetPages({
  deadline,
  pageSize,
  readPage,
}: {
  readonly deadline: number | null;
  readonly pageSize: number;
  readonly readPage: (afterId: string | null, limit: number) => Promise<readonly string[]>;
}): AsyncGenerator<readonly string[]> {
  let afterId: string | null = null;
  for (;;) {
    if (deadline !== null && Date.now() >= deadline) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Sequential pages preserve the stable keyset cursor.
    const ids = await readPage(afterId, pageSize);
    if (ids.length === 0) {
      break;
    }
    yield ids;
    afterId = ids.at(-1) ?? afterId;
    if (ids.length < pageSize) {
      break;
    }
  }
}

export async function runBoundedKeysetReconciliation<TFailure>({
  deadline,
  pageSize,
  processPage,
  pruneComplete,
  readPage,
}: {
  readonly deadline: number | null;
  readonly pageSize: number;
  readonly processPage: (ids: readonly string[], deadline: number | null) => Promise<BoundedPageResult<TFailure>>;
  readonly pruneComplete: (deadline: number | null) => Promise<number>;
  readonly readPage: (afterId: string | null, limit: number) => Promise<readonly string[]>;
}): Promise<BoundedReconciliationResult<TFailure>> {
  const result: {
    attemptedIds: string[];
    candidateReasonCounts: Record<string, number>;
    candidatesInspected: number;
    discovered: number;
    failed: number;
    failedRows: Map<string, TFailure>;
    repaired: number;
    skipped: number;
  } = {
    attemptedIds: [],
    candidateReasonCounts: {},
    candidatesInspected: 0,
    discovered: 0,
    failed: 0,
    failedRows: new Map(),
    repaired: 0,
    skipped: 0,
  };

  for await (const ids of iterateKeysetPages({ deadline, pageSize, readPage })) {
    mergeBoundedPage(result, await processPage(ids, deadline));
  }

  if (deadline === null || Date.now() < deadline) {
    result.repaired += await pruneComplete(deadline);
  }
  return result;
}

import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";

// biome-ignore lint/suspicious/noExplicitAny: the db.js boundary is untyped.
type Db = any;
type Row = Record<string, unknown>;

export function readSqliteConnectorManifests(db: Db, connectorIds: readonly string[], placeholders: string): Row[] {
  if (connectorIds.length === 0) {
    return [];
  }
  return db
    .prepare(`SELECT connector_id, manifest FROM connectors WHERE connector_id IN (${placeholders})`)
    .all(...connectorIds) as Row[];
}

export async function readPostgresConnectorManifests(connectorIds: readonly string[]): Promise<Row[]> {
  if (connectorIds.length === 0) {
    return [];
  }
  const result = await postgresQuery(
    "SELECT connector_id, manifest::text AS manifest FROM connectors WHERE connector_id = ANY($1::text[])",
    [connectorIds]
  );
  return result.rows as Row[];
}
