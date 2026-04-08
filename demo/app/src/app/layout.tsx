import type { Metadata } from 'next';
import { JetBrains_Mono, Geist } from 'next/font/google';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PDPP — Personal Data Portability Protocol',
  description: 'Reference implementation of the PDPP consent and grant enforcement flow',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${jetbrainsMono.variable}`}>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
