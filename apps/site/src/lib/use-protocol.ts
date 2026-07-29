// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useProtocol — React hook that drives the reference page from a MockPDPPServer
 *
 * This hook owns the protocol state machine. The reference page's sections
 * read from it instead of using hardcoded specimen data. The mock server
 * actually enforces field projection, computes deltas, and refuses revoked grants.
 *
 * Can be swapped to a real server by replacing MockPDPPServer with HTTP calls.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  LONGVIEW_CLIENT_ID,
  LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS,
  LONGVIEW_PURPOSE_CODE,
  LONGVIEW_PURPOSE_DESCRIPTION,
} from "./longview-world.ts";
import { createSeededServer, type Grant, type MockPDPPServer, type QueryResult } from "./mock-server.ts";

export type ProtocolPhase = "idle" | "granted" | "revoked";

export type ClientIntrospection = ReturnType<MockPDPPServer["introspectClientToken"]>;

export interface ProtocolState {
  exportResult: QueryResult | null;
  grant: Grant | null;
  introspection: ClientIntrospection | null;
  phase: ProtocolPhase;
  queryResult: QueryResult | null;
  serverStats: { name: string; recordCount: number; fields: string[] }[];
  syncCursor: string | null;
  syncResult: QueryResult | null;
}

const GRANT_TEMPLATE = {
  access_mode: "continuous" as const,
  client_id: LONGVIEW_CLIENT_ID,
  expires_at: "2027-04-15T00:00:00Z",
  grant_id: "grt_longview01",
  issued_at: "2026-04-15T15:00:00Z",
  purpose_code: LONGVIEW_PURPOSE_CODE,
  purpose_description: LONGVIEW_PURPOSE_DESCRIPTION,
  retention: { max_duration: "P90D", on_expiry: "delete" as const },
  streams: [
    {
      fields: [...LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS],
      name: "pay_statements",
      time_range: { since: "2025-01-01" },
      view: "summary",
    },
    {
      fields: ["grant_type", "quantity", "vesting_start", "vesting_schedule"],
      name: "equity_grants",
      time_range: null,
      view: "vesting_summary",
    },
  ],
};

export function useProtocol() {
  const serverRef = useRef<MockPDPPServer>(createSeededServer());
  const server = serverRef.current;

  const [phase, setPhase] = useState<ProtocolPhase>("idle");
  const [grant, setGrant] = useState<Grant | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [syncResult, setSyncResult] = useState<QueryResult | null>(null);
  const [syncCursor, setSyncCursor] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<QueryResult | null>(null);

  const serverStats = useMemo(() => server.getStreamStats(), [server]);

  // ── Actions ──

  const approve = useCallback(
    (accessMode: "continuous" | "single_use" = "continuous") => {
      const issued = server.issueGrant({
        ...GRANT_TEMPLATE,
        access_mode: accessMode,
        expires_at: accessMode === "single_use" ? "2026-04-15T15:05:00Z" : GRANT_TEMPLATE.expires_at,
      });
      setGrant(issued);
      setPhase("granted");

      // Immediately query to populate the enforce section
      const result = server.query(issued.grant_id, "pay_statements");
      setQueryResult(result);

      // Also do initial sync
      const sync = server.queryChangesSince(issued.grant_id, "pay_statements");
      setSyncResult(sync);
      setSyncCursor(sync.next_changes_since || null);
    },
    [server]
  );

  const deny = useCallback(() => {
    setPhase("idle");
    setGrant(null);
    setQueryResult(null);
    setSyncResult(null);
    setSyncCursor(null);
  }, []);

  const revoke = useCallback(() => {
    if (grant) {
      server.revokeGrant(grant.grant_id);
      setGrant({ ...grant, status: "revoked" });
      setPhase("revoked");

      // Query again to show 403
      const result = server.query(grant.grant_id, "pay_statements");
      setQueryResult(result);
    }
  }, [grant, server]);

  const addNewPayStatements = useCallback(
    (count: number) => {
      for (let i = 0; i < count; i += 1) {
        const idx = 24 + i;
        const payDate = new Date(Date.UTC(2026, 3, 15 + idx * 14));
        const grossPay = 6420 + i * 110;
        const netPay = grossPay - 1540;

        server.addRecord("pay_statements", {
          data: {
            bank_account_last4: "4821",
            employee_id: `emp_${String(5124 + i).padStart(4, "0")}`,
            employer: "Northstar Labs",
            gross_pay: grossPay,
            home_address: "1207 W Maple Ave, Chicago, IL",
            net_pay: netPay,
            pay_period: payDate.toISOString().slice(0, 10),
            tax_id_fragment: "2487",
          },
          emitted_at: payDate.toISOString(),
          key: `pay_new_${idx}`,
        });
      }

      // Re-sync to show the delta
      if (grant && phase === "granted" && syncCursor) {
        const sync = server.queryChangesSince(grant.grant_id, "pay_statements", syncCursor);
        setSyncResult(sync);
        setSyncCursor(sync.next_changes_since || null);
      }
    },
    [grant, phase, syncCursor, server]
  );

  const selfExport = useCallback(
    (streamName: string) => {
      const result = server.selfExport(streamName);
      setExportResult(result);
    },
    [server]
  );

  const reset = useCallback(() => {
    serverRef.current = createSeededServer();
    setPhase("idle");
    setGrant(null);
    setQueryResult(null);
    setSyncResult(null);
    setSyncCursor(null);
    setExportResult(null);
  }, []);

  // The introspection envelope the RS reads before serving any query. Derived
  // from the live grant so it reflects active → revoked transitions: an idle
  // page shows the introspection against the demo grant id (inactive), a
  // granted page shows it active, a revoked page shows active:false.
  const introspection: ClientIntrospection = server.introspectClientToken(grant?.grant_id ?? GRANT_TEMPLATE.grant_id);

  return {
    addNewPayStatements,
    approve,
    deny,
    exportResult,
    grant,
    introspection,
    phase,
    queryResult,
    reset,
    revoke,
    selfExport,
    serverStats,
    syncCursor,
    syncResult,
  };
}
