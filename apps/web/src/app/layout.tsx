import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme/theme-provider.tsx";
import { ThemeScript } from "@/components/theme/theme-script.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDPP — Personal Data Portability Protocol",
  description:
    "An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.",
  metadataBase: new URL("https://pdpp.vana.org"),
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
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
