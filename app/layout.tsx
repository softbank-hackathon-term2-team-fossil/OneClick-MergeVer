import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SBSB — Push code, get an image",
  description: "Turn a GitHub repository into a portable container image.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
