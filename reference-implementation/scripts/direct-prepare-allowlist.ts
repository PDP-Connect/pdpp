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
    line: 252,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: CREATE TEMP TABLE IF NOT EXISTS _vstats_wanted_keys",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 259,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: DELETE FROM _vstats_wanted_keys before repopulating it",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 260,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: prepared INSERT OR IGNORE reused once per wanted key",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 302,
    note: "getRecordVersionStatsStore().listGroundTruthForKeys: DELETE FROM _vstats_wanted_keys cleanup after the scan returns",
    path: "reference-implementation/server/record-version-stats.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 7272,
    note: "backfillSqliteRecordSemanticTimesForManifest: prepared UPDATE records SET semantic_time = ? (per-record backfill write inside the writeTransaction)",
    path: "reference-implementation/server/records.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 391,
    note: "applyDatasetSummaryRecordDelta: prepared upsert of the per-stream projection row",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 757,
    note: "updateReconciledStreamRows: prepared optimistic record-time-bounds update inside the reconcile transaction",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 828,
    note: "assertDeltaCanUseStreamProjection: prepared stream-count guard query",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 934,
    note: "replaceStreamProjections: prepared projection-table replacement delete",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 935,
    note: "replaceStreamProjections: prepared stream-projection insert reused for the rebuild batch",
    path: "reference-implementation/server/dataset-summary-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 455,
    note: "createRetainedSizeSqliteStore.listConnectionRows: dynamic filtered connection-row read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 468,
    note: "createRetainedSizeSqliteStore.listStreamRows: dynamic filtered stream-row read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1111,
    note: "applyRetainedSizeDelta: prepared retained-size projection delta upsert",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1218,
    note: "rebuildSqlite: prepared retained-size stream projection replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1219,
    note: "rebuildSqlite: prepared retained-size connection projection replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1220,
    note: "rebuildSqlite: prepared retained-size record-family projection replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1260,
    note: "rebuildSqlite: prepared retained-size stream insert reused for the rebuild batch",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1284,
    note: "rebuildSqlite: prepared retained-size connection insert reused for the rebuild batch",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1310,
    note: "rebuildSqlite: prepared retained-size global projection upsert",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1620,
    note: "refreshRetainedSizeTopRowsSqlite: prepared top-row insert reused for each scope and measure",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 1636,
    note: "refreshRetainedSizeTopRowsSqlite: prepared top-row replacement delete",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2122,
    note: "reconcileDirtySqlite: prepared dirty-stream reconciliation read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
  {
    category: "grandfathered_pre_wrapper",
    line: 2150,
    note: "reconcileDirtySqlite: prepared dirty-connection reconciliation read",
    path: "reference-implementation/server/retained-size-read-model.ts",
  },
];
