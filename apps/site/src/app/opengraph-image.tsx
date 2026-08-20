// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ImageResponse } from "next/og";

export const alt =
  "PDPP — Personal Data Portability Protocol. Clients request named records and fields; every response stays inside the grant.";
export const size = { height: 630, width: 1200 };
export const contentType = "image/png";

// Social card for the public site. Reused as both the Open Graph and Twitter
// `summary_large_image` image via the metadata file convention. next/og renders
// via satori, which doesn't support oklch(), so colors are expressed as hex.
// The card states the protocol's core promise in one frame: eight fields enter,
// four come back — the "one screenshot" of field projection.
const DEEP_BLUE = "#1d4f8f";
const WHITE = "#ffffff";
const PAPER = "#f8f6f0";
const INK = "#1a1714";
const MUTED = "#6f655a";

function Chip({ label, color, struck }: { label: string; color: string; struck?: boolean }) {
  return (
    <div
      style={{
        background: struck ? "rgba(111,101,90,0.10)" : "rgba(29,79,143,0.12)",
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
          "radial-gradient(circle at 12% 16%, rgba(160,85,51,0.10), transparent 38%), radial-gradient(circle at 90% 6%, rgba(29,79,143,0.12), transparent 36%)",
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
        <svg aria-label="PDPP single P mark" height="56" role="img" viewBox="0 0 56 56" width="56">
          <rect fill={DEEP_BLUE} height="56" rx="13.15" width="56" />
          <g transform="translate(15.46 -1.61) scale(0.3178)">
            <path
              d="M60 30C65.3043 30 70.3919 32.1067 74.1426 35.8574C77.8933 39.6081 80 44.6957 80 50V110C80 115.304 77.8933 120.392 74.1426 124.143C70.3919 127.893 65.3043 130 60 130H20V160H0V30H60ZM20 50V110H60V50H20Z"
              fill={WHITE}
            />
          </g>
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
          <Chip color={DEEP_BLUE} label="employer" />
          <Chip color={DEEP_BLUE} label="pay_period" />
          <Chip color={MUTED} label="home_address" struck />
          <Chip color={MUTED} label="tax_id" struck />
        </div>
        <div style={{ color: DEEP_BLUE, display: "flex", fontSize: 28 }}>→ 4 returned</div>
      </div>
    </div>,
    { ...size }
  );
}
