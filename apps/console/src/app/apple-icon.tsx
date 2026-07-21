// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Apple touch icon for the iOS home screen — the console's two-rectangle PDPP
// mark (matching src/app/icon.svg) on the LIGHT launch background. Without this
// file iOS defaults the home-screen icon background to white.
//
// next/og renders via satori, which can't read oklch() or CSS vars, so the
// glyph colors are the design's sRGB tokens and the plate background is sourced
// from LAUNCH_COLORS.light (the single source of truth):
//   oklch(0.52 0.11 45)   → #a05533  (human / copper)
//   oklch(0.58 0.18 253)  → #2c73d9  (protocol / blue)
//   oklch(0.985 0.005 85) → #fbfaf5  (counter / paper)
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: LAUNCH_COLORS.light,
      }}
    >
      <svg aria-label="PDPP mark" height="120" role="img" viewBox="0 0 32 32" width="120">
        <rect fill="#a05533" height="22" rx="2" width="10" x="5" y="5" />
        <rect fill="#2c73d9" height="22" rx="2" width="12" x="15" y="5" />
        <circle cx="18" cy="12" fill="#fbfaf5" r="3" />
      </svg>
    </div>,
    { ...size }
  );
}
