// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ImageResponse } from "next/og";

export const size = { height: 180, width: 180 };
export const contentType = "image/png";

// Apple touch icon — the single-P mark on a deep blue plate.
// Glyph is centred and scaled to preserve counter visibility.
// next/og renders via satori, which doesn't support oklch(),
// so the plate color is expressed as hex: #1d4f8f (deep blue).
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#1d4f8f",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <svg aria-label="PDPP single P mark" height="180" role="img" viewBox="0 0 180 180" width="180">
        <g transform="translate(49.38 -6.47) scale(1.0154)">
          <path
            d="M60 30C65.3043 30 70.3919 32.1067 74.1426 35.8574C77.8933 39.6081 80 44.6957 80 50V110C80 115.304 77.8933 120.392 74.1426 124.143C70.3919 127.893 65.3043 130 60 130H20V160H0V30H60ZM20 50V110H60V50H20Z"
            fill="white"
          />
        </g>
      </svg>
    </div>,
    { ...size }
  );
}
