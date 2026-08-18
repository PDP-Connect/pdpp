// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { brandMono, brandSans, brandSerif } from "@pdpp/brand/fonts";
import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import type { Metadata } from "next";
import { SiteProviders } from "@/components/providers/site-providers.tsx";
import { SITE_DESCRIPTION, SITE_ORIGIN, SITE_TITLE } from "@/lib/site-facts.ts";
import { cn } from "@/lib/utils.ts";
import "@/styles/site.css";

export const metadata: Metadata = {
  description: SITE_DESCRIPTION,
  // The production split-P mark (matches apple-icon.tsx / opengraph-image.tsx)
  // on a solid LAUNCH_COLORS.light plate, not a transparent bare glyph. No
  // single flat glyph color clears 3:1 contrast against both light and dark
  // browser tab chrome at once — a plate makes glyph-vs-background contrast
  // fixed and independent of tab chrome instead. Verified by rendering at
  // 16/32/48px against Chrome/Brave/Safari/Firefox light and dark tab colors.
  icons: {
    icon: [{ type: "image/svg+xml", url: "/brand/pdpp-favicon.svg" }],
  },
  metadataBase: new URL(SITE_ORIGIN),
  openGraph: {
    description: SITE_DESCRIPTION,
    title: SITE_TITLE,
    type: "website",
  },
  title: SITE_TITLE,
  twitter: {
    card: "summary_large_image",
    description: "An authorization and disclosure protocol for personal data.",
    title: SITE_TITLE,
  },
};

export const viewport = {
  initialScale: 1,
  // Theme-following chrome color, sourced from LAUNCH_COLORS (the single source
  // of truth derived from the `--background` tokens). The browser picks the
  // entry matching the OS scheme, so the chrome never flashes the wrong color.
  themeColor: [
    { color: LAUNCH_COLORS.dark, media: "(prefers-color-scheme: dark)" },
    { color: LAUNCH_COLORS.light, media: "(prefers-color-scheme: light)" },
  ],
  width: "device-width",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      className={cn(brandSans.variable, brandMono.variable, brandSerif.variable)}
      lang="en"
      suppressHydrationWarning
    >
      <body>
        <SiteProviders>{children}</SiteProviders>
      </body>
    </html>
  );
}
