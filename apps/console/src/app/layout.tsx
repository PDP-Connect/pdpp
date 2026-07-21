// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LAUNCH_COLORS, launchFoucGuardCss } from "@pdpp/brand/launch-colors";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { cookies } from "next/headers";
import DensityProvider from "@/components/density/density-provider.tsx";
import { DENSITY_KEY, normalizeDensity } from "@/components/density/density-state.ts";
import { ThemeProvider } from "@/components/theme/theme-provider.tsx";
import { normalizeThemeChoice, THEME_KEY } from "@/components/theme/theme-state.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import "./globals.css";

// Ink Carbon human voice: Schibsted Grotesk. Loaded via next/font/google
// for optimal preloading and self-hosting. Variable font with full weight
// range and italic support. The CSS variable --ink-carbon-sans is injected
// on <html> and @pdpp/brand/ink-carbon.css picks it up via --font-sans override.
const schibstedGrotesk = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  variable: "--ink-carbon-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PDPP — Personal Data Portability Protocol",
  description:
    "An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.",
  metadataBase: new URL("https://pdpp.dev"),
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/brand/pdpp-favicon.svg", type: "image/svg+xml" },
    ],
  },
  // iOS home-screen launch. statusBarStyle "default" lets iOS pick the bar
  // treatment per system appearance (light bar on light, dark bar on dark)
  // instead of forcing one — so the launch reads correctly under both themes,
  // matching the theme-following first-paint guard below. The apple-icon.tsx
  // file convention supplies the touch icon itself.
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "PDPP",
  },
  openGraph: {
    title: "PDPP — Personal Data Portability Protocol",
    description:
      "An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PDPP — Personal Data Portability Protocol",
    description: "An authorization and disclosure protocol for personal data.",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  // Theme-following chrome color: the browser/PWA picks the entry matching the
  // OS scheme, so the splash/chrome never flashes the wrong color before the
  // app paints. Both colors are sourced from LAUNCH_COLORS (the single source
  // of truth derived from the `--background` tokens) — no drifting hex here.
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: LAUNCH_COLORS.dark },
    { media: "(prefers-color-scheme: light)", color: LAUNCH_COLORS.light },
  ],
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
  const density = normalizeDensity(cookieStore.get(DENSITY_KEY)?.value);
  // For "dark" we add the `dark` class so Tailwind/shadcn dark variants apply
  // immediately. For "light" and "system" we omit the class entirely; CSS
  // resolves "system" via @media (prefers-color-scheme: dark).
  const htmlClassName = choice === "dark" ? "dark" : undefined;

  return (
    <html
      className={[schibstedGrotesk.variable, htmlClassName].filter(Boolean).join(" ")}
      data-density={density}
      data-theme={choice}
      lang="en"
    >
      <head>
        {/* Anti-FOUC first-paint guard. This blocking inline <style> sets the
            html background to the right color BEFORE the external brand CSS
            loads, for every theme path (explicit dark/light, and system via
            prefers-color-scheme). The SSR-emitted data-theme above makes the
            cookie-known theme correct immediately; the @media rule handles the
            "system" case the server can't know. Mirrors base.css resolution so
            the token-driven value takes over seamlessly once CSS loads. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, app-authored CSS from launch-colors.ts (no user input) — the only way to emit a raw blocking <style> into <head>. */}
        <style dangerouslySetInnerHTML={{ __html: launchFoucGuardCss() }} />
      </head>
      <body>
        <ThemeProvider>
          <DensityProvider initialDensity={density}>
            <RootProvider theme={{ enabled: false }}>
              <TooltipProvider>{children}</TooltipProvider>
            </RootProvider>
          </DensityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
