// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// StreamInventory — a list of declared streams with their shapes and access mode.

const STREAMS = [
  { fields: 6, granted: 3, id: "pay_statements", mode: "append only", recent: "2 days ago", title: "Pay statements" },
  { fields: 4, granted: 2, id: "employment", mode: "mutable state", recent: "1 month ago", title: "Employment" },
  { fields: 5, granted: 1, id: "tax_docs", mode: "append only", recent: "3 months ago", title: "Tax documents" },
  { fields: 3, granted: 0, id: "identity", mode: "mutable state", recent: "never", title: "Identity" },
  { fields: 8, granted: 4, id: "transactions", mode: "append only", recent: "today", title: "Transactions" },
];

const StreamInventory = () => (
  <div className="pdpp-surface-neutral" style={{ overflow: "hidden" }}>
    <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", padding: "16px 20px" }}>
      <div>
        <div className="pdpp-title">Streams</div>
        <div className="pdpp-caption" style={{ color: "var(--muted-foreground)" }}>
          5 declared · 3 sharing with at least one grant
        </div>
      </div>
      <button className="pdpp-btn pdpp-btn-outline" style={{ fontSize: 12, height: 30 }}>
        + Declare stream
      </button>
    </div>
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        borderTop: "1px solid var(--border)",
        color: "var(--muted-foreground)",
        display: "grid",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        gridTemplateColumns: "1.6fr 1fr 0.7fr 1fr 0.6fr",
        letterSpacing: "0.05em",
        padding: "8px 20px",
        textTransform: "uppercase",
      }}
    >
      <span>stream</span>
      <span>mode</span>
      <span>fields</span>
      <span>last record</span>
      <span style={{ textAlign: "right" }}>grants</span>
    </div>
    {STREAMS.map((s, i) => (
      <div
        key={s.id}
        style={{
          alignItems: "center",
          borderTop: i > 0 ? "1px solid var(--border)" : "none",
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr 0.7fr 1fr 0.6fr",
          padding: "12px 20px",
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{s.title}</div>
          <div style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{s.id}</div>
        </div>
        <span className={`pdpp-badge ${s.mode === "append only" ? "pdpp-badge-protocol" : "pdpp-badge-neutral"}`}>
          {s.mode}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{s.fields}</span>
        <span style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {s.recent}
        </span>
        <span
          style={{
            color: s.granted ? "var(--foreground)" : "var(--muted-foreground)",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            textAlign: "right",
          }}
        >
          {s.granted || "—"}
        </span>
      </div>
    ))}
  </div>
);

window.StreamInventory = StreamInventory;
