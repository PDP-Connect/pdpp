// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import { ImageResponse } from "next/og";

export const size = { height: 180, width: 180 };
export const contentType = "image/png";

// Apple touch icon — the full split-P on the LIGHT launch background.
// Geometry matches plate I.1 from identity/logo_study.html. The plate
// background is sourced from LAUNCH_COLORS.light (single source of truth, the
// `:root --background` token) so it matches the first-paint surface — was a
// drifting #f8f6f0. next/og renders via satori, which doesn't support oklch();
// the glyph sRGB hex values below are the design's brand-mark oklch tokens:
//   oklch(0.52 0.11 45)    → #a05533  (human / copper)
//   oklch(0.58 0.18 253)   → #2c73d9  (protocol / blue)
//   oklch(0.985 0.005 85)  → #fbfaf5  (counter / paper)
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: LAUNCH_COLORS.light,
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <svg aria-label="PDPP split P mark" height="140" role="img" viewBox="0 0 200 200" width="140">
        <path d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z" fill="#a05533" />
        <path
          d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z"
          fill="#2c73d9"
        />
        <circle cx="105" cy="73" fill="#fbfaf5" r="18" />
      </svg>
    </div>,
    { ...size }
  );
}
