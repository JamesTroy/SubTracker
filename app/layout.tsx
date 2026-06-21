import "./globals.css";
import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Inter } from "next/font/google";

// Self-hosted at build time (zero CLS, no render-blocking Google Fonts request).
// Exposed as CSS variables consumed by globals.css (--serif / --mono / --body).
const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Ledger — subscription tracker",
  description: "What you actually pay every month.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} ${body.variable}`}>
      <body>
        <div className="aurora" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
