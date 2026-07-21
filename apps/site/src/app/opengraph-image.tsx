// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ImageResponse } from "next/og";

export const alt =
  "PDPP — Personal Data Portability Protocol. Clients request named records and fields; every response stays inside the grant.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Social card for the public site. Reused as both the Open Graph and Twitter
// `summary_large_image` image via the metadata file convention. next/og renders
// via satori, which doesn't support oklch(), so the brand tokens are converted
// to sRGB hex (same conversions as apple-icon.tsx):
//   oklch(0.52 0.11 45)    → #a05533  (human / copper)
//   oklch(0.58 0.18 253)   → #2c73d9  (protocol / blue)
//   oklch(0.985 0.005 85)  → #fbfaf5  (counter / paper)
//   oklch(0.98 0.008 75)   → #f8f6f0  (stage / paper-warm)
// The card states the protocol's core promise in one frame: eight fields enter,
// four come back — the "one screenshot" of field projection.
const COPPER = "#a05533";
const BLUE = "#2c73d9";
const PAPER = "#f8f6f0";
const PAPER_LIGHT = "#fbfaf5";
const INK = "#1a1714";
const MUTED = "#6f655a";

function Chip({ label, color, struck }: { label: string; color: string; struck?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        padding: "8px 16px",
        borderRadius: 10,
        fontFamily: "monospace",
        fontSize: 24,
        color,
        background: struck ? "rgba(111,101,90,0.10)" : "rgba(44,115,217,0.12)",
        textDecoration: struck ? "line-through" : "none",
        opacity: struck ? 0.55 : 1,
      }}
    >
      {label}
    </div>
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: PAPER,
        backgroundImage:
          "radial-gradient(circle at 12% 16%, rgba(160,85,51,0.10), transparent 38%), radial-gradient(circle at 90% 6%, rgba(44,115,217,0.12), transparent 36%)",
      }}
    >
      {/* Wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg aria-label="PDPP split P mark" height="56" role="img" viewBox="0 0 200 200" width="56">
          <path d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z" fill={COPPER} />
          <path
            d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z"
            fill={BLUE}
          />
          <circle cx="105" cy="73" fill={PAPER_LIGHT} r="18" />
        </svg>
        <div style={{ display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: -0.5, color: INK }}>PDPP</div>
        <div style={{ display: "flex", fontFamily: "monospace", fontSize: 22, color: MUTED }}>
          v0.1.0 · Open reference
        </div>
      </div>

      {/* Headline */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          style={{ display: "flex", fontSize: 76, fontWeight: 700, letterSpacing: -2.5, lineHeight: 1.04, color: INK }}
        >
          Granular access to personal data
        </div>
        <div style={{ display: "flex", fontSize: 30, color: MUTED, maxWidth: 880 }}>
          Clients request named records and fields. Every response stays inside the grant.
        </div>
      </div>

      {/* Field-projection promise — eight fields enter, four come back */}
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", fontFamily: "monospace", fontSize: 22, color: MUTED }}>8 fields</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Chip color={BLUE} label="employer" />
          <Chip color={BLUE} label="pay_period" />
          <Chip color={MUTED} label="home_address" struck />
          <Chip color={MUTED} label="tax_id" struck />
        </div>
        <div style={{ display: "flex", fontSize: 28, color: BLUE }}>→ 4 returned</div>
      </div>
    </div>,
    { ...size }
  );
}
