// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ImageResponse } from "next/og";

export const alt =
  "PDPP — Personal Data Portability Protocol. Clients request named records and fields; every response stays inside the grant.";
export const size = { height: 630, width: 1200 };
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
        background: struck ? "rgba(111,101,90,0.10)" : "rgba(44,115,217,0.12)",
        borderRadius: 10,
        color,
        display: "flex",
        fontFamily: "monospace",
        fontSize: 24,
        opacity: struck ? 0.55 : 1,
        padding: "8px 16px",
        textDecoration: struck ? "line-through" : "none",
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
        background: PAPER,
        backgroundImage:
          "radial-gradient(circle at 12% 16%, rgba(160,85,51,0.10), transparent 38%), radial-gradient(circle at 90% 6%, rgba(44,115,217,0.12), transparent 36%)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: 72,
        width: "100%",
      }}
    >
      {/* Wordmark */}
      <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
        <svg aria-label="PDPP split P mark" height="56" role="img" viewBox="0 0 200 200" width="56">
          <path d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z" fill={COPPER} />
          <path
            d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z"
            fill={BLUE}
          />
          <circle cx="105" cy="73" fill={PAPER_LIGHT} r="18" />
        </svg>
        <div style={{ color: INK, display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>PDPP</div>
        <div style={{ color: MUTED, display: "flex", fontFamily: "monospace", fontSize: 22 }}>
          v0.1.0 · Open reference
        </div>
      </div>

      {/* Headline */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          style={{ color: INK, display: "flex", fontSize: 76, fontWeight: 700, letterSpacing: -2.5, lineHeight: 1.04 }}
        >
          Granular access to personal data
        </div>
        <div style={{ color: MUTED, display: "flex", fontSize: 30, maxWidth: 880 }}>
          Clients request named records and fields. Every response stays inside the grant.
        </div>
      </div>

      {/* Field-projection promise — eight fields enter, four come back */}
      <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 18 }}>
        <div style={{ color: MUTED, display: "flex", fontFamily: "monospace", fontSize: 22 }}>8 fields</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Chip color={BLUE} label="employer" />
          <Chip color={BLUE} label="pay_period" />
          <Chip color={MUTED} label="home_address" struck />
          <Chip color={MUTED} label="tax_id" struck />
        </div>
        <div style={{ color: BLUE, display: "flex", fontSize: 28 }}>→ 4 returned</div>
      </div>
    </div>,
    { ...size }
  );
}
