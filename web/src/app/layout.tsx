import type { Metadata } from 'next';
import { Cormorant_Garamond, Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Approved design-system pairing (proposals-v3): Cormorant Garamond carries the verdict's
// gravitas (serif display, with italic accents), Space Grotesk is the body voice, JetBrains
// Mono is the forensic on-the-record data line. Exposed as the CSS vars globals.css expects.
const display = Cormorant_Garamond({
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});
const body = Space_Grotesk({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});
const data = JetBrains_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-data',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Verdikt · Verified settlement for the agent economy',
  description:
    'Pay any agent for work, safely. USDC escrows on Arc release only on verified work, or the money comes back with cited evidence, then pay out to the seller’s home chain via CCTP. No human on the money path.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${data.variable}`}>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
