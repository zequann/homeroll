import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Motion } from "@/components/Motion";
import { Toolbar } from "@/components/Toolbar";
import { getEnv } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Homeroll",
  description:
    "Invoice advances for Malaysian SMEs, guarded payroll for foreign workers, and cheaper money sent home.",
};

// Reset demo creates a whole company on testnet and can run past a minute. Vercel Hobby with
// Fluid compute allows up to 300 seconds; server actions take this from the page they run on.
export const maxDuration = 300;

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F4F5F4" };

export default function RootLayout({ children }: { children: ReactNode }) {
  const modeLabel =
    getEnv().chainClient === "near" ? "Demo mode · testnet" : "Demo mode · fake chain";
  return (
    <html lang="en">
      <body>
        <Motion>
          <Toolbar modeLabel={modeLabel} />
          {children}
        </Motion>
      </body>
    </html>
  );
}
