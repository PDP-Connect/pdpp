/**
 * Seeded sandbox scenario.
 *
 * Everything in this file is fictional. No real platform credentials, owners,
 * employers, bank accounts, or token values are referenced. The shapes are
 * inspired by PDPP but are simulated, not captured from a live owner instance.
 */

export const SANDBOX_OWNER = {
  display: "Sam Rivera",
  ownerId: "owner_sandbox_demo",
} as const;

export const SANDBOX_CLIENT = {
  clientId: "client_quill_tax_demo",
  name: "Quill Tax",
  monogram: "QT",
  homepage: "https://example.invalid/quill-tax",
  policyUri: "https://example.invalid/quill-tax/privacy",
  tosUri: "https://example.invalid/quill-tax/terms",
  verified: false,
  purpose: "Import the last three pay statements so you can finish your tax return without re-keying numbers.",
  commitments: [
    "Read-only access; no writes back to the payroll connector.",
    "Hold imported pay statements only until the return is filed.",
    "No resale or sharing with third-party advertisers.",
  ],
} as const;

export const SANDBOX_CONNECTOR = {
  source: { kind: "connector", id: "acme_payroll_demo" },
  name: "Acme Payroll (simulated)",
  notes:
    "Stand-in payroll connector used only inside this sandbox. No real Acme Corporation, employer, or paycheck data is involved.",
} as const;

export const SANDBOX_STREAM = {
  key: "pay_statements",
  label: "Pay statements",
  detail: "Net and gross pay totals from the last three pay periods, plus the issuing employer name.",
  fields: ["period_end", "employer", "gross_pay_cents", "net_pay_cents", "currency"] as const,
  retention: "Until the visitor resets this sandbox in the browser.",
} as const;

export const SANDBOX_GRANT = {
  grantId: "grant_sb_2026_demo",
  purposeCode: "tax_filing",
  accessMode: "single_use" as const,
  expiresAt: "2026-05-25T00:00:00Z",
  scope: {
    streams: [SANDBOX_STREAM.key],
    fields: SANDBOX_STREAM.fields,
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
    recordId: "rec_sb_paystmt_2026_03",
    period_end: "2026-03-31",
    employer: "Northwind Studios (simulated)",
    gross_pay_cents: 612_500,
    net_pay_cents: 438_120,
    currency: "USD",
  },
  {
    recordId: "rec_sb_paystmt_2026_02",
    period_end: "2026-02-28",
    employer: "Northwind Studios (simulated)",
    gross_pay_cents: 612_500,
    net_pay_cents: 437_980,
    currency: "USD",
  },
  {
    recordId: "rec_sb_paystmt_2026_01",
    period_end: "2026-01-31",
    employer: "Northwind Studios (simulated)",
    gross_pay_cents: 612_500,
    net_pay_cents: 436_640,
    currency: "USD",
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
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
