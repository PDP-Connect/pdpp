import type { ConnectorCardProps } from "@/components/pdpp/connector-card.tsx";
import type { ConsentCardProps } from "@/components/pdpp/consent-card.tsx";
import type { GrantInspectorProps } from "@/components/pdpp/grant-inspector.tsx";
import type { StreamInventoryProps } from "@/components/pdpp/stream-inventory.tsx";

export const LONGVIEW_CLIENT_NAME = "Longview";
export const LONGVIEW_CLIENT_MONOGRAM = "LV";
export const LONGVIEW_CLIENT_ID = "longview_planning_v1";
export const LONGVIEW_PURPOSE_CODE = "planning";
export const LONGVIEW_PURPOSE_DESCRIPTION = "Career-move compensation planning";
export const LONGVIEW_CLIENT_URI = "https://longview.example";
export const LONGVIEW_POLICY_URI = "https://longview.example/privacy";
export const LONGVIEW_TOS_URI = "https://longview.example/terms";

export const LONGVIEW_DESCRIPTION = "Compensation planning";
export const LONGVIEW_SUMMARY = "Compares salary, equity, benefits, and tax tradeoffs before a career move.";
export const LONGVIEW_PURPOSE =
  "Longview is requesting compensation records to compare salary, equity, benefits, and tax tradeoffs before a career move.";
export const LONGVIEW_COMMITMENTS = [
  "Analysis stays inside this planning workspace",
  "No employer outreach or document sharing without separate approval",
] as const;

export const LONGVIEW_PAY_STATEMENT_ALL_FIELDS = [
  "employer",
  "pay_period",
  "gross_pay",
  "net_pay",
  "employee_id",
  "home_address",
  "bank_account_last4",
  "tax_id_fragment",
] as const;

export const LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS = ["employer", "pay_period", "gross_pay", "net_pay"] as const;

export const LONGVIEW_STREAM_DETAILS = {
  payStatements:
    "Employer, pay period, gross pay, and net pay from each payroll cycle. No bank account details, home address, or tax ID fragments.",
  equityGrants:
    "Grant type, quantity, vesting start, and vesting schedule. No brokerage account numbers or beneficiary details.",
  benefitsEnrollments:
    "Plan name, coverage tier, and employer contribution. No dependent details, claims, or provider notes.",
} as const;

export const LONGVIEW_CONNECTOR_SPECIMEN: ConnectorCardProps = {
  connectorId: "https://registry.pdpp.org/profiles/compensation-v1",
  displayName: "Compensation profile",
  version: "1.0.0",
  streams: [
    {
      name: "pay_statements",
      label: "Pay statements",
      semantics: "append_only",
      supportsFields: true,
      supportsResources: false,
      supportsTimeRange: true,
      viewCount: 2,
    },
    {
      name: "equity_grants",
      label: "Equity grants",
      semantics: "mutable_state",
      supportsFields: true,
      supportsResources: false,
      supportsTimeRange: false,
      viewCount: 2,
    },
    {
      name: "benefits_enrollments",
      label: "Benefits enrollments",
      semantics: "mutable_state",
      supportsFields: true,
      supportsResources: false,
      supportsTimeRange: false,
      viewCount: 1,
    },
  ],
  profiles: [{ id: "career-move", label: "Career move planning", streamCount: 3 }],
};

export const LONGVIEW_INVENTORY_SPECIMEN: StreamInventoryProps = {
  connectorName: "Compensation sources",
  connectorVersion: "1.0.0",
  streams: [
    {
      name: "pay_statements",
      label: "Pay statements",
      detail: LONGVIEW_STREAM_DETAILS.payStatements,
      semantics: "append_only",
      recordCount: 24,
      lastSynced: "Apr 15, 2026",
    },
    {
      name: "equity_grants",
      label: "Equity grants",
      detail: LONGVIEW_STREAM_DETAILS.equityGrants,
      semantics: "mutable_state",
      recordCount: 3,
      lastSynced: "Apr 15, 2026",
    },
    {
      name: "benefits_enrollments",
      label: "Benefits enrollments",
      detail: LONGVIEW_STREAM_DETAILS.benefitsEnrollments,
      semantics: "mutable_state",
      recordCount: 1,
      lastSynced: "Apr 15, 2026",
    },
  ],
};

export const LONGVIEW_CONSENT_SPECIMEN: ConsentCardProps = {
  requester: {
    name: LONGVIEW_CLIENT_NAME,
    monogram: LONGVIEW_CLIENT_MONOGRAM,
    verified: true,
    uri: LONGVIEW_CLIENT_URI,
    policyUri: LONGVIEW_POLICY_URI,
    tosUri: LONGVIEW_TOS_URI,
  },
  purpose: LONGVIEW_PURPOSE,
  commitments: [...LONGVIEW_COMMITMENTS],
  streams: [
    {
      key: "pay_statements",
      label: "Pay statements",
      detail: LONGVIEW_STREAM_DETAILS.payStatements,
    },
    {
      key: "equity_grants",
      label: "Equity grants",
      detail: LONGVIEW_STREAM_DETAILS.equityGrants,
    },
  ],
  optional: {
    key: "benefits_enrollments",
    label: "Benefits enrollments",
    detail: LONGVIEW_STREAM_DETAILS.benefitsEnrollments,
    consequenceOn: "Improves plan comparison and exposes coverage tradeoffs.",
    consequenceOff: "Leaves the rest of the compensation analysis intact.",
  },
  accessMode: "continuous",
  technical: {
    clientId: LONGVIEW_CLIENT_ID,
    purposeCode: LONGVIEW_PURPOSE_CODE,
    grantExpires: "Apr 15, 2027",
  },
};

export const LONGVIEW_GRANT_SPECIMEN: GrantInspectorProps = {
  grantId: "grt_longview01",
  issuedAt: "Apr 15, 2026",
  status: "active",
  client: { clientId: LONGVIEW_CLIENT_ID, name: LONGVIEW_CLIENT_NAME },
  purposeCode: LONGVIEW_PURPOSE_CODE,
  purposeDescription: LONGVIEW_PURPOSE_DESCRIPTION,
  accessMode: "continuous",
  expiresAt: "Apr 15, 2027",
  retention: { duration: "90 days", onExpiry: "delete" },
  streams: [
    {
      name: "pay_statements",
      label: "Pay statements",
      detail: LONGVIEW_STREAM_DETAILS.payStatements,
      view: "summary",
      fields: [...LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS],
      timeRange: { since: "Jan 1, 2025" },
    },
    {
      name: "equity_grants",
      label: "Equity grants",
      detail: LONGVIEW_STREAM_DETAILS.equityGrants,
      view: "vesting_summary",
      fields: ["grant_type", "quantity", "vesting_start", "vesting_schedule"],
    },
  ],
};

export const LONGVIEW_ROLLOUT_COPY = {
  heroLine: LONGVIEW_SUMMARY,
  proofLine: "The app gets the comparison fields and leaves the identity-heavy payroll fields behind.",
  docsBlurb:
    "A compensation-planning client that needs payroll, equity, and benefits records under one enforceable consent boundary.",
  syncLine: "Each payroll cycle adds one new pay statement, so sync returns only the new record.",
} as const;
