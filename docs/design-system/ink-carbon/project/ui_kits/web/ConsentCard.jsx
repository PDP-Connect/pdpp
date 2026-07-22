// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ConsentCard — the user-facing grant-approval surface. Human-temperature.

const DEFAULT_SCOPES = [
  {
    id: "pay",
    on: true,
    retention: "2y 1mo",
    scope: "pay_statements.read",
    sub: "Employer, pay period, gross & net pay.",
    tag: "append only",
    title: "Pay statements",
  },
  {
    id: "emp",
    on: true,
    retention: "current + 5y",
    scope: "employment.read",
    sub: "Current and previous employers with dates.",
    tag: "mutable state",
    title: "Employment",
  },
  {
    id: "tax",
    on: false,
    retention: "3y history",
    scope: "tax_docs.read",
    sub: "W-2 and 1099 forms issued to you.",
    tag: "append only",
    title: "Tax documents",
  },
];

const ConsentCard = () => {
  const [scopes, setScopes] = React.useState(DEFAULT_SCOPES);
  const toggle = (id) => setScopes((s) => s.map((x) => (x.id === id ? { ...x, on: !x.on } : x)));
  const anyOn = scopes.some((s) => s.on);
  return (
    <div className="pdpp-surface-human" style={{ maxWidth: 640, overflow: "hidden" }}>
      <div style={{ padding: "22px 24px 18px" }}>
        <div className="pdpp-eyebrow" style={{ color: "var(--human)" }}>
          CONSENT · SECTION 3
        </div>
        <div className="pdpp-heading" style={{ fontSize: 22, lineHeight: 1.25, marginTop: 10 }}>
          Longview Planning wants access to your data
        </div>
        <p className="pdpp-body" style={{ color: "var(--muted-foreground)", margin: "10px 0 0" }}>
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
              alignItems: "flex-start",
              borderTop: i > 0 ? "1px solid var(--border)" : "none",
              cursor: "pointer",
              display: "grid",
              gap: 12,
              gridTemplateColumns: "24px 1fr auto",
              padding: "14px 24px",
            }}
          >
            <div
              style={{
                background: s.on ? "var(--foreground)" : "var(--card)",
                border: s.on ? "1px solid var(--foreground)" : "1px solid var(--input)",
                borderRadius: 4,
                height: 18,
                marginTop: 2,
                position: "relative",
                width: 18,
              }}
            >
              {s.on && (
                <svg style={{ inset: 0, position: "absolute" }} viewBox="0 0 18 18">
                  <path
                    d="M4 9.5 L7.5 13 L14 5.5"
                    fill="none"
                    stroke="var(--background)"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                </svg>
              )}
            </div>
            <div>
              <div className="pdpp-title">{s.title}</div>
              <div className="pdpp-caption" style={{ color: "var(--muted-foreground)", marginTop: 2 }}>
                {s.sub}
              </div>
              <div style={{ alignItems: "center", display: "flex", gap: 6, marginTop: 8 }}>
                <span className="pdpp-badge pdpp-badge-outline">{s.tag}</span>
                <span style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                  {s.scope}
                </span>
              </div>
            </div>
            <span
              style={{
                color: "var(--muted-foreground)",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                whiteSpace: "nowrap",
              }}
            >
              {s.retention}
            </span>
          </div>
        ))}
      </div>
      <hr className="pdpp-rule" />
      <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", padding: "14px 24px" }}>
        <span className="pdpp-caption" style={{ color: "var(--muted-foreground)" }}>
          These are their commitments, not enforced by your server.
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="pdpp-btn pdpp-btn-ghost" style={{ fontSize: 13, height: 34 }}>
            Deny
          </button>
          <button
            className="pdpp-btn pdpp-btn-primary"
            disabled={!anyOn}
            style={{ fontSize: 13, height: 34, opacity: anyOn ? 1 : 0.5 }}
          >
            Grant access
          </button>
        </div>
      </div>
    </div>
  );
};

window.ConsentCard = ConsentCard;
