// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// CodeBlock + FlowDiagram — teaching units used throughout the site/docs.

const CodeBlock = ({ children, caption }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    <pre
      style={{
        background: "oklch(0.14 0 0)",
        borderRadius: 8,
        color: "oklch(0.85 0.005 95)",
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        lineHeight: 1.65,
        margin: 0,
        overflow: "auto",
        padding: "14px 16px",
        whiteSpace: "pre",
      }}
    >
      {children}
    </pre>
    {caption && (
      <div className="pdpp-caption" style={{ color: "var(--muted-foreground)" }}>
        {caption}
      </div>
    )}
  </div>
);

const Node = ({ kind, eyebrow, title, sub }) => (
  <div
    className={
      kind === "human" ? "pdpp-surface-human" : kind === "protocol" ? "pdpp-surface-protocol" : "pdpp-surface-neutral"
    }
    style={{ minWidth: 160, padding: "12px 14px" }}
  >
    <div
      className="pdpp-eyebrow"
      style={{
        color: kind === "human" ? "var(--human)" : kind === "protocol" ? "var(--primary)" : "var(--muted-foreground)",
        fontSize: 10.5,
      }}
    >
      {eyebrow}
    </div>
    <div className="pdpp-title" style={{ marginTop: 3 }}>
      {title}
    </div>
    <div style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 11, marginTop: 2 }}>
      {sub}
    </div>
  </div>
);

const Arrow = ({ label }) => (
  <div style={{ alignItems: "center", display: "flex", flexDirection: "column", minWidth: 60 }}>
    <span style={{ color: "var(--primary)", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{label}</span>
    <div style={{ background: "var(--border)", height: 1, marginTop: 4, position: "relative", width: "100%" }}>
      <span
        style={{
          borderBottom: "1px solid var(--muted-foreground)",
          borderRight: "1px solid var(--muted-foreground)",
          height: 7,
          position: "absolute",
          right: -1,
          top: -4,
          transform: "rotate(-45deg)",
          width: 7,
        }}
      />
    </div>
  </div>
);

const FlowDiagram = () => (
  <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
    <Node eyebrow="HOLDER" kind="human" sub="user records" title="Personal vault" />
    <Arrow label="grant" />
    <Node eyebrow="PROTOCOL" kind="protocol" sub="pay_statements.read" title="Grant + stream" />
    <Arrow label="records" />
    <Node eyebrow="CLIENT" kind="neutral" sub="purpose: planning" title="Longview Planning" />
  </div>
);

window.CodeBlock = CodeBlock;
window.FlowDiagram = FlowDiagram;
