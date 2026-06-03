import type { Metadata } from "next";
import { AuthGate } from "@/components/trader/auth-gate";
import { SnapshotProvider } from "@/components/trader/snapshot-provider";
import { ThemeProvider } from "@/components/trader/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Adaptive High Low Grid Trader",
  description: "Live MT5 adaptive high/low grid recovery trading system"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          <AuthGate>
            <SnapshotProvider>{children}</SnapshotProvider>
          </AuthGate>
        </ThemeProvider>
      </body>
    </html>
  );
}
