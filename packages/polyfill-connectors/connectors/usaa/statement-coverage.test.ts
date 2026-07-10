/**
 * Unit tests for the pure USAA statement detail-coverage helper.
 *
 * These prove the honesty + invariant properties the runtime relies on, with
 * no Playwright and no emit path:
 *   - required_keys is the REAL denominator: statement-document candidates only
 *     (disclosures/agreements excluded),
 *   - hydrated_keys counts a present artifact (fresh OR carried-forward),
 *   - gap_keys + one DETAIL_GAP each cover every un-hydrated candidate, so
 *     required === hydrated ∪ gap (the runtime's coverage-completeness check),
 *   - zero candidates => candidateCount 0 with empty key sets (the caller,
 *     `emitStatementCoverage` in index.ts, still emits this as a real
 *     considered:0/covered:0 DETAIL_COVERAGE when statement enumeration
 *     completed — see integration.test.ts for that emit-path assertion),
 *   - the only key that leaves the module is the opaque statement id hash —
 *     never a title or account reference.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StatementHydration } from "../../src/statement-hydration-carry-forward.ts";
import {
  buildStatementDetailGap,
  computeStatementCoverage,
  STATEMENTS_STREAM,
  type StatementCoverageRow,
} from "./statement-coverage.ts";

const HYDRATED: StatementHydration = {
  document_url: "file:///home/user/.pdpp/usaa-statements/chk/2026-04-aaaaaaaa.pdf",
  pdf_path: "/home/user/.pdpp/usaa-statements/chk/2026-04-aaaaaaaa.pdf",
  pdf_sha256: "aa".repeat(32),
};
const NULL_POINTERS: StatementHydration = { document_url: null, pdf_path: null, pdf_sha256: null };

function candidate(id: string, pointers: StatementHydration): StatementCoverageRow {
  return { id, isCandidate: true, pointers };
}
function nonCandidate(id: string, pointers: StatementHydration = NULL_POINTERS): StatementCoverageRow {
  return { id, isCandidate: false, pointers };
}

test("fully hydrated run: required === hydrated, no gaps", () => {
  const result = computeStatementCoverage([candidate("s1", HYDRATED), candidate("s2", HYDRATED)]);
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.coverage.requiredKeys, ["s1", "s2"]);
  assert.deepEqual(result.coverage.hydratedKeys, ["s1", "s2"]);
  assert.equal(result.coverage.considered, 2);
  assert.equal(result.coverage.covered, 2);
  assert.equal(result.coverage.gapKeys, undefined, "no gap_keys when fully hydrated");
  assert.equal(result.gaps.length, 0);
  assert.equal(result.coverage.stream, STATEMENTS_STREAM);
  assert.equal(result.coverage.stateStream, STATEMENTS_STREAM);
});

test("partial run: un-hydrated candidate becomes a gap with a matching DETAIL_GAP", () => {
  const result = computeStatementCoverage([candidate("s1", HYDRATED), candidate("s2", NULL_POINTERS)]);
  assert.deepEqual(result.coverage.requiredKeys, ["s1", "s2"]);
  assert.deepEqual(result.coverage.hydratedKeys, ["s1"]);
  assert.equal(result.coverage.considered, 2);
  assert.equal(result.coverage.covered, 1);
  assert.deepEqual(result.coverage.gapKeys, ["s2"]);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0]?.record_key, "s2");
});

test("required === hydrated ∪ gap for every run (runtime coverage-completeness invariant)", () => {
  const rows = [
    candidate("a", HYDRATED),
    candidate("b", NULL_POINTERS),
    candidate("c", HYDRATED),
    candidate("d", NULL_POINTERS),
    nonCandidate("e"),
  ];
  const { coverage } = computeStatementCoverage(rows);
  const union = new Set([...coverage.hydratedKeys, ...(coverage.gapKeys ?? [])]);
  assert.equal(union.size, coverage.requiredKeys.length);
  for (const key of coverage.requiredKeys) {
    assert.ok(union.has(key), `required key ${String(key)} must be hydrated or a gap`);
  }
});

test("carried-forward artifact counts as hydrated, not a gap", () => {
  // A failed re-download that carried the prior pointer forward has a present
  // artifact — the bytes a prior run stored still exist — so it is hydrated.
  const result = computeStatementCoverage([candidate("s1", HYDRATED)]);
  assert.deepEqual(result.coverage.hydratedKeys, ["s1"]);
  assert.equal(result.gaps.length, 0);
});

test("non-statement rows (disclosures/agreements) are excluded from the denominator", () => {
  const result = computeStatementCoverage([
    candidate("stmt", HYDRATED),
    nonCandidate("disclosure", NULL_POINTERS),
    nonCandidate("agreement", HYDRATED),
  ]);
  assert.deepEqual(result.coverage.requiredKeys, ["stmt"], "only the statement is a candidate");
  assert.equal(result.candidateCount, 1);
});

test("zero statement candidates => candidateCount 0 with empty key sets (the pure compute step, not the emit decision)", () => {
  const result = computeStatementCoverage([nonCandidate("disclosure"), nonCandidate("agreement")]);
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(result.coverage.requiredKeys, []);
  assert.equal(result.gaps.length, 0);
});

test("empty input => candidateCount 0", () => {
  const result = computeStatementCoverage([]);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.gaps.length, 0);
});

test("duplicate ids de-duplicate; a later hydrated occurrence upgrades a gap", () => {
  // Same id appears twice: first all-null (gap), then with an artifact. The
  // present artifact wins — we never report a gap for something we have.
  const result = computeStatementCoverage([candidate("dup", NULL_POINTERS), candidate("dup", HYDRATED)]);
  assert.deepEqual(result.coverage.requiredKeys, ["dup"], "id appears once in required_keys");
  assert.deepEqual(result.coverage.hydratedKeys, ["dup"]);
  assert.equal(result.coverage.gapKeys, undefined);
  assert.equal(result.gaps.length, 0);
});

test("duplicate ids: an earlier hydrated occurrence is not undone by a later null", () => {
  const result = computeStatementCoverage([candidate("dup", HYDRATED), candidate("dup", NULL_POINTERS)]);
  assert.deepEqual(result.coverage.hydratedKeys, ["dup"]);
  assert.equal(result.coverage.gapKeys, undefined);
  assert.equal(result.gaps.length, 0);
});

test("DETAIL_GAP shape: pending, retryable, reference-only, redacted locator", () => {
  const gap = buildStatementDetailGap("stmt-hash-123");
  assert.equal(gap.type, "DETAIL_GAP");
  assert.equal(gap.stream, STATEMENTS_STREAM);
  assert.equal(gap.record_key, "stmt-hash-123");
  assert.equal(gap.status, "pending");
  assert.equal(gap.retryable, true);
  assert.equal(gap.reference_only, true);
  assert.equal(gap.reason, "temporary_unavailable");
  assert.deepEqual(gap.detail_locator, { kind: "usaa.statement", statement_id: "stmt-hash-123" });
});

test("redaction: no title or account text ever appears in coverage or gap output", () => {
  // The ids carry an opaque hash; titles/account refs are passed only via the
  // boolean isCandidate decision, never copied into the output. The match
  // patterns target the document-title / account-reference PII shapes, NOT the
  // legitimate lowercase protocol identifiers (`statements`, `statement_id`).
  const result = computeStatementCoverage([
    { id: "OPAQUE-HASH-1", isCandidate: true, pointers: NULL_POINTERS },
    { id: "OPAQUE-HASH-2", isCandidate: true, pointers: HYDRATED },
  ]);
  const serialized = JSON.stringify({ coverage: result.coverage, gaps: result.gaps });
  // Account-name / last-four / document-title-word PII shapes — none of which
  // this module ever receives, let alone emits.
  assert.doesNotMatch(serialized, /CHECKING|SAVINGS|\bUSAA\b|\*\d{4}|\b[A-Z][a-z]+ \d{4}\b/);
  assert.match(serialized, /OPAQUE-HASH-1/);
});
