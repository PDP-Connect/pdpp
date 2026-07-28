// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// CodeBlock + FlowDiagram — teaching units used throughout the site/docs.

const CodeBlock = ({ children, caption }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    <pre
      style={{
        margin: 0,
        padding: "14px 16px",
        background: "oklch(0.14 0 0)",
        color: "oklch(0.85 0.005 95)",
        borderRadius: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        lineHeight: 1.65,
        overflow: "auto",
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

const surfaceByKind = {
  human: "pdpp-surface-human",
  protocol: "pdpp-surface-protocol",
  neutral: "pdpp-surface-neutral",
};

const colorByKind = {
  human: "var(--human)",
  protocol: "var(--primary)",
  neutral: "var(--muted-foreground)",
};

const Node = ({ kind, eyebrow, title, sub }) => (
  <div className={surfaceByKind[kind]} style={{ padding: "12px 14px", minWidth: 160 }}>
    <div
      className="pdpp-eyebrow"
      style={{
        fontSize: 10.5,
        color: colorByKind[kind],
      }}
    >
      {eyebrow}
    </div>
    <div className="pdpp-title" style={{ marginTop: 3 }}>
      {title}
    </div>
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>
      {sub}
    </div>
  </div>
);

const Arrow = ({ label }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 60 }}>
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--primary)" }}>{label}</span>
    <div style={{ width: "100%", height: 1, background: "var(--border)", position: "relative", marginTop: 4 }}>
      <span
        style={{
          position: "absolute",
          right: -1,
          top: -4,
          borderRight: "1px solid var(--muted-foreground)",
          borderBottom: "1px solid var(--muted-foreground)",
          width: 7,
          height: 7,
          transform: "rotate(-45deg)",
        }}
      />
    </div>
  </div>
);

const FlowDiagram = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <Node eyebrow="HOLDER" kind="human" sub="user records" title="Personal vault" />
    <Arrow label="grant" />
    <Node eyebrow="PROTOCOL" kind="protocol" sub="pay_statements.read" title="Grant + stream" />
    <Arrow label="records" />
    <Node eyebrow="CLIENT" kind="neutral" sub="purpose: planning" title="Longview Planning" />
  </div>
);

window.CodeBlock = CodeBlock;
window.FlowDiagram = FlowDiagram;
