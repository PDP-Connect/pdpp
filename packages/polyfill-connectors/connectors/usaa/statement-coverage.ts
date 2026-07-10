// Per-run detail-coverage evidence for the USAA `statements` stream.
//
// `statements` is a list-plus-detail stream: the /my/documents index page is
// the enumerated list (every statement index row), and each statement-document
// row has a PDF "detail" the connector hydrates by driving the row's
// Options -> Download menu. That makes the denominator REAL — it is the set of
// statement-document rows the run actually saw on the list, not a guess — so a
// DETAIL_COVERAGE report can honestly distinguish a complete run (every
// candidate PDF present) from a partial one (some PDFs missing this run).
//
// Denominator (required_keys / considered): statement-document rows only. USAA's
// document index mixes statements with agreements / disclosures / notices;
// those are index-only by design (no PDF detail is expected for them), so they
// are NOT detail candidates and are excluded from the denominator rather than
// counted as perpetual gaps. The same `shouldParseStatementTitle` predicate
// the transaction-parse path uses decides candidacy, so coverage and parsing
// agree on what a "statement" is.
//
// Numerator (hydrated_keys / covered): candidates whose resolved body carries a
// present, content-addressed PDF pointer this run — a fresh download OR a
// carried-forward prior pointer (the bytes a prior run stored still exist; see
// statement-hydration-carry-forward.ts). `isHydrated()` is the shared predicate
// for "artifact present", so coverage never disagrees with the emitted body.
//
// Gaps (gap_keys + DETAIL_GAP): candidates with no present artifact this run.
// A statement PDF that failed to download is genuinely retryable — a fresh run
// re-attempts every row — so each gap candidate gets a pending, retryable
// DETAIL_GAP. That is also what the runtime's coverage-completeness invariant
// requires: every required_key must be hydrated or carried by a pending gap,
// so required_keys === hydrated_keys ∪ gap_keys by construction here.
//
// Redaction: the only key that ever leaves this module is the statement `id`,
// which is an opaque `hashId(...)` hash — never a title, account number, or
// account name. The DETAIL_GAP `detail_locator` carries that hash and a static
// `kind` only. This keeps the progress-signal privacy invariant intact.

import type { DetailCoverageParams, DetailGapMessage } from "../../src/connector-runtime.ts";
import { isHydrated, type StatementHydration } from "../../src/statement-hydration-carry-forward.ts";

/** The `statements` list stream is both the list and the detail-anchor: the
 *  index row IS the parent, and the PDF is its detail enrichment. */
export const STATEMENTS_STREAM = "statements";

/** One row's resolved hydration outcome, as `emitStatementRecords` already
 *  computes it. `pointers` is the body the record carries (fresh, carried, or
 *  all-null); `isHydrated(pointers)` decides artifact-present. `isCandidate` is
 *  the caller's statement-document decision (`shouldParseStatementTitle`) —
 *  passed in so this module stays a pure, dependency-free leaf and never forms
 *  an import cycle with the connector's `index.ts`. */
export interface StatementCoverageRow {
  id: string;
  isCandidate: boolean;
  pointers: StatementHydration;
}

/** The coverage decision for a run: the params for one DETAIL_COVERAGE plus the
 *  redacted DETAIL_GAP messages to emit (one per gap candidate) before it.
 *  `candidateCount === 0` means the run saw no statement-document rows — the
 *  caller still emits the resulting `considered: 0` / `covered: 0` coverage
 *  (as long as enumeration itself completed) so a steady-state zero-candidate
 *  run stays measured rather than silently unreported. */
export interface StatementCoverageResult {
  candidateCount: number;
  coverage: DetailCoverageParams;
  gaps: DetailGapMessage[];
}

/** Build a redacted, pending, retryable DETAIL_GAP for a statement-document row
 *  whose PDF is not present this run. Reference-only (never promoted to portable
 *  protocol). The locator carries the opaque statement id hash and a static
 *  `kind` — no title, account reference, or path. `temporary_unavailable` is
 *  the honest reason: a statement PDF download is always retried on the next
 *  run, so the gap is recoverable, not terminal. */
export function buildStatementDetailGap(id: string): DetailGapMessage {
  return {
    type: "DETAIL_GAP",
    stream: STATEMENTS_STREAM,
    record_key: id,
    status: "pending",
    reason: "temporary_unavailable",
    detail_locator: {
      kind: "usaa.statement",
      statement_id: id,
    },
    retryable: true,
    reference_only: true,
  };
}

/** Compute per-run statement detail coverage from the resolved rows.
 *
 *  - required_keys: statement-document candidates (`shouldParseStatementTitle`).
 *  - hydrated_keys: candidates with a present PDF artifact (`isHydrated`).
 *  - gap_keys: candidates with no artifact this run; one DETAIL_GAP each.
 *
 *  Non-statement rows (disclosures/agreements) are not candidates and never
 *  appear in any key set. The result is self-consistent for the runtime's
 *  coverage-completeness check: required === hydrated ∪ gap.
 *
 *  Duplicate ids (the same statement listed twice) are de-duplicated so the
 *  coverage key sets stay set-like; the first occurrence's hydration state wins
 *  for that id, and a later hydrated occurrence upgrades a pending gap to
 *  hydrated (a present artifact is the more honest, less-alarming outcome). */
export function computeStatementCoverage(rows: readonly StatementCoverageRow[]): StatementCoverageResult {
  const hydratedIds = new Set<string>();
  const gapIds = new Set<string>();
  const requiredOrder: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row.isCandidate) {
      continue;
    }
    if (!seen.has(row.id)) {
      seen.add(row.id);
      requiredOrder.push(row.id);
    }
    if (isHydrated(row.pointers)) {
      hydratedIds.add(row.id);
      // A present artifact for this id supersedes a gap recorded for an
      // earlier duplicate occurrence: do not report a gap for something we
      // actually have.
      gapIds.delete(row.id);
    } else if (!hydratedIds.has(row.id)) {
      gapIds.add(row.id);
    }
  }

  const requiredKeys = requiredOrder;
  const hydratedKeys = requiredOrder.filter((id) => hydratedIds.has(id));
  const gapKeys = requiredOrder.filter((id) => gapIds.has(id));

  return {
    candidateCount: requiredKeys.length,
    coverage: {
      stream: STATEMENTS_STREAM,
      stateStream: STATEMENTS_STREAM,
      requiredKeys,
      hydratedKeys,
      considered: requiredKeys.length,
      covered: hydratedKeys.length,
      ...(gapKeys.length ? { gapKeys } : {}),
    },
    gaps: gapKeys.map((id) => buildStatementDetailGap(id)),
  };
}
