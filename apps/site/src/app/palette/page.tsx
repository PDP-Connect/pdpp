"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Warm tone sampler — shows each candidate in the actual context it would be used:
// 1. As a left border rule on the title block
// 2. As a background wash behind a human surface
// 3. Against the protocol blue (--primary) to test the duality

const CANDIDATES = [
  {
    border: "oklch(0.75 0.06 15)",
    description: "Lower chroma, lighter. Refined.",
    name: "Rose — soft",
    swatch: "oklch(0.75 0.06 15)",
    wash: "oklch(0.75 0.06 15 / 0.07)",
  },
  {
    border: "oklch(0.72 0.08 20)",
    description: "Original. Explicit, human.",
    name: "Rose",
    swatch: "oklch(0.72 0.08 20)",
    wash: "oklch(0.72 0.08 20 / 0.07)",
  },
  {
    border: "oklch(0.65 0.10 35)",
    description: "Rose toward orange. Earthier.",
    name: "Terracotta",
    swatch: "oklch(0.65 0.10 35)",
    wash: "oklch(0.65 0.10 35 / 0.07)",
  },
  {
    border: "oklch(0.55 0.09 25)",
    description: "Deep muted rose. Serious.",
    name: "Brick",
    swatch: "oklch(0.55 0.09 25)",
    wash: "oklch(0.55 0.09 25 / 0.07)",
  },
  {
    border: "oklch(0.70 0.12 55)",
    description: "Brighter, more orange. Near amber.",
    name: "Copper — light",
    swatch: "oklch(0.70 0.12 55)",
    wash: "oklch(0.70 0.12 55 / 0.07)",
  },
  {
    border: "oklch(0.62 0.10 50)",
    description: "Original. Warm but precise.",
    name: "Copper",
    swatch: "oklch(0.62 0.10 50)",
    wash: "oklch(0.62 0.10 50 / 0.07)",
  },
  {
    border: "oklch(0.52 0.09 45)",
    description: "Darker, richer. More bronze.",
    name: "Copper — deep",
    swatch: "oklch(0.52 0.09 45)",
    wash: "oklch(0.52 0.09 45 / 0.07)",
  },
  {
    border: "oklch(0.58 0.11 35)",
    description: "Red-copper. More oxide, aged.",
    name: "Copper — red",
    swatch: "oklch(0.58 0.11 35)",
    wash: "oklch(0.58 0.11 35 / 0.07)",
  },
  {
    border: "oklch(0.60 0.04 80)",
    description: "Earthy neutral. Already in Vana.",
    name: "Vana Stone",
    swatch: "oklch(0.60 0.04 80)",
    wash: "oklch(0.60 0.04 80 / 0.07)",
  },
];

const PROTOCOL_BLUE = "oklch(0.580 0.172 253.7)";

export default function PalettePage() {
  return (
    <div
      style={{
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
        fontFamily: "var(--font-sans)",
        minHeight: "100vh",
        padding: "48px 64px",
      }}
    >
      <div style={{ maxWidth: "900px" }}>
        <div style={{ marginBottom: "48px" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "8px" }}>Warm tone candidates</h1>
          <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem", lineHeight: 1.6, maxWidth: "52ch" }}>
            Each candidate shown in three contexts: as a left border rule, as a background wash, and paired with the
            protocol blue to test the human/protocol duality.
          </p>
        </div>

        {/* Test 1: 2px border on white — does it survive at actual pixel weight? */}
        <div style={{ marginBottom: "48px" }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, marginBottom: "4px" }}>Test 1 — 2px border on white</div>
          <div style={{ color: "var(--muted-foreground)", fontSize: "0.8125rem", marginBottom: "20px" }}>
            The hardest context. Most colors disappear or go muddy at 2px.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
            {CANDIDATES.map(({ name, border, swatch }) => (
              <div key={name} style={{ alignItems: "center", display: "flex", gap: "16px" }}>
                <div
                  style={{
                    backgroundColor: swatch,
                    borderRadius: "3px",
                    boxShadow: "inset 0 0 0 1px oklch(0 0 0 / 0.1)",
                    flexShrink: 0,
                    height: "14px",
                    width: "14px",
                  }}
                />
                <div
                  style={{
                    backgroundColor: "white",
                    borderLeft: `2px solid ${border}`,
                    flex: 1,
                    paddingBottom: "10px",
                    paddingLeft: "14px",
                    paddingTop: "10px",
                  }}
                >
                  <span style={{ fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1 }}>
                    Design System
                  </span>
                </div>
                <span style={{ color: "var(--muted-foreground)", flexShrink: 0, fontSize: "0.75rem", width: "120px" }}>
                  {name}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Test 2: Coexistence with #187adc — intentional contrast or accidental clash? */}
        <div style={{ marginBottom: "48px" }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, marginBottom: "4px" }}>
            Test 2 — alongside protocol blue
          </div>
          <div style={{ color: "var(--muted-foreground)", fontSize: "0.8125rem", marginBottom: "20px" }}>
            Human row (warm) above protocol row (blue). Do they read as intentionally different or accidentally
            clashing?
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {CANDIDATES.map(({ name, border, wash, swatch }) => (
              <div key={name} style={{ alignItems: "stretch", display: "flex", gap: "16px" }}>
                <div
                  style={{
                    backgroundColor: swatch,
                    borderRadius: "3px",
                    boxShadow: "inset 0 0 0 1px oklch(0 0 0 / 0.1)",
                    flexShrink: 0,
                    height: "14px",
                    marginTop: "10px",
                    width: "14px",
                  }}
                />
                <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: "2px" }}>
                  <div
                    style={{
                      background: `linear-gradient(to right, ${wash}, transparent 60%)`,
                      borderLeft: `2px solid ${border}`,
                      paddingBottom: "8px",
                      paddingLeft: "12px",
                      paddingTop: "8px",
                    }}
                  >
                    <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>Alex Rivera</div>
                    <div style={{ color: "var(--muted-foreground)", fontSize: "0.75rem" }}>
                      instagram.com/alex · owner
                    </div>
                  </div>
                  <div
                    style={{
                      background: "linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 60%)",
                      borderLeft: `2px solid ${PROTOCOL_BLUE}`,
                      paddingBottom: "8px",
                      paddingLeft: "12px",
                      paddingTop: "8px",
                    }}
                  >
                    <div
                      style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
                    >
                      grt_8f3a2b1c · single_use · §4.2
                    </div>
                    <div
                      style={{
                        color: "var(--muted-foreground)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.6875rem",
                        opacity: 0.6,
                      }}
                    >
                      expires 24h · PDPP v0.1.0
                    </div>
                  </div>
                </div>
                <span
                  style={{
                    color: "var(--muted-foreground)",
                    flexShrink: 0,
                    fontSize: "0.75rem",
                    paddingTop: "10px",
                    width: "120px",
                  }}
                >
                  {name}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Test 3: Consent card — the most important surface */}
        <div>
          <div style={{ fontSize: "0.75rem", fontWeight: 600, marginBottom: "4px" }}>Test 3 — consent card</div>
          <div style={{ color: "var(--muted-foreground)", fontSize: "0.8125rem", marginBottom: "20px" }}>
            The primary blue Allow button on a warm-washed card. Does it feel trustworthy or confused?
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
            {CANDIDATES.map(({ name, border, wash, swatch }) => (
              <div key={name} style={{ width: "200px" }}>
                <div
                  style={{
                    backgroundColor: wash,
                    border: `1px solid ${border}`,
                    borderRadius: "8px",
                    marginBottom: "6px",
                    padding: "16px",
                  }}
                >
                  <div style={{ fontSize: "0.8125rem", fontWeight: 600, marginBottom: "2px" }}>Grant request</div>
                  <div
                    style={{
                      color: "var(--muted-foreground)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.625rem",
                      marginBottom: "8px",
                    }}
                  >
                    single_use · 24h
                  </div>
                  <div
                    style={{
                      color: "var(--muted-foreground)",
                      fontSize: "0.75rem",
                      lineHeight: 1.5,
                      marginBottom: "12px",
                    }}
                  >
                    Access to your Instagram social graph.
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      style={{
                        backgroundColor: PROTOCOL_BLUE,
                        border: "none",
                        borderRadius: "4px",
                        color: "white",
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        padding: "5px 12px",
                      }}
                      type="button"
                    >
                      Allow
                    </button>
                    <button
                      style={{
                        backgroundColor: "transparent",
                        border: "1px solid var(--border)",
                        borderRadius: "4px",
                        color: "var(--muted-foreground)",
                        fontSize: "0.75rem",
                        padding: "5px 12px",
                      }}
                      type="button"
                    >
                      Deny
                    </button>
                  </div>
                </div>
                <div style={{ alignItems: "center", display: "flex", gap: "6px" }}>
                  <div
                    style={{
                      backgroundColor: swatch,
                      borderRadius: "2px",
                      flexShrink: 0,
                      height: "10px",
                      width: "10px",
                    }}
                  />
                  <span style={{ color: "var(--muted-foreground)", fontSize: "0.6875rem" }}>{name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: "48px", paddingTop: "24px" }}>
          <p style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
            Protocol blue for reference:{" "}
            <span style={{ color: PROTOCOL_BLUE }}>oklch(0.580 0.172 253.7) · #187adc</span> &nbsp; Selected:{" "}
            <span style={{ color: "oklch(0.52 0.09 45)" }}>Copper — deep → --human</span>
          </p>
        </div>
      </div>
    </div>
  );
}
