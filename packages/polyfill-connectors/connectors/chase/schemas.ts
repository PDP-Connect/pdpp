/**
 * Zod schemas for Chase stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that fail the schema
 * become SKIP_RESULT events instead of RECORD events, so the RS never
 * receives data that looks right but isn't.
 *
 * Chase's connector parses QFX (Quicken Web Connect) files downloaded
 * from chase.com. The shapes below defend against:
 *   - QFX parser drift (ofx-js behavior changes)
 *   - DOM changes on the download-statement UI (for statements stream)
 *   - Off-by-one currency parsing (cents as float vs integer)
 *   - QFX FITID collisions (FITID is Chase's stable transaction id;
 *     the connector hashes (account, fitid) for the record key)
 */

import { z } from "zod";

// ─── Shared atoms ───────────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const dateTimeString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "must be ISO-8601 timestamp");

const isoTimestamp = dateTimeString;

// Cents: integer, can be negative (overdrawn accounts / charge transactions).
// Upper bound $100M — more than enough for consumer banking.
const cents = z.number().int().min(-10_000_000_000).max(10_000_000_000);
const nonNegativeCents = z.number().int().min(0).max(10_000_000_000);

// Chase account IDs come from the DOM (anchor IDs, slug-like). Keep permissive.
const accountIdSchema = z.string().min(1).max(128);

// Clean-string guard: catches accidentally-captured DOM innerText leaks.
const CRUFT_PATTERNS =
  /Loading|Please wait|undefined|\[object Object\]|<[a-z]+>|\n\n/i;
const cleanString = (maxLen: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(maxLen)
    .refine((s) => !CRUFT_PATTERNS.test(s), {
      message: "looks like DOM/UI cruft",
    });

// ─── accounts ───────────────────────────────────────────────────────────

export const accountSchema = z.object({
  id: accountIdSchema,
  name: cleanString(120).nullable(),
  type: z.string().min(1).max(60).nullable(),
  last_four: z
    .string()
    .regex(/^\d{4}$/, "must be 4 digits")
    .nullable(),
  balance_cents: cents.nullable(),
  available_balance_cents: cents.nullable(),
  credit_limit_cents: nonNegativeCents.nullable(),
  available_credit_cents: nonNegativeCents.nullable(),
  statement_balance_cents: cents.nullable(),
  status: z.string().min(1).max(40).nullable(),
  balance_as_of: dateTimeString.nullable(),
  fetched_at: isoTimestamp,
});

// ─── transactions ───────────────────────────────────────────────────────

export const transactionSchema = z.object({
  // id = composite "<account_id>|<fitid>" (Chase's FITID is already a
  // stable per-transaction identifier from QFX; the composite ensures
  // global uniqueness across accounts).
  id: z.string().min(3).max(200).regex(/\|/, "must be <account_id>|<fitid>"),
  account_id: accountIdSchema,
  account_name: cleanString(120).nullable(),
  // FITID = Chase's stable per-transaction id from QFX. Alphanumeric, can be long.
  fitid: z.string().min(1).max(80),
  date: dateString,
  amount: cents,
  currency: z.string().regex(/^[A-Z]{3}$/, "must be ISO-4217 3-letter code"),
  // QFX TRNTYPE: DEBIT, CREDIT, CHECK, ATM, etc.
  type: z.string().min(1).max(40).nullable(),
  name: cleanString(200).nullable(),
  memo: cleanString(500).nullable(),
  check_number: z
    .string()
    .regex(/^\d{1,8}$/, "must be 1-8 digit number")
    .nullable(),
  reference_number: z.string().min(1).max(80).nullable(),
  // source: today "qfx_download_<activity>_<YYYY-MM-DD>" (e.g.
  // "qfx_download_all_2026-04-21"). Also future: "pdf_statement_YYYY-MM".
  // Keep the schema permissive — the source is provenance metadata,
  // not something a consumer should regex on.
  source: z.string().min(3).max(120),
  fetched_at: isoTimestamp,
});

// ─── statements ─────────────────────────────────────────────────────────

export const statementSchema = z.object({
  id: z.string().min(1).max(200),
  account_id: accountIdSchema.nullable(),
  title: cleanString(200),
  date_delivered: dateString.nullable(),
  account_reference: z.string().min(1).max(200).nullable(),
  document_url: z.string().url().nullable(),
  pdf_path: z.string().min(1).max(500).nullable(),
  pdf_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "must be SHA-256 hex")
    .nullable(),
  fetched_at: isoTimestamp,
});

// ─── balances ───────────────────────────────────────────────────────────

export const balanceSchema = z.object({
  id: z.string().min(1).max(200),
  account_id: accountIdSchema,
  as_of: dateTimeString,
  ledger_balance_cents: cents.nullable(),
  available_balance_cents: cents.nullable(),
  fetched_at: isoTimestamp,
});

// ─── Registry ───────────────────────────────────────────────────────────

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  accounts: accountSchema,
  transactions: transactionSchema,
  statements: statementSchema,
  balances: balanceSchema,
};

export function validateRecord(
  stream: string,
  data: Record<string, unknown>
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: Array<{ path: string; message: string }> } {
  const schema = SCHEMAS[stream];
  if (!schema) {
    return { ok: true, data };
  }
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data as Record<string, unknown> };
  }
  const issues = result.error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
  return { ok: false, issues };
}
