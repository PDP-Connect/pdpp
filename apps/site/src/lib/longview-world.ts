// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  benefitsEnrollments:
    "Plan name, coverage tier, and employer contribution. No dependent details, claims, or provider notes.",
  equityGrants:
    "Grant type, quantity, vesting start, and vesting schedule. No brokerage account numbers or beneficiary details.",
  payStatements:
    "Employer, pay period, gross pay, and net pay from each payroll cycle. No bank account details, home address, or tax ID fragments.",
} as const;

export const LONGVIEW_CONNECTOR_SPECIMEN: ConnectorCardProps = {
  connectorId: "https://registry.pdpp.org/profiles/compensation-v1",
  displayName: "Compensation profile",
  profiles: [{ id: "career-move", label: "Career move planning", streamCount: 3 }],
  streams: [
    {
      label: "Pay statements",
      name: "pay_statements",
      semantics: "append_only",
      supportsFields: true,
      supportsResources: false,
      supportsTimeRange: true,
      viewCount: 2,
    },
    {
      label: "Equity grants",
      name: "equity_grants",
      semantics: "mutable_state",
      supportsFields: true,
      supportsResources: false,
      supportsTimeRange: false,
      viewCount: 2,
    },
    {
      label: "Benefits enrollments",
      name: "benefits_enrollments",
      semantics: "mutable_state",
      supportsFields: true,
      supportsResources: false,
      supportsTimeRange: false,
      viewCount: 1,
    },
  ],
  version: "1.0.0",
};

export const LONGVIEW_INVENTORY_SPECIMEN: StreamInventoryProps = {
  connectorName: "Compensation sources",
  connectorVersion: "1.0.0",
  streams: [
    {
      detail: LONGVIEW_STREAM_DETAILS.payStatements,
      label: "Pay statements",
      lastSynced: "Apr 15, 2026",
      name: "pay_statements",
      recordCount: 24,
      semantics: "append_only",
    },
    {
      detail: LONGVIEW_STREAM_DETAILS.equityGrants,
      label: "Equity grants",
      lastSynced: "Apr 15, 2026",
      name: "equity_grants",
      recordCount: 3,
      semantics: "mutable_state",
    },
    {
      detail: LONGVIEW_STREAM_DETAILS.benefitsEnrollments,
      label: "Benefits enrollments",
      lastSynced: "Apr 15, 2026",
      name: "benefits_enrollments",
      recordCount: 1,
      semantics: "mutable_state",
    },
  ],
};

export const LONGVIEW_CONSENT_SPECIMEN: ConsentCardProps = {
  accessMode: "continuous",
  commitments: [...LONGVIEW_COMMITMENTS],
  optional: {
    consequenceOff: "Leaves the rest of the compensation analysis intact.",
    consequenceOn: "Improves plan comparison and exposes coverage tradeoffs.",
    detail: LONGVIEW_STREAM_DETAILS.benefitsEnrollments,
    key: "benefits_enrollments",
    label: "Benefits enrollments",
  },
  purpose: LONGVIEW_PURPOSE,
  requester: {
    monogram: LONGVIEW_CLIENT_MONOGRAM,
    name: LONGVIEW_CLIENT_NAME,
    policyUri: LONGVIEW_POLICY_URI,
    tosUri: LONGVIEW_TOS_URI,
    uri: LONGVIEW_CLIENT_URI,
    verified: true,
  },
  streams: [
    {
      detail: LONGVIEW_STREAM_DETAILS.payStatements,
      key: "pay_statements",
      label: "Pay statements",
    },
    {
      detail: LONGVIEW_STREAM_DETAILS.equityGrants,
      key: "equity_grants",
      label: "Equity grants",
    },
  ],
  technical: {
    clientId: LONGVIEW_CLIENT_ID,
    grantExpires: "Apr 15, 2027",
    purposeCode: LONGVIEW_PURPOSE_CODE,
  },
};

export const LONGVIEW_GRANT_SPECIMEN: GrantInspectorProps = {
  accessMode: "continuous",
  client: { clientId: LONGVIEW_CLIENT_ID, name: LONGVIEW_CLIENT_NAME },
  expiresAt: "Apr 15, 2027",
  grantId: "grt_longview01",
  issuedAt: "Apr 15, 2026",
  purposeCode: LONGVIEW_PURPOSE_CODE,
  purposeDescription: LONGVIEW_PURPOSE_DESCRIPTION,
  retention: { duration: "90 days", onExpiry: "delete" },
  status: "active",
  streams: [
    {
      detail: LONGVIEW_STREAM_DETAILS.payStatements,
      fields: [...LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS],
      label: "Pay statements",
      name: "pay_statements",
      timeRange: { since: "Jan 1, 2025" },
      view: "summary",
    },
    {
      detail: LONGVIEW_STREAM_DETAILS.equityGrants,
      fields: ["grant_type", "quantity", "vesting_start", "vesting_schedule"],
      label: "Equity grants",
      name: "equity_grants",
      view: "vesting_summary",
    },
  ],
};

export const LONGVIEW_ROLLOUT_COPY = {
  docsBlurb:
    "A compensation-planning client that needs payroll, equity, and benefits records under one enforceable consent boundary.",
  heroLine: LONGVIEW_SUMMARY,
  proofLine: "The app gets the comparison fields and leaves the identity-heavy payroll fields behind.",
  syncLine: "Each payroll cycle adds one new pay statement, so sync returns only the new record.",
} as const;
