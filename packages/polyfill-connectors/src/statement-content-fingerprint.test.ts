/**
 * Tests for statement-content-fingerprint.ts — the shared content-gated
 * exclusion rule for chase/statements and usaa/statements.
 *
 * Covers OpenSpec add-statement-content-fingerprint §3 acceptance checks:
 *   AC-1  blob-only churn with identical content → same fingerprint (no-op)
 *   AC-2  different pdf_text_sha256 or pdf_page_count → distinct fingerprint
 *   AC-3  USAA account_id null→value stays a fingerprint boundary
 *   AC-4  content-less version adjacent to content-bearing → not collapsed
 *   AC-5  normalization collapses whitespace/line-wrap jitter to same sha
 *   AC-6  extraction failure fails closed to conservative behavior
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  STATEMENT_BLOB_IDENTITY_KEYS,
  STATEMENT_CONTENT_GATED_EXCLUDE_KEYS,
  STATEMENT_RUN_CLOCK_EXCLUDE_KEYS,
  hasStatementContentFingerprint,
  normalizeStatementText,
  statementContentFingerprintFromText,
  statementFingerprintExcludeKeys,
} from "./statement-content-fingerprint.ts";
import { recordFingerprint } from "./fingerprint-cursor.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

const TEXT_SHA = "a".repeat(64);
const CONTENT_BEARING = {
  id: "stmt-001",
  account_id: "ACCT-001",
  title: "April 2026",
  date_delivered: "2026-04-13",
  account_reference: "Checking *9241",
  document_url: "file:///tmp/2026-04-aaaa.pdf",
  pdf_path: "/tmp/2026-04-aaaa.pdf",
  pdf_sha256: "a".repeat(64),
  pdf_text_sha256: TEXT_SHA,
  pdf_page_count: 2,
  fetched_at: "2026-04-22T12:00:00.000Z",
};

// Blob-only churn: document_url/pdf_path/pdf_sha256 change, content unchanged.
const BLOB_CHURNED = {
  ...CONTENT_BEARING,
  document_url: "file:///tmp/2026-04-bbbb.pdf",
  pdf_path: "/tmp/2026-04-bbbb.pdf",
  pdf_sha256: "b".repeat(64),
  fetched_at: "2026-05-01T08:00:00.000Z",
};

// Content-less: index-only, no pdf_text_sha256 / pdf_page_count.
const CONTENT_LESS = {
  id: "stmt-001",
  account_id: "ACCT-001",
  title: "April 2026",
  date_delivered: "2026-04-13",
  account_reference: "Checking *9241",
  document_url: null,
  pdf_path: null,
  pdf_sha256: null,
  pdf_text_sha256: null,
  pdf_page_count: null,
  fetched_at: "2026-04-22T12:00:00.000Z",
};

// ─── hasStatementContentFingerprint ───────────────────────────────────────

test("hasStatementContentFingerprint: true when both fields present and valid", () => {
  assert.ok(hasStatementContentFingerprint(CONTENT_BEARING));
});

test("hasStatementContentFingerprint: false when pdf_text_sha256 null", () => {
  assert.ok(!hasStatementContentFingerprint({ ...CONTENT_BEARING, pdf_text_sha256: null }));
});

test("hasStatementContentFingerprint: false when pdf_page_count null", () => {
  assert.ok(!hasStatementContentFingerprint({ ...CONTENT_BEARING, pdf_page_count: null }));
});

test("hasStatementContentFingerprint: false when pdf_page_count zero", () => {
  assert.ok(!hasStatementContentFingerprint({ ...CONTENT_BEARING, pdf_page_count: 0 }));
});

test("hasStatementContentFingerprint: false when both null (content-less)", () => {
  assert.ok(!hasStatementContentFingerprint(CONTENT_LESS));
});

// ─── statementFingerprintExcludeKeys ──────────────────────────────────────

test("statementFingerprintExcludeKeys: content-bearing → full content-gated exclusion", () => {
  const keys = statementFingerprintExcludeKeys(CONTENT_BEARING);
  assert.deepEqual([...keys].sort(), [...STATEMENT_CONTENT_GATED_EXCLUDE_KEYS].sort());
  // blob keys AND run clock are excluded
  for (const k of STATEMENT_BLOB_IDENTITY_KEYS) assert.ok(keys.includes(k), `missing blob key ${k}`);
  assert.ok(keys.includes("fetched_at"));
});

test("statementFingerprintExcludeKeys: content-less → conservative run-clock-only", () => {
  const keys = statementFingerprintExcludeKeys(CONTENT_LESS);
  assert.deepEqual([...keys].sort(), [...STATEMENT_RUN_CLOCK_EXCLUDE_KEYS].sort());
  // blob keys must NOT be excluded
  for (const k of STATEMENT_BLOB_IDENTITY_KEYS) assert.ok(!keys.includes(k), `blob key ${k} must not be excluded`);
});

// ─── AC-1: blob-only churn is a no-op when content fields present ─────────

test("AC-1: blob-only churn with identical content fields → same fingerprint", () => {
  const fp1 = recordFingerprint(CONTENT_BEARING, statementFingerprintExcludeKeys(CONTENT_BEARING));
  const fp2 = recordFingerprint(BLOB_CHURNED, statementFingerprintExcludeKeys(BLOB_CHURNED));
  assert.equal(fp1, fp2, "blob churn should produce identical fingerprints when content fields match");
});

test("AC-1: blob-only churn with run-clock change → same fingerprint", () => {
  const later = { ...CONTENT_BEARING, fetched_at: "2026-06-01T00:00:00.000Z" };
  const fp1 = recordFingerprint(CONTENT_BEARING, statementFingerprintExcludeKeys(CONTENT_BEARING));
  const fp2 = recordFingerprint(later, statementFingerprintExcludeKeys(later));
  assert.equal(fp1, fp2);
});

// ─── AC-2: genuine content change → distinct fingerprint ──────────────────

test("AC-2: different pdf_text_sha256 → distinct fingerprint", () => {
  const changed = { ...CONTENT_BEARING, pdf_text_sha256: "b".repeat(64) };
  const fp1 = recordFingerprint(CONTENT_BEARING, statementFingerprintExcludeKeys(CONTENT_BEARING));
  const fp2 = recordFingerprint(changed, statementFingerprintExcludeKeys(changed));
  assert.notEqual(fp1, fp2, "different pdf_text_sha256 must change the fingerprint");
});

test("AC-2: different pdf_page_count → distinct fingerprint", () => {
  const changed = { ...CONTENT_BEARING, pdf_page_count: 3 };
  const fp1 = recordFingerprint(CONTENT_BEARING, statementFingerprintExcludeKeys(CONTENT_BEARING));
  const fp2 = recordFingerprint(changed, statementFingerprintExcludeKeys(changed));
  assert.notEqual(fp1, fp2, "different pdf_page_count must change the fingerprint");
});

// ─── AC-3: USAA account_id null→value stays a fingerprint boundary ────────

test("AC-3: account_id null→value is always a fingerprint boundary", () => {
  const nullAccountId = { ...CONTENT_BEARING, account_id: null };
  const fp1 = recordFingerprint(nullAccountId, statementFingerprintExcludeKeys(nullAccountId));
  const fp2 = recordFingerprint(CONTENT_BEARING, statementFingerprintExcludeKeys(CONTENT_BEARING));
  assert.notEqual(fp1, fp2, "account_id null→value must change the fingerprint (never excluded)");
});

// ─── AC-4: content-less version not collapsed with content-bearing ─────────

test("AC-4: content-less version and content-bearing version have distinct fingerprints", () => {
  const fp1 = recordFingerprint(CONTENT_LESS, statementFingerprintExcludeKeys(CONTENT_LESS));
  const fp2 = recordFingerprint(CONTENT_BEARING, statementFingerprintExcludeKeys(CONTENT_BEARING));
  assert.notEqual(fp1, fp2, "a content-less version must not collapse into a content-bearing version");
});

test("AC-4: two content-less versions with same body are same fingerprint (conservative behavior preserved)", () => {
  const later = { ...CONTENT_LESS, fetched_at: "2026-05-01T00:00:00.000Z" };
  const fp1 = recordFingerprint(CONTENT_LESS, statementFingerprintExcludeKeys(CONTENT_LESS));
  const fp2 = recordFingerprint(later, statementFingerprintExcludeKeys(later));
  assert.equal(fp1, fp2, "content-less: only fetched_at excluded, same body → same fingerprint");
});

// ─── AC-5: normalization collapses whitespace/line-wrap jitter ────────────

test("AC-5: normalizeStatementText collapses whitespace runs to single space", () => {
  const a = normalizeStatementText("Hello   World\n\nFoo\tBar");
  const b = normalizeStatementText("Hello World Foo Bar");
  assert.equal(a, b, "whitespace-normalized text must be identical");
});

test("AC-5: statementContentFingerprintFromText: same text with jitter → same sha256", () => {
  const fp1 = statementContentFingerprintFromText("Hello   World\nFoo\t\tBar", 2);
  const fp2 = statementContentFingerprintFromText("Hello World Foo Bar", 2);
  assert.equal(fp1.pdf_text_sha256, fp2.pdf_text_sha256);
  assert.equal(fp1.pdf_page_count, fp2.pdf_page_count);
});

test("AC-5: statementContentFingerprintFromText: NFC normalization is applied", () => {
  // é as precomposed (U+00E9) vs decomposed (e + U+0301)
  const precomposed = "café";
  const decomposed = "café";
  const fp1 = statementContentFingerprintFromText(precomposed, 1);
  const fp2 = statementContentFingerprintFromText(decomposed, 1);
  assert.equal(fp1.pdf_text_sha256, fp2.pdf_text_sha256, "NFC must unify precomposed and decomposed forms");
});

// ─── AC-6: extraction failure fails closed ────────────────────────────────

test("AC-6: empty text → all-null fingerprint (fail closed)", () => {
  const fp = statementContentFingerprintFromText("", 2);
  assert.equal(fp.pdf_text_sha256, null);
  assert.equal(fp.pdf_page_count, null);
});

test("AC-6: whitespace-only text → all-null fingerprint (fail closed)", () => {
  const fp = statementContentFingerprintFromText("   \n\t  ", 2);
  assert.equal(fp.pdf_text_sha256, null);
  assert.equal(fp.pdf_page_count, null);
});

test("AC-6: null text → all-null fingerprint (fail closed)", () => {
  const fp = statementContentFingerprintFromText(null, 2);
  assert.equal(fp.pdf_text_sha256, null);
  assert.equal(fp.pdf_page_count, null);
});

test("AC-6: invalid page count with real text → pdf_page_count null only", () => {
  const fp = statementContentFingerprintFromText("Real statement text", 0);
  assert.notEqual(fp.pdf_text_sha256, null, "text sha should still be set");
  assert.equal(fp.pdf_page_count, null, "invalid page count should be null");
});
