import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// Wide grotesque for display, mono for everything that is data. Deliberately
// not Inter or JetBrains Mono -- those are the house faces on the other
// projects, and this one gets its own voice.
// Variable weight and width. next/font rejects an explicit weight list when
// axes are requested, so both stay variable and CSS drives them.
const display = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-display",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Zone History",
  description:
    "Fourteen years of territory control across 1.6 million zones — scrub any date, compare any period.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable} ${sans.variable}`}>{children}</body>
    </html>
  );
}
