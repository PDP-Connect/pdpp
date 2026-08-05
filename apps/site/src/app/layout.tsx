// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LAUNCH_COLORS, launchFoucGuardCss } from "@pdpp/brand/launch-colors";
import type { Metadata } from "next";
import { IBM_Plex_Mono, Newsreader, Public_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { PdppRootProvider } from "@/components/pdpp-concept/search-hotkeys.tsx";
import { ThemeProvider } from "@/components/theme/theme-provider.tsx";
import { normalizeThemeChoice, THEME_KEY } from "@/components/theme/theme-state.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import "./globals.css";

// PDPP concept document register fonts (home, docs, reference, participate).
// See pdpp-concept.css — these CSS variables back --pdpp-concept-serif/sans/mono.
const pdppSerif = Newsreader({
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-pdpp-serif",
  weight: ["300", "400", "600"],
});
const pdppDocSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-pdpp-doc-sans",
  weight: ["400", "500", "600"],
});
const pdppDocMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-pdpp-doc-mono",
  weight: ["400", "500"],
});

const SITE_TITLE = "PDPP: Personal Data Portability Protocol";
const SITE_DESCRIPTION =
  "An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.";

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
  metadataBase: new URL("https://pdpp.dev"),
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Cookie-backed SSR theme: read the user's saved choice and emit the
  // matching `data-theme` (and `dark` class for explicit dark) on <html>.
  // For "system" we deliberately render no `dark` class — the brand CSS
  // resolves the OS preference at first paint via @media (prefers-color-scheme: dark)
  // (see packages/pdpp-brand/base.css around line 143). This is the only
  // honest first paint without an inline script: the server cannot know
  // the OS preference, but CSS can.
  const cookieStore = await cookies();
  const choice = normalizeThemeChoice(cookieStore.get(THEME_KEY)?.value);
  // For "dark" we add the `dark` class so Tailwind/shadcn dark variants apply
  // immediately. For "light" and "system" we omit the class entirely; CSS
  // resolves "system" via @media (prefers-color-scheme: dark).
  const htmlClassName = choice === "dark" ? "dark" : undefined;

  return (
    <html
      className={`${htmlClassName ?? ""} ${pdppSerif.variable} ${pdppDocSans.variable} ${pdppDocMono.variable}`.trim()}
      data-theme={choice}
      lang="en"
    >
      <head>
        {/* Anti-FOUC first-paint guard. This blocking inline <style> sets the
            html background to the right color BEFORE the external brand CSS
            loads, for every theme path (explicit dark/light, and system via
            prefers-color-scheme). Mirrors base.css resolution so the
            token-driven value takes over seamlessly once CSS loads. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, app-authored CSS from launch-colors.ts (no user input) — the only way to emit a raw blocking <style> into <head>. */}
        <style dangerouslySetInnerHTML={{ __html: launchFoucGuardCss() }} />
      </head>
      <body>
        <ThemeProvider>
          <PdppRootProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </PdppRootProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
