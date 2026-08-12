import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lovvit Archive",
  description: "Lovvit Archive - Rabbit AI assistant",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Rabbit",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a14",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        {/* Suppress Next.js 15 development warnings */}
        {process.env.NODE_ENV === 'development' && (
          <script src="/suppress-warnings.js" />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
