// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Hero — the cross-quadrant layout from apps/web. Copper left rule on content column.

const Hero = () => (
  <section style={{ margin: "0 auto", maxWidth: "var(--content-wide-width)", padding: "80px 48px 96px" }}>
    <div
      style={{
        display: "grid",
        gap: 48,
        gridTemplateColumns: "var(--pdpp-sidebar-width) 1fr",
      }}
    >
      <div /> {/* empty quadrant aligned with sidebar */}
      <div
        style={{
          borderLeft: "2px solid var(--human)",
          paddingLeft: 32,
        }}
      >
        <div className="pdpp-eyebrow" style={{ marginBottom: 14 }}>
          PDPP · v0.1.0 draft
        </div>
        <h1 className="pdpp-display-lg" style={{ margin: 0, maxWidth: 880 }}>
          Granular access to <span style={{ color: "var(--primary)" }}>personal data.</span>
        </h1>
        <p
          className="pdpp-body-lg"
          style={{
            color: "var(--muted-foreground)",
            margin: "20px 0 32px",
            maxWidth: 640,
          }}
        >
          An open specification for how personal user data flows through the digital economy. Clients request named
          records and fields. Every response stays inside the grant.
        </p>
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          <button className="pdpp-btn pdpp-btn-primary" style={{ fontSize: 14, height: 40, padding: "0 18px" }}>
            Read the spec
          </button>
          <button className="pdpp-btn pdpp-btn-outline" style={{ fontSize: 14, height: 40, padding: "0 16px" }}>
            View on GitHub ›
          </button>
          <span
            style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 12, marginLeft: 12 }}
          >
            RFC status · draft 3
          </span>
        </div>
        <div
          style={{
            borderBottom: "1px solid var(--border)",
            borderTop: "1px solid var(--border)",
            display: "grid",
            gap: 32,
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            marginTop: 56,
          }}
        >
          {[
            {
              b: "A grant names resources, fields, purpose, duration, and mode.",
              k: "GRANT",
              t: "The portable artifact",
            },
            {
              b: "Pay statements, employment, tax docs — declared, typed, versioned.",
              k: "STREAM",
              t: "Named data shapes",
            },
            {
              b: "Only the granted fields come back. Purpose is declared, not enforced.",
              k: "ENFORCE",
              t: "Server-side boundary",
            },
          ].map((c, i) => (
            <div
              key={i}
              style={{
                borderRight: i < 2 ? "1px solid var(--border)" : "none",
                minWidth: 0,
                padding: "24px 0",
                paddingRight: i < 2 ? 32 : 0,
              }}
            >
              <div className="pdpp-eyebrow" style={{ color: "var(--primary)" }}>
                {c.k}
              </div>
              <div className="pdpp-heading" style={{ marginTop: 6 }}>
                {c.t}
              </div>
              <p className="pdpp-body" style={{ color: "var(--muted-foreground)", margin: "6px 0 0" }}>
                {c.b}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

window.Hero = Hero;
