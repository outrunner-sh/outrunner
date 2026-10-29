import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

import { FileDropGuard } from "@/components/file-drop-guard";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Geist Pixel (Square): the display face the landing page sets its accent
// words in (neevai-labs/outrunner-landing), here for the wordmark.
const geistPixel = localFont({
  src: "../public/fonts/GeistPixel_Square.woff2",
  variable: "--font-pixel",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Outrunner",
  description: "Cloud sessions for Claude Code, Codex and open models.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${geistPixel.variable} font-sans min-h-screen antialiased`}
      >
        {/* Dark only: the product is designed dark (the landing page and every
            surface here), and the session screen has no light palette. A
            theme chosen earlier in Settings no longer applies. */}
        <ThemeProvider attribute="class" forcedTheme="dark" disableTransitionOnChange>
          <FileDropGuard />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
