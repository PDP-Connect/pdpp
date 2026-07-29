// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded sandbox scenario.
 *
 * Seeded scenario data for the guided sandbox walkthrough. The shapes mirror
 * the reference implementation flows while staying deterministic for demos.
 */

export const SANDBOX_OWNER = {
  display: "Sam Rivera",
  ownerId: "owner_sandbox_demo",
} as const;

export const SANDBOX_CLIENT = {
  clientId: "client_quill_tax_demo",
  commitments: [
    "Read-only access; no writes back to the payroll connector.",
    "Hold imported pay statements only until the return is filed.",
    "No resale or sharing with third-party advertisers.",
  ],
  homepage: "https://example.invalid/quill-tax",
  monogram: "QT",
  name: "Quill Tax",
  policyUri: "https://example.invalid/quill-tax/privacy",
  purpose: "Import the last three pay statements so you can finish your tax return without re-keying numbers.",
  tosUri: "https://example.invalid/quill-tax/terms",
  verified: false,
} as const;

export const SANDBOX_CONNECTOR = {
  name: "Acme Payroll (simulated)",
  notes: "Demo payroll connector with a stable pay-statement profile for the guided walkthrough.",
  source: { id: "acme_payroll_demo", kind: "connector" },
} as const;

export const SANDBOX_STREAM = {
  detail: "Net and gross pay totals from the last three pay periods, plus the issuing employer name.",
  fields: ["period_end", "employer", "gross_pay_cents", "net_pay_cents", "currency"] as const,
  key: "pay_statements",
  label: "Pay statements",
  retention: "Until the visitor resets this sandbox in the browser.",
} as const;

export const SANDBOX_GRANT = {
  accessMode: "single_use" as const,
  expiresAt: "2026-05-25T00:00:00Z",
  grantId: "grant_sb_2026_demo",
  purposeCode: "tax_filing",
  scope: {
    fields: SANDBOX_STREAM.fields,
    streams: [SANDBOX_STREAM.key],
  },
} as const;

export interface SandboxRecord {
  currency: "USD";
  employer: string;
  gross_pay_cents: number;
  net_pay_cents: number;
  period_end: string;
  recordId: string;
}

export const SANDBOX_RECORDS: readonly SandboxRecord[] = [
  {
    currency: "USD",
    employer: "Northwind Studios (simulated)",
    gross_pay_cents: 612_500,
    net_pay_cents: 438_120,
    period_end: "2026-03-31",
    recordId: "rec_sb_paystmt_2026_03",
  },
  {
    currency: "USD",
    employer: "Northwind Studios (simulated)",
    gross_pay_cents: 612_500,
    net_pay_cents: 437_980,
    period_end: "2026-02-28",
    recordId: "rec_sb_paystmt_2026_02",
  },
  {
    currency: "USD",
    employer: "Northwind Studios (simulated)",
    gross_pay_cents: 612_500,
    net_pay_cents: 436_640,
    period_end: "2026-01-31",
    recordId: "rec_sb_paystmt_2026_01",
  },
] as const;

/**
 * Decision rationale recorded alongside the grant. In the real reference this
 * would include client_display, client_claims, and consent UI metadata; here it
 * is a compact stand-in suitable for the inspectable transcript.
 */
export const SANDBOX_CONSENT_RATIONALE = {
  approvedFields: SANDBOX_STREAM.fields,
  declinedExtras: ["bank_account_number", "ssn", "employer_address"],
  ownerAcknowledged: [
    "single-use access for tax filing",
    "no source-side writeback",
    "revocable from the sandbox at any time",
  ],
} as const;

/**
 * Helpers to format simulated currency without pulling Intl inconsistencies.
 */
export function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", { currency: "USD", style: "currency" });
}
