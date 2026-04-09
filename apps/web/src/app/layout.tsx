import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
  title: 'PDPP — Personal Data Portability Protocol',
  description: 'An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.',
  metadataBase: new URL('https://pdpp.vana.org'),
  openGraph: {
    title: 'PDPP — Personal Data Portability Protocol',
    description: 'An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PDPP — Personal Data Portability Protocol',
    description: 'An authorization and disclosure protocol for personal data.',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider theme={{ enabled: false }}>
          <TooltipProvider>{children}</TooltipProvider>
        </RootProvider>
      </body>
    </html>
  );
}
