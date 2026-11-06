import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Legwork',
  description: 'An AI agent that phones local shops for you, while PayPal holds and moves the money.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>
              L
            </span>
            Legwork
          </Link>
          <span className="sandbox">PayPal sandbox</span>
          <nav>
            <Link href="/">New errand</Link>
            <Link href="/shops">Shops</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
