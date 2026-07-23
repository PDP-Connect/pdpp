// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import type { MetadataRoute } from "next";

// background_color/theme_color use the HONEST LIGHT first-paint color (the
// `:root --background` token). The console defaults to the system theme, so
// hardcoding dark here gives a light-OS user a wrong dark splash. Browsers
// override the splash to dark on a dark OS via the CSS @media rule, so light is
// the correct pre-CSS placeholder. Sourced from LAUNCH_COLORS (single source of
// truth) — manifests cannot carry oklch() or CSS vars, hence the imported hex.
export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: LAUNCH_COLORS.light,
    description: "Owner console for your PDPP reference instance — connections, runs, grants, and the record explorer.",
    display: "standalone",
    icons: [
      {
        purpose: "any",
        sizes: "any",
        src: "/brand/pdpp-favicon.svg",
        type: "image/svg+xml",
      },
    ],
    name: "PDPP Owner Console",
    scope: "/",
    short_name: "PDPP",
    start_url: "/",
    theme_color: LAUNCH_COLORS.light,
  };
}
