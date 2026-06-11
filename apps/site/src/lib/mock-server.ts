/**
 * In-memory PDPP mock server
 *
 * Implements the core protocol operations client-side:
 * - Grant issuance from a selection request
 * - Query with field projection enforcement
 * - Incremental sync (changes_since) with projection-aware deltas
 * - Revocation
 * - Self-export via owner token
 *
 * This is NOT a toy mock — it enforces the same constraints as a real RS.
 * The grant is the enforcement boundary. Field projection strips unauthorized
 * fields from every response. Revoked grants return 403.
 *
 * Can be swapped for a real server connection via the same interface.
 */

import { LONGVIEW_PAY_STATEMENT_ALL_FIELDS } from "./longview-world.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Record {
  data: { [field: string]: unknown };
  emitted_at: string;
  key: string;
}

export interface Stream {
  name: string;
  records: Record[];
  schema_fields: string[]; // all fields the stream has
  semantics: "append_only" | "mutable_state";
}

export interface Grant {
  access_mode: "continuous" | "single_use";
  client_id: string;
  expires_at: string | null;
  grant_id: string;
  issued_at: string;
  purpose_code: string;
  purpose_description: string;
  retention: { max_duration: string; on_expiry: "delete" | "anonymize" } | null;
  status: "active" | "revoked" | "expired";
  streams: GrantStream[];
}

export interface GrantStream {
  fields: string[] | null; // null = all fields
  name: string;
  time_range: { since?: string; until?: string } | null;
  view: string | null;
}

export interface QueryResult {
  error?: string;
  has_more: boolean;
  next_changes_since?: string;
  records?: Record[];
  status: number;
}

// ─── Mock Server ────────────────────────────────────────────────────────────

export class MockPDPPServer {
  private readonly streams: Map<string, Stream> = new Map();
  private readonly grants: Map<string, Grant> = new Map();
  private readonly syncCursors: Map<string, number> = new Map(); // grant_id -> record index

  // ── Data seeding ──

  addStream(stream: Stream) {
    this.streams.set(stream.name, stream);
  }

  addRecord(streamName: string, record: Record) {
    const stream = this.streams.get(streamName);
    if (!stream) {
      throw new Error(`Unknown stream: ${streamName}`);
    }
    stream.records.push(record);
  }

  // ── Grant management ──

  issueGrant(grant: Omit<Grant, "status">): Grant {
    const issued: Grant = { ...grant, status: "active" };
    this.grants.set(grant.grant_id, issued);
    // Initialize sync cursor at 0 (full sync on first query)
    this.syncCursors.set(grant.grant_id, 0);
    return issued;
  }

  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.status !== "active") {
      return false;
    }
    grant.status = "revoked";
    return true;
  }

  getGrant(grantId: string): Grant | null {
    return this.grants.get(grantId) || null;
  }

  // ── Query (client token path) ──

  query(grantId: string, streamName: string): QueryResult {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return { status: 403, error: "grant_invalid", records: [], has_more: false };
    }
    if (grant.status === "revoked") {
      return { status: 403, error: "grant_revoked", records: [], has_more: false };
    }
    if (grant.status === "expired") {
      return { status: 403, error: "grant_expired", records: [], has_more: false };
    }

    // Check stream is in grant
    const grantStream = grant.streams.find((s) => s.name === streamName);
    if (!grantStream) {
      return { status: 403, error: "insufficient_scope", records: [], has_more: false };
    }

    const stream = this.streams.get(streamName);
    if (!stream) {
      return { status: 404, error: "stream_not_found", records: [], has_more: false };
    }

    // Apply field projection
    const records = stream.records.map((r) => this.projectRecord(r, grantStream.fields, stream.schema_fields));

    return { status: 200, records, has_more: false };
  }

  // ── Incremental sync (changes_since) ──

  queryChangesSince(grantId: string, streamName: string, cursor?: string): QueryResult {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return { status: 403, error: "grant_invalid", records: [], has_more: false };
    }
    if (grant.status === "revoked") {
      return { status: 403, error: "grant_revoked", records: [], has_more: false };
    }

    const grantStream = grant.streams.find((s) => s.name === streamName);
    if (!grantStream) {
      return { status: 403, error: "insufficient_scope", records: [], has_more: false };
    }

    const stream = this.streams.get(streamName);
    if (!stream) {
      return { status: 404, error: "stream_not_found", records: [], has_more: false };
    }

    // Parse cursor (index into records array)
    const startIdx = cursor ? Number.parseInt(cursor, 10) : 0;
    if (Number.isNaN(startIdx)) {
      return { status: 410, error: "cursor_expired", records: [], has_more: false };
    }

    const newRecords = stream.records.slice(startIdx);
    const projected = newRecords.map((r) => this.projectRecord(r, grantStream.fields, stream.schema_fields));

    return {
      status: 200,
      records: projected,
      has_more: false,
      next_changes_since: String(stream.records.length),
    };
  }

  // ── Self-export (owner token path) ──

  selfExport(streamName: string): QueryResult {
    const stream = this.streams.get(streamName);
    if (!stream) {
      return { status: 404, error: "stream_not_found", records: [], has_more: false };
    }

    // Owner sees all fields, no projection
    return { status: 200, records: [...stream.records], has_more: false };
  }

  // ── Field projection ──

  private projectRecord(record: Record, allowedFields: string[] | null, _allFields: string[]): Record {
    if (!allowedFields) {
      return record; // null = all fields authorized
    }

    const projected: { [field: string]: unknown } = {};
    for (const field of allowedFields) {
      if (field in record.data) {
        projected[field] = record.data[field];
      }
    }

    return {
      key: record.key,
      data: projected,
      emitted_at: record.emitted_at,
    };
  }

  // ── Introspection ──

  introspect(grantId: string): { active: boolean; grant: Grant | null } {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return { active: false, grant: null };
    }
    return { active: grant.status === "active", grant };
  }

  /**
   * RFC 7662-shaped token introspection with the PDPP extensions the RS reads
   * before serving any query: the token kind (owner vs client) and the bound
   * subject. The reference docs describe these exact fields (see the Export
   * section's `pdpp_token_kind` / `subject_id`); this returns the live shape so
   * the reference page can show the real exchange, not prose. The RS determines
   * token kind from introspection, never from token syntax.
   */
  introspectClientToken(grantId: string): {
    active: boolean;
    pdpp_token_kind: "client";
    grant_id: string;
    grant_status: Grant["status"] | "unknown";
    client_id: string | null;
    subject_id: string;
    scope_streams: string[];
  } {
    const grant = this.grants.get(grantId);
    return {
      active: grant?.status === "active",
      pdpp_token_kind: "client",
      grant_id: grantId,
      grant_status: grant?.status ?? "unknown",
      client_id: grant?.client_id ?? null,
      subject_id: "user_abc123",
      scope_streams: grant?.streams.map((s) => s.name) ?? [],
    };
  }

  // ── Stats ──

  getStreamStats(): { name: string; recordCount: number; fields: string[] }[] {
    return Array.from(this.streams.values()).map((s) => ({
      name: s.name,
      recordCount: s.records.length,
      fields: s.schema_fields,
    }));
  }
}

// ─── Seeded instance for the reference page ─────────────────────────────────

export function createSeededServer(): MockPDPPServer {
  const server = new MockPDPPServer();

  const payStatementFields = [...LONGVIEW_PAY_STATEMENT_ALL_FIELDS];
  const equityGrantFields = [
    "grant_type",
    "quantity",
    "vesting_start",
    "vesting_schedule",
    "brokerage_account_last4",
    "beneficiary_name",
  ];
  const benefitsFields = [
    "plan_name",
    "coverage_tier",
    "employer_contribution",
    "effective_date",
    "dependent_count",
    "claims_vendor",
  ];

  server.addStream({
    name: "pay_statements",
    semantics: "append_only",
    schema_fields: payStatementFields,
    records: Array.from({ length: 24 }, (_, i) => {
      const payDate = new Date(Date.UTC(2025, 0, 15 + i * 14));
      const grossPay = 6150 + (i % 4) * 120;
      const netPay = grossPay - 1510 - (i % 3) * 35;

      return {
        key: `pay_${i}`,
        data: {
          employer: "Northstar Labs",
          pay_period: payDate.toISOString().slice(0, 10),
          gross_pay: grossPay,
          net_pay: netPay,
          employee_id: `emp_${String(4100 + i).padStart(4, "0")}`,
          home_address: "1207 W Maple Ave, Chicago, IL",
          bank_account_last4: "4821",
          tax_id_fragment: "2487",
        },
        emitted_at: payDate.toISOString(),
      };
    }),
  });

  const grantTypes = ["ISO", "RSU", "NSO"] as const;
  const grantQuantities = [8000, 2400, 1200] as const;
  server.addStream({
    name: "equity_grants",
    semantics: "mutable_state",
    schema_fields: equityGrantFields,
    records: Array.from({ length: 3 }, (_, i) => ({
      key: `grant_${i}`,
      data: {
        grant_type: grantTypes[i] ?? "NSO",
        quantity: grantQuantities[i] ?? 1200,
        vesting_start: `202${i + 4}-05-01`,
        vesting_schedule: i === 1 ? "4y monthly after 1y cliff" : "4y quarterly after 1y cliff",
        brokerage_account_last4: `71${i}4`,
        beneficiary_name: "Primary beneficiary",
      },
      emitted_at: "2026-04-15T12:00:00Z",
    })),
  });

  server.addStream({
    name: "benefits_enrollments",
    semantics: "mutable_state",
    schema_fields: benefitsFields,
    records: Array.from({ length: 1 }, () => ({
      key: "benefits_0",
      data: {
        plan_name: "Blue Horizon PPO",
        coverage_tier: "Employee + spouse",
        employer_contribution: 840,
        effective_date: "2026-01-01",
        dependent_count: 1,
        claims_vendor: "Northstar Health Services",
      },
      emitted_at: "2026-01-01T12:00:00Z",
    })),
  });

  return server;
}
