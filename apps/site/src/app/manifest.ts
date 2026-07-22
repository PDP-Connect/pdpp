// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // Honest LIGHT first-paint color from LAUNCH_COLORS (the `:root --background`
    // token). Was a drifting #f8f6f0 that didn't match the computed token
    // (#fcfcfa); browsers override the splash to dark on a dark OS via CSS.
    background_color: LAUNCH_COLORS.light,
    description:
      "Personal Data Polyfill Project — protocol docs, the reference-implementation explainer, and a mock-backed sandbox.",
    display: "standalone",
    // Only the App Router-generated /icon.svg (from src/app/icon.svg) is a real
    // asset on the public site. The previous PNG entries pointed at
    // public/*.png files that do not exist and are excluded by the root
    // `*.png` gitignore rule. The Apple touch icon is emitted separately by
    // src/app/apple-icon.tsx via Next's metadata file convention and does not
    // belong in the manifest icon list.
    icons: [
      {
        purpose: "any",
        sizes: "any",
        src: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
    name: "PDPP",
    scope: "/",
    short_name: "PDPP",
    start_url: "/",
    theme_color: LAUNCH_COLORS.light,
  };
}
