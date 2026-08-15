// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checked-in exact allowlist for the `reference-implementation:no-direct-prepare`
 * staged-file gate in lefthook.yml.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gate greps staged files for direct `db.prepare(` / `getDb().prepare(`
 * and fails the commit on any hit. That is the right policy for NEW usage,
 * but it was previously all-or-nothing at FILE granularity: a file that
 * already contained unmigrated call sites could never be edited again for
 * ANY reason — including a one-line import-specifier fix — without the gate
 * firing on debt the edit did not introduce and did not touch. That is a
 * broken gate: it taxes unrelated work while doing nothing about the
 * existing debt.
 *
 * This file narrows the exception from "whole file, forever" to "these exact
 * (path, line) sites". The rule stays fully armed everywhere else, INCLUDING
 * elsewhere in the very same file.
 *
 * The three whole-file exemptions in lefthook.yml (lib/db.ts, server/db.js,
 * server/queries/index.ts) are unchanged and remain file-level — those are
 * the wrapper/bootstrap/registry themselves, which legitimately own the
 * primitive. This allowlist is only for grandfathered debt outside them.
 *
 * SHAPE MIRRORS THE REPO'S OWN PRECEDENT
 * --------------------------------------
 * packages/polyfill-connectors/scripts/no-await-in-loops-allowlist.ts +
 * check-no-await-in-loops-conformance.ts: a checked-in exact allowlist keyed
 * on source location, enforced by a gate that fails on BOTH directions of
 * divergence. `check-direct-prepare-conformance.ts` implements the same
 * three failure modes here:
 *
 *   1. NEW/UNLISTED — a live direct-prepare hit whose (path, line) is not
 *      listed. This is the check the policy exists for, and it fires for a
 *      new call site in an allowlisted file exactly as it does anywhere else.
 *   2. STALE — a listed row the scanner no longer finds at that location.
 *      The code moved, was rewritten, or was migrated to the wrapper. The
 *      exception is no longer attached to real code and must be re-reviewed
 *      (re-pointed or, preferably, deleted) rather than carried forever.
 *   3. DUPLICATE — the same (path, line) listed twice. A structural defect in
 *      this file, checked before any scanning so it cannot be masked.
 *
 * These entries are DEBT, not a blessing. `grandfathered_pre_wrapper` means
 * "predates the bounded-statement wrapper policy and has not been migrated
 * yet" — the correct end state is that every row below is deleted, having
 * been converted to the typed primitives in lib/db.ts (getOne / getMany /
 * iterate / exec / allowUnboundedReadAcknowledged /
 * iterateDynamicSqlAcknowledged). Migrating them is deliberately NOT bundled
 * into whatever change happens to touch the file next.
 *
 * Spec: openspec/specs/reference-implementation-architecture/spec.md
 *       "New direct DB prepare usage SHALL be blocked at the staged-file boundary"
 */

/** Why a listed site is not (yet) using the typed wrapper primitives. */
export type DirectPrepareReasonCategory = "grandfathered_pre_wrapper";

export interface DirectPrepareAllowlistEntry {
  readonly category: DirectPrepareReasonCategory;
  /** 1-based line number of the direct-prepare hit. */
  readonly line: number;
  /** Specific, non-generic note naming the actual call site. */
  readonly note: string;
  /** Repo-root-relative POSIX path, exactly as lefthook passes staged files. */
  readonly path: string;
}

export const DIRECT_PREPARE_ALLOWLIST: readonly DirectPrepareAllowlistEntry[] = [
  {
    category: "grandfathered_pre_wrapper",
    line: 267,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: CREATE TEMP TABLE IF NOT EXISTS _vstats_wanted_keys. Re-derived 2026-08-10 (ri-zero-knowledge-terminal-revise-0810): moved from 252 after the compactionClass/reviewed-residue resolution imports and helpers were added earlier in the file; the call site itself is unchanged.",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 274,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: DELETE FROM _vstats_wanted_keys before repopulating it. Re-derived 2026-08-10 (ri-zero-knowledge-terminal-revise-0810): moved from 259, same cause as above.",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 275,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: prepared INSERT OR IGNORE reused once per wanted key. Re-derived 2026-08-10 (ri-zero-knowledge-terminal-revise-0810): moved from 260, same cause as above.",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 317,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: DELETE FROM _vstats_wanted_keys cleanup after the scan returns. Re-derived 2026-08-10 (ri-zero-knowledge-terminal-revise-0810): moved from 302, same cause as above.",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 8687,
    note: "backfillSqliteRecordSemanticTimesForManifest: prepared UPDATE records SET semantic_time = ? (per-record backfill write inside the writeTransaction). Re-derived 2026-08-11 (source-revision canonical-write isolation): the call site is unchanged; records.ts line drifted after removing a derived evidence touch.",
    path: "reference-implementation/server/records.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 450,
    note: "applyDatasetSummaryRecordDelta: prepared upsert of the per-stream projection row",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 982,
    note: "updateReconciledStreamRows: prepared optimistic record-time-bounds update inside the reconcile transaction",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1053,
    note: "assertDeltaCanUseStreamProjection: prepared stream-count guard query",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1159,
    note: "replaceStreamProjections: prepared projection-table replacement delete",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1160,
    note: "replaceStreamProjections: prepared stream-projection insert reused for the rebuild batch",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 484,
    note: "createRetainedSizeSqliteStore.listConnectionRows: dynamic filtered connection-row read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 498,
    note: "createRetainedSizeSqliteStore.listStreamRows: dynamic filtered stream-row read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1320,
    note: "applyRetainedSizeDelta: prepared retained-size projection delta upsert",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1427,
    note: "rebuildSqlite: prepared retained-size stream projection replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1428,
    note: "rebuildSqlite: prepared retained-size connection projection replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1429,
    note: "rebuildSqlite: prepared retained-size record-family projection replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1479,
    note: "rebuildSqlite: prepared retained-size stream insert reused for the rebuild batch",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1506,
    note: "rebuildSqlite: prepared retained-size connection insert reused for the rebuild batch",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1535,
    note: "rebuildSqlite: prepared retained-size global projection upsert",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1880,
    note: "refreshRetainedSizeTopRowsSqlite: prepared top-row insert reused for each scope and measure",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1897,
    note: "refreshRetainedSizeTopRowsSqlite: prepared top-row replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2396,
    note: "reconcileDirtySqlite: prepared dirty-stream reconciliation read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2428,
    note: "reconcileDirtySqlite: prepared dirty-connection reconciliation read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 431,
    note: "createRetainedSizeSqliteStore.getGlobalRow: retained-size global projection read including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 445,
    note: "createRetainedSizeSqliteStore.listConnectionRows: filtered retained-size connection projection read including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 457,
    note: "createRetainedSizeSqliteStore.listConnectionRows: unfiltered retained-size connection projection read including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 501,
    note: "createRetainedSizeSqliteStore.listTopRows: retained-size top-row read including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 517,
    note: "createRetainedSizeSqliteStore.markConnectionRowsDirty: mark retained-size streams dirty for a connection",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 520,
    note: "createRetainedSizeSqliteStore.markConnectionRowsDirty: mark retained-size connection dirty",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 525,
    note: "createRetainedSizeSqliteStore.markStreamRowsDirty: mark one retained-size stream dirty",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 528,
    note: "createRetainedSizeSqliteStore.markStreamRowsDirty: mark parent retained-size connection dirty",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 533,
    note: "createRetainedSizeSqliteStore.updateGlobalFresh: update retained-size global fresh state",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 541,
    note: "createRetainedSizeSqliteStore.updateGlobalFailed: upsert retained-size global failed state",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 555,
    note: "createRetainedSizeSqliteStore.updateGlobalRebuilding: upsert retained-size global rebuilding state",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 566,
    note: "listRetainedSizeConnectionsByInstanceIds: chunked retained-size connection projection read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 662,
    note: "fetchRetainedSizeStreamRowsByInstanceIds: chunked retained-size stream projection read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 725,
    note: "fetchRetainedSizeRecordFamilyRowsByInstanceIds: chunked retained-size record-family projection read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1002,
    note: "upsertStreamRowSqlite: retained-size stream projection delta upsert including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1106,
    note: "upsertConnectionRowSqlite: retained-size connection projection delta upsert including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1205,
    note: "applyGlobalDeltaSqlite: retained-size global projection delta upsert including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1431,
    note: "rebuildSqlite: aggregate current record bytes for retained-size stream rebuild",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1441,
    note: "rebuildSqlite: aggregate record history bytes for retained-size stream rebuild",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1450,
    note: "rebuildSqlite: aggregate blob bytes for retained-size stream rebuild",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1462,
    note: "rebuildSqlite: aggregate record rejection bytes for retained-size stream rebuild",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1919,
    note: "refreshRetainedSizeTopRowsSqlite: connection top rows by retained-size measure",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1936,
    note: "refreshRetainedSizeTopRowsSqlite: stream top rows by retained-size measure",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1956,
    note: "refreshRetainedSizeTopRowsSqlite: record current-json top rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1978,
    note: "refreshRetainedSizeTopRowsSqlite: record history-json top rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2000,
    note: "refreshRetainedSizeTopRowsSqlite: record total-retained top rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2075,
    note: "refreshRetainedSizeTopRowsSqlite: blob bytes top rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2098,
    note: "refreshRetainedSizeTopRowsSqlite: blob total-retained top rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2333,
    note: "reconcileDirtySqlite: select dirty retained-size stream rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2346,
    note: "reconcileDirtySqlite: select dirty retained-size connection rows",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2364,
    note: "reconcileDirtyStreamSqlite: recompute one dirty stream including rejection measures",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2413,
    note: "reconcileDirtyConnectionSqlite: recompute one dirty connection from stream projections",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2453,
    note: "recomputeGlobalFromConnectionsSqlite: recompute global retained-size projection from connections",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2470,
    note: "recomputeGlobalFromConnectionsSqlite: upsert global retained-size projection after dirty reconciliation",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
];
