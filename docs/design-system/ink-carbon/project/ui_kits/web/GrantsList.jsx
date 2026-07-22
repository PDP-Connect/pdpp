// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GrantsList — the owner's dashboard of active grants.

const GRANTS = [
  {
    client: "Longview Planning",
    expires: "Dec 14, 2025",
    id: "grt_longview01",
    issued: "Oct 14, 2025",
    monogram: "LV",
    purpose: "long_term_financial_planning",
    scopes: ["pay_statements.read", "employment.read"],
    status: "active",
  },
  {
    client: "Acme KYC",
    expires: "Nov 03, 2025",
    id: "grt_acme_kyc_02",
    issued: "Nov 02, 2025",
    monogram: "AK",
    purpose: "identity_verification",
    scopes: ["identity.read"],
    status: "active",
  },
  {
    client: "Forecast Mortgage",
    expires: "in 2 days",
    id: "grt_forecast_17",
    issued: "Sep 28, 2025",
    monogram: "FM",
    purpose: "underwriting_review",
    scopes: ["pay_statements.read", "tax_docs.read", "employment.read"],
    status: "expiring",
  },
  {
    client: "Old Medical LLC",
    expires: "—",
    id: "grt_oldmedical",
    issued: "Aug 05, 2025",
    monogram: "OM",
    purpose: "insurance_claim",
    scopes: ["identity.read"],
    status: "revoked",
  },
];

const STATUS_CLASS = {
  active: "pdpp-badge-success",
  expiring: "pdpp-badge-warning",
  revoked: "pdpp-badge-destructive",
};

const GrantsList = ({ onOpen }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ alignItems: "flex-end", display: "flex", justifyContent: "space-between" }}>
      <div>
        <div className="pdpp-heading">Your grants</div>
        <div className="pdpp-caption" style={{ color: "var(--muted-foreground)" }}>
          4 grants · 2 active · 1 expiring · 1 revoked
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="pdpp-btn pdpp-btn-ghost" style={{ fontSize: 12, height: 30 }}>
          Filter
        </button>
        <button className="pdpp-btn pdpp-btn-outline" style={{ fontSize: 12, height: 30 }}>
          Export
        </button>
      </div>
    </div>
    {GRANTS.map((g) => (
      <div
        className={g.status === "revoked" ? "pdpp-surface-neutral" : "pdpp-surface-protocol"}
        key={g.id}
        onClick={() => onOpen && onOpen(g)}
        style={{ cursor: "pointer", opacity: g.status === "revoked" ? 0.65 : 1, padding: "14px 16px" }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 14, justifyContent: "space-between" }}>
          <div style={{ alignItems: "center", display: "flex", gap: 12, minWidth: 0 }}>
            <div
              style={{
                alignItems: "center",
                background: g.status === "revoked" ? "var(--muted)" : "oklch(0.52 0.09 45 / 0.14)",
                borderRadius: 6,
                color: g.status === "revoked" ? "var(--muted-foreground)" : "var(--human)",
                display: "flex",
                flexShrink: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 600,
                height: 32,
                justifyContent: "center",
                width: 32,
              }}
            >
              {g.monogram}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="pdpp-title">{g.client}</div>
              <div style={{ color: "var(--edu-fg)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                // {g.purpose}
              </div>
            </div>
          </div>
          <span className={`pdpp-badge ${STATUS_CLASS[g.status]}`}>
            <span className="pdpp-dot" />
            {g.status}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {g.scopes.map((sc) => (
            <span className="pdpp-chip" key={sc} style={{ fontSize: 11, padding: "1px 8px" }}>
              {sc}
            </span>
          ))}
        </div>
        <div
          style={{
            color: "var(--muted-foreground)",
            display: "flex",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            gap: 18,
            marginTop: 10,
          }}
        >
          <span>{g.id}</span>
          <span>issued {g.issued}</span>
          <span>expires {g.expires}</span>
        </div>
      </div>
    ))}
  </div>
);

window.GrantsList = GrantsList;
