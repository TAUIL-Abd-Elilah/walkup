import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "./globals.css";
import { SampleStrip } from "@/components/SampleStrip";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { runtimeMode } from "@/lib/mode";

export const metadata: Metadata = {
  title: { default: "Walkup · Fill the room, not the feed.", template: "%s · Walkup" },
  description:
    "For one booked show with seats left: the areas where this bill's crowd stands out from the room's usual crowd, the local places that crowd already likes, and a one-page sheet for your street team.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#141414" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The mode is read per request: the image is built without secrets, and a rejected key switches it at runtime.
  await connection();
  const mode = runtimeMode();
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <a href="#main" className="skip-link no-print">
          Skip to content
        </a>
        {mode.kind === "fixture" ? <SampleStrip mode={mode} /> : null}
        <SiteHeader mode={mode} />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
