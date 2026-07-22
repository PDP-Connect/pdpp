// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ConsentCard — the user-facing grant-approval surface. Human-temperature.

const DEFAULT_SCOPES = [
  {
    id: "pay",
    title: "Pay statements",
    sub: "Employer, pay period, gross & net pay.",
    scope: "pay_statements.read",
    tag: "append only",
    retention: "2y 1mo",
    on: true,
  },
  {
    id: "emp",
    title: "Employment",
    sub: "Current and previous employers with dates.",
    scope: "employment.read",
    tag: "mutable state",
    retention: "current + 5y",
    on: true,
  },
  {
    id: "tax",
    title: "Tax documents",
    sub: "W-2 and 1099 forms issued to you.",
    scope: "tax_docs.read",
    tag: "append only",
    retention: "3y history",
    on: false,
  },
];

const ConsentCard = () => {
  const [scopes, setScopes] = React.useState(DEFAULT_SCOPES);
  const toggle = (id) => setScopes((s) => s.map((x) => (x.id === id ? { ...x, on: !x.on } : x)));
  const anyOn = scopes.some((s) => s.on);
  return (
    <div className="pdpp-surface-human" style={{ overflow: "hidden", maxWidth: 640 }}>
      <div style={{ padding: "22px 24px 18px" }}>
        <div className="pdpp-eyebrow" style={{ color: "var(--human)" }}>
          CONSENT · SECTION 3
        </div>
        <div className="pdpp-heading" style={{ marginTop: 10, fontSize: 22, lineHeight: 1.25 }}>
          Longview Planning wants access to your data
        </div>
        <p className="pdpp-body" style={{ margin: "10px 0 0", color: "var(--muted-foreground)" }}>
          They’ll use it for{" "}
          <span style={{ color: "var(--edu-fg)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
            long-term financial planning
          </span>
          . You can revoke at any time.
        </p>
      </div>
      <hr className="pdpp-rule" />
      <div>
        {scopes.map((s, i) => (
          <div
            key={s.id}
            onClick={() => toggle(s.id)}
            style={{
              display: "grid",
              gridTemplateColumns: "24px 1fr auto",
              gap: 12,
              padding: "14px 24px",
              borderTop: i > 0 ? "1px solid var(--border)" : "none",
              cursor: "pointer",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                marginTop: 2,
                background: s.on ? "var(--foreground)" : "var(--card)",
                border: s.on ? "1px solid var(--foreground)" : "1px solid var(--input)",
                position: "relative",
              }}
            >
              {s.on && (
                <svg viewBox="0 0 18 18" style={{ position: "absolute", inset: 0 }}>
                  <path
                    d="M4 9.5 L7.5 13 L14 5.5"
                    stroke="var(--background)"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <div>
              <div className="pdpp-title">{s.title}</div>
              <div className="pdpp-caption" style={{ color: "var(--muted-foreground)", marginTop: 2 }}>
                {s.sub}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                <span className="pdpp-badge pdpp-badge-outline">{s.tag}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--muted-foreground)" }}>
                  {s.scope}
                </span>
              </div>
            </div>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "var(--muted-foreground)",
                whiteSpace: "nowrap",
              }}
            >
              {s.retention}
            </span>
          </div>
        ))}
      </div>
      <hr className="pdpp-rule" />
      <div style={{ padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="pdpp-caption" style={{ color: "var(--muted-foreground)" }}>
          These are their commitments, not enforced by your server.
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="pdpp-btn pdpp-btn-ghost" style={{ height: 34, fontSize: 13 }}>
            Deny
          </button>
          <button
            className="pdpp-btn pdpp-btn-primary"
            style={{ height: 34, fontSize: 13, opacity: anyOn ? 1 : 0.5 }}
            disabled={!anyOn}
          >
            Grant access
          </button>
        </div>
      </div>
    </div>
  );
};

window.ConsentCard = ConsentCard;
