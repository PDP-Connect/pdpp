import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { cookies } from "next/headers";
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
  metadataBase: new URL("https://pdpp.vana.org"),
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/brand/pdpp-favicon.svg", type: "image/svg+xml" },
    ],
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
      className={[schibstedGrotesk.variable, htmlClassName].filter(Boolean).join(" ")}
      data-theme={choice}
      lang="en"
    >
      <body>
        <ThemeProvider>
          <RootProvider theme={{ enabled: false }}>
            <TooltipProvider>{children}</TooltipProvider>
          </RootProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
