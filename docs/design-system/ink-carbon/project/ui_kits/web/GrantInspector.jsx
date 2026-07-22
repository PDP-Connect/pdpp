// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GrantInspector — the protocol-temperature companion to ConsentCard.
// Shows a grant "as issued" in machine terms.

const GrantInspector = ({ grantId = "grt_longview01" }) => (
  <div className="pdpp-surface-protocol" style={{ maxWidth: 640, overflow: "hidden" }}>
    <div style={{ padding: "20px 24px 14px" }}>
      <div style={{ alignItems: "flex-start", display: "flex", justifyContent: "space-between" }}>
        <div>
          <div className="pdpp-eyebrow" style={{ color: "var(--primary)" }}>
            GRANT · ISSUED
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 18,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              marginTop: 6,
            }}
          >
            {grantId}
          </div>
        </div>
        <span className="pdpp-badge pdpp-badge-success">
          <span className="pdpp-dot" />
          active
        </span>
      </div>
    </div>
    <hr className="pdpp-rule" />
    <div style={{ display: "grid", gap: 0, gridTemplateColumns: "120px 1fr" }}>
      {[
        ["purpose", <span style={{ color: "var(--edu-fg)" }}>long_term_financial_planning</span>],
        ["mode", "continuous"],
        ["scopes", <span>pay_statements.read · employment.read</span>],
        ["fields", "employer, pay_period, gross_pay, net_pay"],
        ["time_range", "last 2y 1mo"],
        ["issued", "2025-10-14T09:22:07Z"],
        ["expires", "2025-12-14T09:22:07Z"],
      ].map(([k, v], i) => (
        <React.Fragment key={k}>
          <div
            style={{
              borderTop: "1px solid var(--border)",
              color: "var(--muted-foreground)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: "9px 24px",
            }}
          >
            {k}
          </div>
          <div
            style={{
              borderTop: "1px solid var(--border)",
              color: "var(--foreground)",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              padding: "9px 24px 9px 0",
            }}
          >
            {v}
          </div>
        </React.Fragment>
      ))}
    </div>
    <hr className="pdpp-rule" />
    <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", padding: "12px 24px" }}>
      <span className="pdpp-caption" style={{ color: "var(--muted-foreground)" }}>
        The grant is the artifact. Collection is a companion mechanism.
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="pdpp-btn pdpp-btn-ghost" style={{ fontSize: 12, height: 30 }}>
          Copy JSON
        </button>
        <button className="pdpp-btn pdpp-btn-outline" style={{ fontSize: 12, height: 30 }}>
          Revoke ↺
        </button>
      </div>
    </div>
  </div>
);

window.GrantInspector = GrantInspector;
