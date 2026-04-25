/**
 * Zod schemas for USAA stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that fail the schema
 * become SKIP_RESULT events instead of RECORD events, so the RS never
 * receives data that looks right but isn't.
 *
 * Each schema asserts:
 *   - primitive types correct
 *   - lengths bounded (strings can't be the whole DOM)
 *   - currency cents are integer-in-range (positive or negative for txns;
 *     positive for balance fields)
 *   - dates are YYYY-MM-DD
 *   - no known cruft patterns ("Loading…", innerText-of-container leaks)
 *
 * Schemas intentionally accept `null` for fields that can legitimately be
 * absent (e.g. a savings account has no APR). Required fields per the
 * manifest are strictly present.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// ─── Shared atoms ──────────────────────────────────────────────────────

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const isoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "must be ISO-8601 timestamp");

// Cents can be any integer (transactions sign negatively; balances can be
// negative for overdrawn accounts). Keep a sane upper bound — $100M is
// more than enough for a consumer account.
const cents = z.number().int().min(-10_000_000_000).max(10_000_000_000);
const nonNegativeCents = z.number().int().min(0).max(10_000_000_000);

// Account ID should be a non-empty short-ish string (USAA account IDs
// are typically 10-16 chars; we allow up to 64 for safety).
const accountIdSchema = z.string().min(1).max(64);

// Generic cruft guard: string must not look like a UI label or innerText leak.
const CRUFT_PATTERNS = /Loading|Please wait|undefined|\[object Object\]|<[a-z]+>|\n\n/i;
const cleanString = (maxLen: number) =>
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
  // last_four is exactly 4 digits when present
  last_four: z
    .string()
    .regex(/^\d{4}$/, "must be 4 digits")
    .nullable(),
  balance_cents: cents.nullable(),
  available_balance_cents: cents.nullable(),
  status: z.string().min(1).max(40).nullable(),
  fetched_at: isoTimestamp,
});

// ─── transactions ───────────────────────────────────────────────────────

export const transactionSchema = z.object({
  // id is a 32-char hex hash (first 32 chars of SHA-256)
  id: z.string().regex(/^[0-9a-f]{32}$/i, "must be 32-char hex hash"),
  account_id: accountIdSchema,
  account_name: cleanString(120).nullable(),
  date: dateString,
  amount: cents,
  // USD only today; schema is open to future currencies
  currency: z.string().regex(/^[A-Z]{3}$/, "must be ISO-4217 3-letter code"),
  description: cleanString(300).nullable(),
  original_description: cleanString(300).nullable(),
  category: z.string().min(1).max(60).nullable(),
  // Check number: 1-6 digit string when present
  check_number: z
    .string()
    .regex(/^\d{1,8}$/, "must be 1-8 digit number")
    .nullable(),
  balance_after_cents: cents.nullable(),
  // source is either "csv_export" or "pdf_statement_YYYY-MM"
  source: z.string().regex(/^(csv_export|pdf_statement_\d{4}-\d{2})$/, "must be csv_export or pdf_statement_YYYY-MM"),
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
  // Local file path (file:// URL) or blob reference
  pdf_path: z.string().min(1).max(500).nullable(),
  // SHA-256 = 64 hex chars
  pdf_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "must be SHA-256 hex")
    .nullable(),
  fetched_at: isoTimestamp,
});

// ─── inbox_messages ─────────────────────────────────────────────────────

export const inboxMessageSchema = z.object({
  id: z.string().min(1).max(200),
  date_received: dateString.nullable(),
  status: z.string().min(1).max(40).nullable(),
  subject: cleanString(400).nullable(),
  preview: cleanString(1000).nullable(),
  fetched_at: isoTimestamp,
});

// ─── credit_card_billing ────────────────────────────────────────────────

export const creditCardBillingSchema = z.object({
  id: z.string().min(1).max(200),
  account_id: accountIdSchema.nullable(),
  account_nickname: cleanString(120).nullable(),
  current_balance_cents: cents.nullable(),
  available_credit_cents: nonNegativeCents.nullable(),
  credit_limit_cents: nonNegativeCents.nullable(),
  // APRs are strings like "24.99%" (kept as text to preserve display precision)
  annual_percent_rate: z
    .string()
    .regex(/^-?\d+\.?\d*%?$/, "must be percentage")
    .nullable(),
  cash_advance_apr: z
    .string()
    .regex(/^-?\d+\.?\d*%?$/, "must be percentage")
    .nullable(),
  cash_rewards_cents: cents.nullable(),
  billing_status: z.string().min(1).max(80).nullable(),
  minimum_payment_met: z.boolean().nullable(),
  card_holders: z.string().min(1).max(400).nullable(),
  fetched_at: isoTimestamp,
});

// ─── Registry ───────────────────────────────────────────────────────────

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  accounts: accountSchema,
  transactions: transactionSchema,
  statements: statementSchema,
  inbox_messages: inboxMessageSchema,
  credit_card_billing: creditCardBillingSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
