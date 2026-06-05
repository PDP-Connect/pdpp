// Content-derived fingerprint for PDF-statement streams (chase/statements,
// usaa/statements).
//
// A statement PDF's `pdf_sha256` is the sha256 of the *raw bytes*, not the
// content. Chase statement PDFs are RC4-encrypted and the source regenerates
// the per-download encryption key material and embedded generation timestamps
// on every fetch, so `pdf_sha256` (and the `pdf_path`/`document_url` that embed
// it) moves with zero change to the decrypted text or page count. The read-only
// evidence lane (tmp/workstreams/ri-version-rationality-evidence-v1-report.md)
// proved the decrypted text sha and page count are invariant across that churn.
//
// This module owns the positive, owner-visible content fingerprint that makes
// excluding those blob/acquisition-identity fields from the canonical
// fingerprint *lossless*: a re-download with unchanged content is provably a
// no-op without inspecting raw bytes, and a genuinely re-issued statement still
// moves `pdf_text_sha256` or `pdf_page_count` and stays a version boundary.
//
// It is connector-independent: the gate is expressed over the record shape
// (presence of the two content fields), not over which connector emitted the
// record, so any statement-bearing connector that emits the fields inherits the
// same canonical eligibility.

import { createHash } from "node:crypto";

/** The two positive content-fingerprint fields a statement record carries. */
export const STATEMENT_CONTENT_FIELDS = ["pdf_text_sha256", "pdf_page_count"] as const;

/** The blob/acquisition-identity fields that move on every re-download with no
 *  owner-visible content change. `pdf_path` and `document_url` embed the
 *  `pdf_sha256`, so all three move together; `fetched_at` is the run clock. */
export const STATEMENT_BLOB_IDENTITY_KEYS = ["pdf_sha256", "pdf_path", "document_url"] as const;

/** The run-clock-only exclusion used when the positive content fields are
 *  absent — identical to the conservative pre-content behavior. */
export const STATEMENT_RUN_CLOCK_EXCLUDE_KEYS = ["fetched_at"] as const;

/** The full content-gated exclusion used when both content fields are present:
 *  the blob/acquisition-identity fields PLUS the run clock. */
export const STATEMENT_CONTENT_GATED_EXCLUDE_KEYS = [
  ...STATEMENT_BLOB_IDENTITY_KEYS,
  ...STATEMENT_RUN_CLOCK_EXCLUDE_KEYS,
] as const;

/** The positive content fingerprint a connector emits per statement. Both
 *  fields are `null` when text extraction failed or returned empty text
 *  (fail-closed). */
export interface StatementContentFingerprint {
  pdf_text_sha256: string | null;
  pdf_page_count: number | null;
}

/** The all-null fingerprint emitted on extraction failure / empty text. */
export const NO_STATEMENT_CONTENT_FINGERPRINT: StatementContentFingerprint = {
  pdf_text_sha256: null,
  pdf_page_count: null,
};

const WHITESPACE_RUN_RE = /\s+/g;

/**
 * Deterministic normalization of extracted PDF text so the sha is stable
 * across text-extractor whitespace/line-wrap jitter:
 *   - Unicode NFC (canonical composition),
 *   - runs of whitespace (including newlines/tabs) collapsed to a single space,
 *   - leading/trailing whitespace trimmed.
 *
 * The evidence already showed `pdftotext`/`pdf-parse` output was content-stable
 * across re-downloads; this normalization is the belt-and-braces guard against
 * a future extractor version that re-wraps lines.
 */
export function normalizeStatementText(text: string): string {
  return text.normalize("NFC").replace(WHITESPACE_RUN_RE, " ").trim();
}

/**
 * Compute the positive content fingerprint from a PDF's already-extracted text
 * and page count. The connector owns *how* it extracts (USAA reuses its
 * existing `pdf-parse` pass; Chase gains one) — this is the shared shaping so
 * both connectors hash identically.
 *
 * Fail-closed: an empty/whitespace-only normalized text yields all-null, which
 * makes the canonical fingerprint fall back to the conservative run-clock-only
 * exclusion. A genuinely empty statement is never silently treated as a
 * content match for a non-empty one.
 */
export function statementContentFingerprintFromText(
  text: string | null | undefined,
  pageCount: number | null | undefined
): StatementContentFingerprint {
  const normalized = normalizeStatementText(text ?? "");
  if (normalized.length === 0) {
    return { ...NO_STATEMENT_CONTENT_FINGERPRINT };
  }
  const pages = typeof pageCount === "number" && Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null;
  return {
    pdf_text_sha256: createHash("sha256").update(normalized).digest("hex"),
    pdf_page_count: pages,
  };
}

/**
 * Extract a statement PDF's full text and page count in one shared `pdf-parse`
 * pass. `getText()` returns both the concatenated document `text` and `total`
 * (page count), so the content fingerprint costs no extra parse on top of any
 * extraction a connector already runs. Both statement connectors call this so
 * the fingerprint is computed identically; a connector SHALL NOT introduce a
 * second PDF-text library for this purpose.
 *
 * `pdf-parse` is lazy-imported so connectors that never hit the PDF path pay
 * no startup cost.
 */
export async function extractStatementPdfTextAndPages(
  buffer: Buffer
): Promise<{ text: string; pageCount: number | null }> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  let textResult: { text?: string; total?: number };
  try {
    textResult = await parser.getText();
  } finally {
    await parser.destroy().catch(() => {
      /* ignore */
    });
  }
  const pageCount = typeof textResult.total === "number" && textResult.total > 0 ? textResult.total : null;
  return { text: textResult.text || "", pageCount };
}

/**
 * Derive the positive content fingerprint from a statement PDF's bytes using
 * the shared extraction path. Fail-closed: any extraction error yields the
 * all-null fingerprint so the canonical exclusion stays conservative and the
 * statement record is still emitted.
 */
export async function extractStatementContentFingerprint(buffer: Buffer): Promise<StatementContentFingerprint> {
  try {
    const { text, pageCount } = await extractStatementPdfTextAndPages(buffer);
    return statementContentFingerprintFromText(text, pageCount);
  } catch {
    return { ...NO_STATEMENT_CONTENT_FINGERPRINT };
  }
}

/** True iff a record carries BOTH positive content fields, present and
 *  non-null. Requiring both fails closed against a partial extraction (text
 *  but no page count, or vice versa). */
export function hasStatementContentFingerprint(record: Record<string, unknown>): boolean {
  const textSha = record.pdf_text_sha256;
  const pageCount = record.pdf_page_count;
  return typeof textSha === "string" && textSha.length > 0 && typeof pageCount === "number" && pageCount > 0;
}

/**
 * The content-gated canonical fingerprint exclusion list for one statement
 * record. This is the single shared rule the connector no-op cursor AND the
 * compaction policy both consume, so a "removable historical version"
 * classification matches the connector's "no-op emit" classification.
 *
 *   - both content fields present → exclude the blob/acquisition-identity
 *     fields plus the run clock (excluding them is lossless because the
 *     positive content signal remains in the fingerprint);
 *   - either content field absent → exclude only the run clock (the
 *     conservative pre-content behavior, so a content-less version is never
 *     collapsed against a content-bearing version).
 */
export function statementFingerprintExcludeKeys(record: Record<string, unknown>): readonly string[] {
  return hasStatementContentFingerprint(record)
    ? STATEMENT_CONTENT_GATED_EXCLUDE_KEYS
    : STATEMENT_RUN_CLOCK_EXCLUDE_KEYS;
}
