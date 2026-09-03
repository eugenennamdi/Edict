import type { Metadata } from "next";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
