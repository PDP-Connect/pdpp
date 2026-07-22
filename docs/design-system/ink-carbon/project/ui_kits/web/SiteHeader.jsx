// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Site header — nav with logo, docs/spec/palette links, GitHub CTA
const SiteHeader = ({ active = "home", onNav }) => (
  <header
    style={{
      backdropFilter: "blur(8px)",
      background: "oklch(0.99 0.002 95 / 0.85)",
      borderBottom: "1px solid var(--border)",
      height: "56px",
      position: "sticky",
      top: 0,
      zIndex: 10,
    }}
  >
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 24,
        height: "100%",
        justifyContent: "space-between",
        margin: "0 auto",
        maxWidth: "var(--content-wide-width)",
        padding: "0 48px",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
        <div
          style={{
            alignItems: "center",
            background: "var(--primary)",
            borderRadius: 4,
            color: "var(--primary-foreground)",
            display: "flex",
            fontSize: 11,
            fontWeight: 700,
            height: 22,
            justifyContent: "center",
            width: 22,
          }}
        >
          P
        </div>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.02em" }}>PDPP</span>
        <span className="pdpp-chip" style={{ fontSize: 11, marginLeft: 4, padding: "0 6px" }}>
          v0.1.0
        </span>
      </div>
      <nav style={{ alignItems: "center", display: "flex", gap: 4 }}>
        {["home", "spec", "design", "palette", "docs"].map((k) => (
          <button
            className="pdpp-btn pdpp-btn-ghost"
            key={k}
            onClick={() => onNav && onNav(k)}
            style={{
              color: active === k ? "var(--foreground)" : "var(--muted-foreground)",
              fontSize: 13,
              fontWeight: active === k ? 500 : 400,
              height: 32,
              padding: "0 10px",
            }}
          >
            {k}
          </button>
        ))}
        <div style={{ background: "var(--border)", height: 18, margin: "0 8px", width: 1 }} />
        <button className="pdpp-btn pdpp-btn-outline" style={{ fontSize: 12.5, height: 30 }}>
          <svg fill="currentColor" height="14" viewBox="0 0 24 24" width="14">
            <path d="M12 0C5.37 0 0 5.5 0 12.3c0 5.44 3.44 10.05 8.21 11.68.6.12.82-.27.82-.6v-2.1c-3.34.74-4.04-1.64-4.04-1.64-.55-1.42-1.34-1.8-1.34-1.8-1.09-.76.08-.75.08-.75 1.21.09 1.85 1.27 1.85 1.27 1.08 1.89 2.82 1.34 3.5 1.03.11-.8.42-1.34.76-1.65-2.66-.31-5.46-1.36-5.46-6.07 0-1.34.47-2.44 1.24-3.3-.12-.31-.54-1.56.12-3.26 0 0 1.01-.33 3.31 1.26.96-.27 2-.41 3.03-.42 1.02.01 2.07.15 3.04.42 2.3-1.59 3.3-1.26 3.3-1.26.67 1.7.25 2.95.12 3.26.77.86 1.23 1.96 1.23 3.3 0 4.72-2.81 5.76-5.48 6.06.43.38.82 1.12.82 2.25v3.33c0 .33.22.72.83.6C20.57 22.34 24 17.73 24 12.3 24 5.5 18.63 0 12 0z" />
          </svg>
          GitHub
        </button>
      </nav>
    </div>
  </header>
);

window.SiteHeader = SiteHeader;
