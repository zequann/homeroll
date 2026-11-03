import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Motion } from "@/components/Motion";
import { Toolbar } from "@/components/Toolbar";
import { WalletProvider } from "@/components/WalletProvider";
import { getEnv } from "@/lib/env";
import { demoAccounts, readSession } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Homeroll",
  description:
    "Invoice advances for Malaysian SMEs, guarded payroll for foreign workers, and cheaper money sent home.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F4F5F4" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const connected = await readSession();
  const modeLabel =
    getEnv().chainClient === "near" ? "Demo mode · testnet" : "Demo mode · fake chain";
  return (
    <html lang="en">
      <body>
        <Motion>
          <WalletProvider accounts={demoAccounts()} connected={connected}>
            <Toolbar modeLabel={modeLabel} />
            {children}
          </WalletProvider>
        </Motion>
      </body>
    </html>
  );
}
