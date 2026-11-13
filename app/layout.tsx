import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Receipt → CSV | AI receipt data extraction",
  description:
    "Drop in receipt photos or PDFs and get a clean, accountant-ready CSV. Every field is reviewable before export.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
