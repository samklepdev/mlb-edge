import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'mlb-edge — model readout',
  description: 'Calibration and closing-line value for the prop model.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
