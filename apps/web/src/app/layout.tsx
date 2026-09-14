import type { Metadata } from 'next';
import { Barlow_Condensed } from 'next/font/google';
import './globals.css';

// Barlow Condensed has no variable axis, so weights are enumerated. Only the
// three actually used are requested: 500 for table headers and eyebrows, 600
// for section headings, 700 for the wordmark and team abbreviations.
const condensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-condensed',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'mlb-edge — model readout',
  description: 'Calibration and closing-line value for the prop model.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={condensed.variable}>
      <body>{children}</body>
    </html>
  );
}
