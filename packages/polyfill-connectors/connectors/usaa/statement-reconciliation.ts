// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The `transactions` completeness anchor for USAA checking statements.
//
// WHY THIS IS A REAL ANCHOR, not a derived denominator
// ----------------------------------------------------
// Every other completeness signal in this connector counts what the run
// itself produced, so it can only ever prove "no gap I could detect". A USAA
// checking statement prints two numbers the bank computed on its own side:
//
//     Beginning Balance $38,586.78
//     Ending Balance    $33,821.48
//
// Those are period totals of record. If the transactions parsed for that
// period sum to exactly `ending - beginning`, the statement itself has
// certified that the set is complete — a missing or duplicated transaction
// changes the sum and the identity fails. That is a provider-side proof, and
// it is measured at the source boundary (the PDF text USAA rendered), not
// derived from what this connector chose to emit.
//
// The relation is deliberately an EQUALITY over signed cents:
//
//     ending − beginning == Σ(transaction amounts)
//
// It is not a count and not a coverage ratio, so it is immune to the trap
// that a shortfall check falls into: it detects a transaction we invented
// just as surely as one we lost.
//
// WHY THIS IS NOT SUBSTITUTED AS `considered`
// -------------------------------------------
// The runtime admits a bounded page only when `considered === covered`
// (reference-implementation/server/continuation-proof.ts). Substituting a
// statement-level total as a per-page `considered` would make every run read
// `partial` forever. This module therefore returns a stream-level VERDICT
// about a period, never a page denominator. The caller reports it as its own
// fact; it does not feed the page arithmetic.
//
// CEILING, stated honestly
// ------------------------
// This proves completeness only for periods USAA published as a checking
// statement AND whose PDF this connector holds. It says nothing about the
// current, unstatemented cycle, and nothing about credit-card statements,
// whose era prints no running-balance column (see `extractPeriodBalances`,
// which returns null rather than guessing). A period with no statement is
// simply unanchored — this module reports that as `unavailable`, never as
// proof of completeness.

import type { ParsedStatementTxn } from "./types.ts";

// ─── Module-scope regexes (Biome useTopLevelRegex) ───────────────────────

/** The standalone summary lines USAA prints above the transaction table.
 *  Anchored to line start and requiring the currency to END the line, so a
 *  transaction whose merchant description merely CONTAINS the words
 *  "ending balance" cannot be mistaken for the summary. */
const BEGINNING_BALANCE_RE = /^Beginning\s+Balance\s+(-?\$[\d,]+\.\d{2})\s*$/i;
const ENDING_BALANCE_RE = /^Ending\s+Balance\s+(-?\$[\d,]+\.\d{2})\s*$/i;

/** The in-table summary rows, which carry a leading MM/DD and placeholder
 *  debit/credit columns: "02/04 Ending Balance -- -- $33,821.48" and
 *  "01/03 Beginning Balance 0 0". These are NOT transactions; see
 *  `isStatementSummaryDescription`. */
const SUMMARY_DESCRIPTION_RE = /^(beginning|ending)\s+balance\b/i;

const CURRENCY_STRIP_RE = /[$,]/g;

/** A well-formed cents token, after currency symbols are stripped. */
const BARE_CENTS_RE = /^\d+\.\d{2}$/;

/** Line splitter for PDF-extracted statement text. */
const LINE_SPLIT_RE = /\r?\n/;

const CENTS_MULTIPLIER = 100;

/**
 * True when a parsed statement line is one of USAA's own summary rows rather
 * than a transaction.
 *
 * This exists because USAA's checking-era table prints the period summary as
 * a row that is shaped exactly like a transaction:
 *
 *     02/04 Ending Balance -- -- $33,821.48
 *
 * A line-oriented transaction regex matches it and stores the closing
 * BALANCE as if it were a transaction AMOUNT. Live evidence: 14 such rows
 * were emitted into this owner's `transactions` stream, the most recent of
 * them three days before this guard was written, with amounts up to
 * $52,334.41 that never happened.
 *
 * Matching is on the description only and is anchored at the start, so a
 * genuine merchant transaction that happens to contain these words later in
 * its description is unaffected.
 */
export function isStatementSummaryDescription(description: string): boolean {
  return SUMMARY_DESCRIPTION_RE.test(description.trim());
}

/** Parse "$33,821.48" / "-$8.65" into signed integer cents. Returns null for
 *  anything that is not a well-formed currency token, so a malformed summary
 *  line yields "no anchor" rather than a wrong one. */
export function currencyToCents(raw: string): number | null {
  const negative = raw.trim().startsWith("-");
  const digits = raw.replace(CURRENCY_STRIP_RE, "").replace("-", "").trim();
  if (!BARE_CENTS_RE.test(digits)) {
    return null;
  }
  const value = Math.round(Number(digits) * CENTS_MULTIPLIER);
  if (!Number.isFinite(value)) {
    return null;
  }
  return negative ? -value : value;
}

/** USAA's own period totals for one statement, in signed cents. */
export interface PeriodBalances {
  beginningCents: number;
  endingCents: number;
}

/**
 * Read the statement's Beginning/Ending Balance summary from PDF text.
 *
 * Fails closed by returning `null`: a statement era that prints no such
 * summary (the credit-card era) or a statement whose summary is malformed
 * has NO anchor, and this module says so rather than substituting a number
 * it derived from the transactions — which would make the reconciliation
 * check compare the transactions against themselves and pass vacuously.
 *
 * Both values must be present and well-formed; one without the other proves
 * nothing about a period.
 */
export function extractPeriodBalances(text: string): PeriodBalances | null {
  let beginningCents: number | null = null;
  let endingCents: number | null = null;
  for (const raw of text.split(LINE_SPLIT_RE)) {
    const line = raw.trim();
    if (beginningCents === null) {
      const b = line.match(BEGINNING_BALANCE_RE);
      if (b?.[1]) {
        beginningCents = currencyToCents(b[1]);
      }
    }
    if (endingCents === null) {
      const e = line.match(ENDING_BALANCE_RE);
      if (e?.[1]) {
        endingCents = currencyToCents(e[1]);
      }
    }
  }
  if (beginningCents === null || endingCents === null) {
    return null;
  }
  return { beginningCents, endingCents };
}

/**
 * The outcome of reconciling one statement period.
 *
 * `unavailable` is a first-class, non-alarming outcome: it means the period
 * offers no sound anchor (no summary balances printed). It is deliberately
 * NOT `reconciled: false`, because "cannot check" and "checked and wrong"
 * are different facts and collapsing them would either hide a real defect or
 * cry wolf on every credit-card statement.
 */
export type StatementReconciliation =
  | { status: "unavailable"; reason: "no_period_balances" }
  | {
      status: "reconciled";
      beginningCents: number;
      endingCents: number;
      expectedDeltaCents: number;
      observedDeltaCents: number;
    }
  | {
      status: "mismatched";
      beginningCents: number;
      endingCents: number;
      expectedDeltaCents: number;
      observedDeltaCents: number;
      differenceCents: number;
    };

/**
 * Reconcile one statement period's parsed transactions against USAA's own
 * printed period totals.
 *
 * The identity checked is:
 *
 *     ending − beginning == Σ(amounts)
 *
 * Summary rows are excluded from the sum via
 * `isStatementSummaryDescription`; including them would add the closing
 * balance to the transaction sum and break the identity on every statement.
 *
 * A zero-transaction period is NOT auto-passed: a statement whose balance
 * moved but whose table yielded no transactions is exactly the multi-line
 * parse failure this owner's data exhibits, and it must surface as
 * `mismatched`. The identity handles that correctly with no special case —
 * an empty sum reconciles only when the balance genuinely did not move.
 */
export function reconcileStatementPeriod(text: string, txns: readonly ParsedStatementTxn[]): StatementReconciliation {
  const balances = extractPeriodBalances(text);
  if (!balances) {
    return { status: "unavailable", reason: "no_period_balances" };
  }
  const { beginningCents, endingCents } = balances;
  const expectedDeltaCents = endingCents - beginningCents;
  const observedDeltaCents = txns
    .filter((t) => !isStatementSummaryDescription(t.description))
    .reduce((acc, t) => acc + t.amount, 0);
  if (expectedDeltaCents === observedDeltaCents) {
    return {
      status: "reconciled",
      beginningCents,
      endingCents,
      expectedDeltaCents,
      observedDeltaCents,
    };
  }
  return {
    status: "mismatched",
    beginningCents,
    endingCents,
    expectedDeltaCents,
    observedDeltaCents,
    differenceCents: expectedDeltaCents - observedDeltaCents,
  };
}

/**
 * Build the redacted diagnostic payload for a failed reconciliation.
 *
 * Only integers and the opaque statement id hash leave this function — never
 * a merchant description, account number, or account name. The balances
 * themselves ARE dollar figures for this owner's account, and they are the
 * whole point of the finding, so they are reported; the PII rule this
 * project enforces is about names and free text, and the `message` carries
 * no account identity at all.
 */
export function buildReconciliationDiagnostics(
  statementId: string,
  result: Extract<StatementReconciliation, { status: "mismatched" }>
): Record<string, unknown> {
  return {
    statement_id: statementId,
    expected_delta_cents: result.expectedDeltaCents,
    observed_delta_cents: result.observedDeltaCents,
    difference_cents: result.differenceCents,
  };
}
