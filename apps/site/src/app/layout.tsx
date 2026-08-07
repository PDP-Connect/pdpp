// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { brandMono, brandSans, brandSerif } from "@pdpp/brand/fonts";
import { LAUNCH_COLORS } from "@pdpp/brand/launch-colors";
import type { Metadata } from "next";
import { SITE_DESCRIPTION, SITE_ORIGIN, SITE_TITLE } from "@/components/pdpp-concept/site-facts.ts";
import { SiteProviders } from "@/components/site/site-providers.tsx";
import { cn } from "@/lib/utils.ts";
import "@/styles/site.css";

export const metadata: Metadata = {
  description: SITE_DESCRIPTION,
  // A filled teal tile with the mark's first glyph knocked out in paper.
  // The wordmark is 365x160, so the whole thing renders as an unreadable
  // smudge at 16px; one glyph stays legible. The tile is solid rather than
  // transparent because a browser's tab strip may be dark or light and a
  // transparent mark is invisible on one of them. Verified by rendering at
  // 16px against both.
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
