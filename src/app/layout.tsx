import type { Metadata } from "next";
import { AppWalletProviders } from "@/components/wallet";
import { Toaster } from "@/components/ui/sonner";
import "./tokens.css";
import "./globals.css";
import "./workspace.css";

export const metadata: Metadata = {
  title: "Edict — Tokenization, as code",
  description: "Deterministic orchestration and verification layer over Brickken sandbox API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AppWalletProviders>
          {children}
          <Toaster position="bottom-right" richColors />
        </AppWalletProviders>
      </body>
    </html>
  );
}

