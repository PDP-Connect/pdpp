// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic, fictional demo dataset for the public sandbox.
 *
 * Everything in this file is invented:
 *   - Domains use the reserved `example.invalid` TLD or `*.example.com`.
 *   - Connector / stream / record / client identifiers all carry
 *     `_sb_` or `_demo` markers.
 *   - Currency values are USD minor units chosen for legibility.
 *   - Timestamps are anchored to a frozen demo clock so responses stay stable.
 *
 * This module is the single source of truth for the demo UI and the demo
 * `/sandbox/v1/**` and `/sandbox/_ref/**` route handlers. Builders read from
 * here; routes call builders.
 */

import type {
  DemoCapabilityDef,
  DemoClientDef,
  DemoConnectorDef,
  DemoGrantDef,
  DemoRecord,
  DemoRunDef,
  DemoStreamDef,
  DemoTraceDef,
} from "./types.ts";

/** Frozen "now" for the demo. All seeded timestamps anchor to this. */
export const DEMO_NOW = "2026-04-25T15:00:00Z";

/** Issuer/resource origin used in well-known metadata. Sandbox-prefixed and demo-only. */
export const DEMO_ISSUER = "https://pdpp.example.invalid/sandbox";

// ─── Clients ───────────────────────────────────────────────────────────────

export const DEMO_CLIENTS: readonly DemoClientDef[] = [
  {
    client_id: "client_quill_tax_demo",
    client_uri: "https://example.invalid/quill-tax",
    display_name: "Quill Tax (simulated)",
    logo_initials: "QT",
    policy_uri: "https://example.invalid/quill-tax/privacy",
    tos_uri: "https://example.invalid/quill-tax/terms",
    verified: true,
  },
  {
    client_id: "client_sherwood_health_demo",
    client_uri: "https://example.invalid/sherwood-health",
    display_name: "Sherwood Health (simulated)",
    logo_initials: "SH",
    policy_uri: "https://example.invalid/sherwood-health/privacy",
    tos_uri: "https://example.invalid/sherwood-health/terms",
    verified: false,
  },
  {
    client_id: "client_ledger_atlas_demo",
    client_uri: "https://example.invalid/ledger-atlas",
    display_name: "Ledger Atlas (simulated)",
    logo_initials: "LA",
    policy_uri: "https://example.invalid/ledger-atlas/privacy",
    tos_uri: "https://example.invalid/ledger-atlas/terms",
    verified: true,
  },
] as const;

// ─── Connectors ────────────────────────────────────────────────────────────

export const DEMO_CONNECTORS: readonly DemoConnectorDef[] = [
  {
    connector_id: "acme_payroll_demo",
    description: "Demo payroll connector for Acme Corporation pay statements.",
    display_name: "Acme Payroll (simulated)",
    provenance: "native",
    provider_id: "provider_acme_payroll_demo",
    schedule: "weekly",
    streams: ["pay_statements", "tax_documents"],
  },
  {
    connector_id: "northwind_health_demo",
    description: "Demo personal-health connector for claims and visit history.",
    display_name: "Northwind Health (simulated)",
    provenance: "polyfill-registered",
    provider_id: "provider_northwind_health_demo",
    schedule: "manual",
    streams: ["clinical_visits"],
  },
  {
    connector_id: "fabrikam_bank_demo",
    description: "Stand-in retail-bank connector for demo. Numbers and balances are invented.",
    display_name: "Fabrikam Bank (simulated)",
    provenance: "native",
    provider_id: "provider_fabrikam_bank_demo",
    schedule: "daily",
    streams: ["transactions"],
  },
] as const;

// ─── Streams + schemas ─────────────────────────────────────────────────────

export const DEMO_STREAMS: readonly DemoStreamDef[] = [
  {
    connector_id: "acme_payroll_demo",
    consent_time_field: "period_end",
    description: "Per-period gross/net pay totals and the issuing employer.",
    fields: [
      { description: "End of the pay period.", name: "period_end", semantic_class: "common", type: "timestamp" },
      { description: "Issuing employer display name.", name: "employer", semantic_class: "common", type: "string" },
      {
        description: "Gross pay in USD minor units.",
        name: "gross_pay_cents",
        semantic_class: "sensitive",
        type: "currency_minor_units",
      },
      {
        description: "Net pay in USD minor units.",
        name: "net_pay_cents",
        semantic_class: "sensitive",
        type: "currency_minor_units",
      },
      { description: "ISO-4217 currency code.", name: "currency", semantic_class: "common", type: "string" },
    ],
    key: "pay_statements",
    label: "Pay statements",
    latest_record_time: "2026-03-31T00:00:00Z",
    retention_label: "Retained while this demo dataset is seeded.",
  },
  {
    connector_id: "acme_payroll_demo",
    consent_time_field: "issued_at",
    description: "End-of-year tax document index from the simulated payroll provider.",
    fields: [
      { description: "Tax year covered by the document.", name: "year", semantic_class: "common", type: "number" },
      { description: "e.g. W2, 1099.", name: "document_kind", semantic_class: "common", type: "string" },
      {
        description: "Issuing entity display name.",
        name: "issuer",
        semantic_class: "common",
        type: "string",
      },
      {
        description: "When the document was issued.",
        name: "issued_at",
        semantic_class: "common",
        type: "timestamp",
      },
      {
        description: "Reference to the simulated document bytes exposed through the blob read path.",
        name: "blob_ref",
        semantic_class: "sensitive",
        type: "blob",
      },
    ],
    key: "tax_documents",
    label: "Tax documents",
    latest_record_time: "2026-01-31T00:00:00Z",
    retention_label: "Retained while this demo dataset is seeded.",
  },
  {
    connector_id: "northwind_health_demo",
    consent_time_field: "visit_at",
    description: "Visit summary entries from the simulated personal-health provider.",
    fields: [
      { description: "When the visit occurred.", name: "visit_at", semantic_class: "common", type: "timestamp" },
      {
        description: "Practitioner display name.",
        name: "provider_name",
        semantic_class: "identifying",
        type: "string",
      },
      {
        description: "Short visit summary written for the patient.",
        name: "summary",
        semantic_class: "sensitive",
        type: "string",
      },
      {
        description: "Whether the simulated provider flagged follow-up.",
        name: "follow_up_needed",
        semantic_class: "common",
        type: "boolean",
      },
    ],
    key: "clinical_visits",
    label: "Clinical visits",
    latest_record_time: "2026-02-14T00:00:00Z",
    retention_label: "Retained while this demo dataset is seeded.",
  },
  {
    connector_id: "fabrikam_bank_demo",
    consent_time_field: "posted_at",
    description: "Per-transaction posting from the simulated bank account.",
    fields: [
      { description: "When the transaction posted.", name: "posted_at", semantic_class: "common", type: "timestamp" },
      { description: "Merchant display name.", name: "merchant", semantic_class: "common", type: "string" },
      {
        description: "Transaction amount in USD minor units; negative for debits.",
        name: "amount_cents",
        semantic_class: "sensitive",
        type: "currency_minor_units",
      },
      { description: "ISO-4217 currency code.", name: "currency", semantic_class: "common", type: "string" },
      { description: "Provider-assigned category.", name: "category", semantic_class: "common", type: "string" },
    ],
    key: "transactions",
    label: "Transactions",
    latest_record_time: "2026-04-22T00:00:00Z",
    retention_label: "Retained while this demo dataset is seeded.",
  },
] as const;

// ─── Records ───────────────────────────────────────────────────────────────

export const DEMO_RECORDS: readonly DemoRecord[] = [
  {
    connector_id: "acme_payroll_demo",
    fields: {
      currency: "USD",
      employer: "Northwind Studios (simulated)",
      gross_pay_cents: 612_500,
      net_pay_cents: 438_120,
      period_end: "2026-03-31",
    },
    ingested_at: "2026-04-01T05:14:00Z",
    record_id: "rec_sb_paystmt_2026_03",
    record_time: "2026-03-31T00:00:00Z",
    stream: "pay_statements",
  },
  {
    connector_id: "acme_payroll_demo",
    fields: {
      currency: "USD",
      employer: "Northwind Studios (simulated)",
      gross_pay_cents: 612_500,
      net_pay_cents: 437_980,
      period_end: "2026-02-28",
    },
    ingested_at: "2026-03-01T05:11:00Z",
    record_id: "rec_sb_paystmt_2026_02",
    record_time: "2026-02-28T00:00:00Z",
    stream: "pay_statements",
  },
  {
    connector_id: "acme_payroll_demo",
    fields: {
      currency: "USD",
      employer: "Northwind Studios (simulated)",
      gross_pay_cents: 612_500,
      net_pay_cents: 436_640,
      period_end: "2026-01-31",
    },
    ingested_at: "2026-02-01T05:09:00Z",
    record_id: "rec_sb_paystmt_2026_01",
    record_time: "2026-01-31T00:00:00Z",
    stream: "pay_statements",
  },
  {
    connector_id: "acme_payroll_demo",
    fields: {
      blob_ref: {
        blob_id: "blob_sb_taxdoc_2025_w2",
        content_type: "application/pdf",
        fetch_url: "/v1/blobs/blob_sb_taxdoc_2025_w2",
        size_bytes: 184_320,
      },
      document_kind: "W2",
      issued_at: "2026-01-31T00:00:00Z",
      issuer: "Northwind Studios (simulated)",
      year: 2025,
    },
    ingested_at: "2026-02-02T08:00:00Z",
    record_id: "rec_sb_taxdoc_2025_w2",
    record_time: "2026-01-31T00:00:00Z",
    stream: "tax_documents",
  },
  {
    connector_id: "northwind_health_demo",
    fields: {
      follow_up_needed: false,
      provider_name: "Dr. Avery Hale (simulated)",
      summary: "Annual physical. Routine bloodwork ordered. Follow-up not required.",
      visit_at: "2026-02-14T15:30:00Z",
    },
    ingested_at: "2026-02-15T09:00:00Z",
    record_id: "rec_sb_visit_2026_02",
    record_time: "2026-02-14T15:30:00Z",
    stream: "clinical_visits",
  },
  {
    connector_id: "northwind_health_demo",
    fields: {
      follow_up_needed: true,
      provider_name: "Dr. Iris Park (simulated)",
      summary: "Sinus infection. Prescribed amoxicillin. Re-check in two weeks.",
      visit_at: "2025-11-09T09:00:00Z",
    },
    ingested_at: "2025-11-10T07:30:00Z",
    record_id: "rec_sb_visit_2025_11",
    record_time: "2025-11-09T09:00:00Z",
    stream: "clinical_visits",
  },
  {
    connector_id: "fabrikam_bank_demo",
    fields: {
      amount_cents: -1245,
      category: "food_drink",
      currency: "USD",
      merchant: "Bluebird Bakery (simulated)",
      posted_at: "2026-04-22T13:42:00Z",
    },
    ingested_at: "2026-04-22T14:00:00Z",
    record_id: "rec_sb_txn_2026_04_22",
    record_time: "2026-04-22T13:42:00Z",
    stream: "transactions",
  },
  {
    connector_id: "fabrikam_bank_demo",
    fields: {
      amount_cents: 438_120,
      category: "income_payroll",
      currency: "USD",
      merchant: "Acme Payroll (simulated)",
      posted_at: "2026-04-18T19:08:00Z",
    },
    ingested_at: "2026-04-18T19:30:00Z",
    record_id: "rec_sb_txn_2026_04_18",
    record_time: "2026-04-18T19:08:00Z",
    stream: "transactions",
  },
  {
    connector_id: "fabrikam_bank_demo",
    fields: {
      amount_cents: -28_400,
      category: "insurance",
      currency: "USD",
      merchant: "Fabrikam Insurance (simulated)",
      posted_at: "2026-04-05T10:00:00Z",
    },
    ingested_at: "2026-04-05T10:30:00Z",
    record_id: "rec_sb_txn_2026_04_05",
    record_time: "2026-04-05T10:00:00Z",
    stream: "transactions",
  },
] as const;

// ─── Grants ────────────────────────────────────────────────────────────────

export const DEMO_GRANTS: readonly DemoGrantDef[] = [
  {
    client_id: "client_quill_tax_demo",
    connector_id: "acme_payroll_demo",
    events: [
      {
        client_id: "client_quill_tax_demo",
        data: {
          purpose_code: "tax_filing",
          requested_fields: ["period_end", "employer", "gross_pay_cents", "net_pay_cents", "currency"],
          requested_streams: ["pay_statements"],
        },
        event_id: "evt_sb_quill_001",
        event_type: "request.received",
        grant_id: null,
        object_type: "request",
        occurred_at: "2026-04-22T16:01:00Z",
        run_id: null,
        status: "received",
        trace_id: "trace_sb_quill_paystmt",
      },
      {
        client_id: "client_quill_tax_demo",
        data: { access_mode: "single_use", surface: "owner_browser" },
        event_id: "evt_sb_quill_002",
        event_type: "consent.presented",
        grant_id: null,
        object_type: "consent",
        occurred_at: "2026-04-22T16:01:42Z",
        run_id: null,
        status: "presented",
        trace_id: "trace_sb_quill_paystmt",
      },
      {
        client_id: "client_quill_tax_demo",
        data: { access_mode: "single_use", expires_at: "2026-05-22T16:02:00Z" },
        event_id: "evt_sb_quill_003",
        event_type: "grant.issued",
        grant_id: "grant_sb_quill_paystmt",
        object_type: "grant",
        occurred_at: "2026-04-22T16:02:00Z",
        run_id: null,
        status: "issued",
        trace_id: "trace_sb_quill_paystmt",
      },
      {
        client_id: "client_quill_tax_demo",
        data: { record_count: 3, stream: "pay_statements" },
        event_id: "evt_sb_quill_004",
        event_type: "resource.read.succeeded",
        grant_id: "grant_sb_quill_paystmt",
        object_type: "resource",
        occurred_at: "2026-04-22T16:02:35Z",
        run_id: null,
        status: "succeeded",
        trace_id: "trace_sb_quill_paystmt",
      },
    ],
    fields: ["period_end", "employer", "gross_pay_cents", "net_pay_cents", "currency"],
    first_at: "2026-04-22T16:01:00Z",
    grant_id: "grant_sb_quill_paystmt",
    last_at: "2026-04-22T16:02:35Z",
    status: "issued",
    stream: "pay_statements",
    trace_id: "trace_sb_quill_paystmt",
  },
  {
    client_id: "client_ledger_atlas_demo",
    connector_id: "fabrikam_bank_demo",
    events: [
      {
        client_id: "client_ledger_atlas_demo",
        data: { purpose_code: "personal_finance", requested_streams: ["transactions"] },
        event_id: "evt_sb_ledger_001",
        event_type: "request.received",
        grant_id: null,
        object_type: "request",
        occurred_at: "2026-04-10T09:00:00Z",
        run_id: null,
        status: "received",
        trace_id: "trace_sb_ledger_txns",
      },
      {
        client_id: "client_ledger_atlas_demo",
        data: { access_mode: "continuous" },
        event_id: "evt_sb_ledger_002",
        event_type: "grant.issued",
        grant_id: "grant_sb_ledger_txns_revoked",
        object_type: "grant",
        occurred_at: "2026-04-10T09:01:30Z",
        run_id: null,
        status: "issued",
        trace_id: "trace_sb_ledger_txns",
      },
      {
        client_id: "client_ledger_atlas_demo",
        data: { reason: "no_longer_needed", revoked_by: "owner" },
        event_id: "evt_sb_ledger_003",
        event_type: "grant.revoked",
        grant_id: "grant_sb_ledger_txns_revoked",
        object_type: "grant",
        occurred_at: "2026-04-23T11:45:00Z",
        run_id: null,
        status: "revoked",
        trace_id: "trace_sb_ledger_txns",
      },
      {
        client_id: "client_ledger_atlas_demo",
        data: { error: "grant_revoked", http_status: 403, stream: "transactions" },
        event_id: "evt_sb_ledger_004",
        event_type: "resource.read.refused",
        grant_id: "grant_sb_ledger_txns_revoked",
        object_type: "resource",
        occurred_at: "2026-04-23T12:00:00Z",
        run_id: null,
        status: "refused",
        trace_id: "trace_sb_ledger_txns",
      },
    ],
    fields: ["posted_at", "merchant", "amount_cents", "currency", "category"],
    first_at: "2026-04-10T09:00:00Z",
    grant_id: "grant_sb_ledger_txns_revoked",
    last_at: "2026-04-23T11:45:00Z",
    status: "revoked",
    stream: "transactions",
    trace_id: "trace_sb_ledger_txns",
  },
  {
    client_id: "client_sherwood_health_demo",
    connector_id: "northwind_health_demo",
    events: [
      {
        client_id: "client_sherwood_health_demo",
        data: {
          purpose_code: "wellness_coaching",
          requested_fields: ["visit_at", "provider_name", "summary", "follow_up_needed"],
          requested_streams: ["clinical_visits"],
        },
        event_id: "evt_sb_sherwood_001",
        event_type: "request.received",
        grant_id: null,
        object_type: "request",
        occurred_at: "2026-04-20T18:30:00Z",
        run_id: null,
        status: "received",
        trace_id: "trace_sb_sherwood_visits",
      },
      {
        client_id: "client_sherwood_health_demo",
        data: { note: "Declined; client unverified.", reason: "owner_declined" },
        event_id: "evt_sb_sherwood_002",
        event_type: "consent.declined",
        grant_id: null,
        object_type: "consent",
        occurred_at: "2026-04-20T18:31:11Z",
        run_id: null,
        status: "declined",
        trace_id: "trace_sb_sherwood_visits",
      },
    ],
    fields: ["visit_at", "provider_name", "summary", "follow_up_needed"],
    first_at: "2026-04-20T18:30:00Z",
    grant_id: "grant_sb_sherwood_visits_denied",
    last_at: "2026-04-20T18:31:11Z",
    status: "denied",
    stream: "clinical_visits",
    trace_id: "trace_sb_sherwood_visits",
  },
] as const;

// ─── Runs ──────────────────────────────────────────────────────────────────

export const DEMO_RUNS: readonly DemoRunDef[] = [
  {
    connector_id: "acme_payroll_demo",
    events: [
      {
        client_id: null,
        data: { connector_id: "acme_payroll_demo", reason: "scheduled" },
        event_id: "evt_sb_run_acme_001",
        event_type: "run.started",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-22T05:00:00Z",
        run_id: "run_sb_acme_2026_04_22",
        status: "started",
        trace_id: "trace_sb_run_acme",
      },
      {
        client_id: null,
        data: { record_count: 1, stream: "pay_statements" },
        event_id: "evt_sb_run_acme_002",
        event_type: "run.records.synced",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-22T05:00:30Z",
        run_id: "run_sb_acme_2026_04_22",
        status: "running",
        trace_id: "trace_sb_run_acme",
      },
      {
        client_id: null,
        data: { records_total: 4 },
        event_id: "evt_sb_run_acme_003",
        event_type: "run.succeeded",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-22T05:00:42Z",
        run_id: "run_sb_acme_2026_04_22",
        status: "succeeded",
        trace_id: "trace_sb_run_acme",
      },
    ],
    failure_reason: null,
    finished_at: "2026-04-22T05:00:42Z",
    first_at: "2026-04-22T05:00:00Z",
    grant_id: null,
    last_at: "2026-04-22T05:00:42Z",
    needs_input: false,
    run_id: "run_sb_acme_2026_04_22",
    started_at: "2026-04-22T05:00:00Z",
    status: "succeeded",
  },
  {
    connector_id: "northwind_health_demo",
    events: [
      {
        client_id: null,
        data: { connector_id: "northwind_health_demo", reason: "manual" },
        event_id: "evt_sb_run_nw_001",
        event_type: "run.started",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-24T03:15:00Z",
        run_id: "run_sb_northwind_2026_04_24_failed",
        status: "started",
        trace_id: "trace_sb_run_northwind",
      },
      {
        client_id: null,
        data: { reason: "captcha_challenge_unresolved", retryable: true },
        event_id: "evt_sb_run_nw_002",
        event_type: "run.failed",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-24T03:16:11Z",
        run_id: "run_sb_northwind_2026_04_24_failed",
        status: "failed",
        trace_id: "trace_sb_run_northwind",
      },
    ],
    failure_reason: "captcha_challenge_unresolved",
    finished_at: "2026-04-24T03:16:11Z",
    first_at: "2026-04-24T03:15:00Z",
    grant_id: null,
    last_at: "2026-04-24T03:16:11Z",
    needs_input: false,
    run_id: "run_sb_northwind_2026_04_24_failed",
    started_at: "2026-04-24T03:15:00Z",
    status: "failed",
  },
  {
    connector_id: "fabrikam_bank_demo",
    events: [
      {
        client_id: null,
        data: { connector_id: "fabrikam_bank_demo", reason: "scheduled" },
        event_id: "evt_sb_run_fb_001",
        event_type: "run.started",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-25T08:00:00Z",
        run_id: "run_sb_fabrikam_2026_04_25_needs_input",
        status: "started",
        trace_id: "trace_sb_run_fabrikam",
      },
      {
        client_id: null,
        data: { kind: "owner_2fa", message: "Owner must approve from a trusted device." },
        event_id: "evt_sb_run_fb_002",
        event_type: "run.needs_input",
        grant_id: null,
        object_type: "run",
        occurred_at: "2026-04-25T08:00:21Z",
        run_id: "run_sb_fabrikam_2026_04_25_needs_input",
        status: "needs_input",
        trace_id: "trace_sb_run_fabrikam",
      },
    ],
    failure_reason: null,
    finished_at: null,
    first_at: "2026-04-25T08:00:00Z",
    grant_id: null,
    last_at: "2026-04-25T08:00:21Z",
    needs_input: true,
    run_id: "run_sb_fabrikam_2026_04_25_needs_input",
    started_at: "2026-04-25T08:00:00Z",
    status: "needs_input",
  },
] as const;

// ─── Traces ────────────────────────────────────────────────────────────────

/** Traces are a denormalized view: per-trace summaries assembled from grant + run events. */
export const DEMO_TRACES: readonly DemoTraceDef[] = [
  {
    client_id: "client_quill_tax_demo",
    events: [],
    failure_reason: null,
    first_at: "2026-04-22T16:01:00Z",
    grant_id: "grant_sb_quill_paystmt",
    kinds: ["request.received", "consent.presented", "grant.issued", "resource.read.succeeded"],
    last_at: "2026-04-22T16:02:35Z",
    run_id: null,
    status: "succeeded",
    trace_id: "trace_sb_quill_paystmt",
  },
  {
    client_id: "client_ledger_atlas_demo",
    events: [],
    failure_reason: "grant_revoked",
    first_at: "2026-04-10T09:00:00Z",
    grant_id: "grant_sb_ledger_txns_revoked",
    kinds: ["request.received", "grant.issued", "grant.revoked", "resource.read.refused"],
    last_at: "2026-04-23T12:00:00Z",
    run_id: null,
    status: "revoked",
    trace_id: "trace_sb_ledger_txns",
  },
  {
    client_id: "client_sherwood_health_demo",
    events: [],
    failure_reason: "owner_declined",
    first_at: "2026-04-20T18:30:00Z",
    grant_id: null,
    kinds: ["request.received", "consent.declined"],
    last_at: "2026-04-20T18:31:11Z",
    run_id: null,
    status: "denied",
    trace_id: "trace_sb_sherwood_visits",
  },
  {
    client_id: null,
    events: [],
    failure_reason: "captcha_challenge_unresolved",
    first_at: "2026-04-24T03:15:00Z",
    grant_id: null,
    kinds: ["run.started", "run.failed"],
    last_at: "2026-04-24T03:16:11Z",
    run_id: "run_sb_northwind_2026_04_24_failed",
    status: "failed",
    trace_id: "trace_sb_run_northwind",
  },
] as const;

// ─── Capabilities (deployment metadata) ────────────────────────────────────

export const DEMO_CAPABILITIES: readonly DemoCapabilityDef[] = [
  {
    capability: "scoped_grant_issuance",
    demonstrated_in_demo: true,
    description: "Owner approves a request restricted to specific streams and fields.",
    implemented: true,
    notes: "See grant_sb_quill_paystmt and the /sandbox/walkthrough story.",
  },
  {
    capability: "grant_revocation",
    demonstrated_in_demo: true,
    description: "Owner can revoke an outstanding grant; subsequent reads are refused.",
    implemented: true,
    notes: "See grant_sb_ledger_txns_revoked.",
  },
  {
    capability: "consent_decline",
    demonstrated_in_demo: true,
    description: "Owner can decline a request without minting a grant.",
    implemented: true,
    notes: "See grant_sb_sherwood_visits_denied.",
  },
  {
    capability: "stream_schema_discovery",
    demonstrated_in_demo: true,
    description: "Clients enumerate available streams and field schemas before requesting.",
    implemented: true,
    notes: "GET /sandbox/v1/schema and /sandbox/v1/streams.",
  },
  {
    capability: "lexical_search",
    demonstrated_in_demo: true,
    description: "Operator can search retained records by free-text keywords.",
    implemented: true,
    notes: "GET /sandbox/v1/search.",
  },
  {
    capability: "single_use_access",
    demonstrated_in_demo: false,
    description: "A grant can be marked single-use so it cannot be replayed.",
    implemented: true,
    notes: "Single-use semantics are visible in walkthrough JSON; not yet enforced by sandbox API.",
  },
  {
    capability: "token_introspection",
    demonstrated_in_demo: false,
    description: "Authorization server exposes RFC 7662-style introspection.",
    implemented: true,
    notes: "Introspection is a normative reference feature; sandbox documents it but does not stub it.",
  },
  {
    capability: "semantic_search",
    demonstrated_in_demo: false,
    description: "Vector-backed semantic search over retained records.",
    implemented: true,
    notes: "Sandbox uses lexical search only; semantic backend requires a model cache.",
  },
];
