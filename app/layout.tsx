import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CloudLabs Workshop Ops",
  description: "Instructor operations dashboard for a live CloudLabs workshop",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
