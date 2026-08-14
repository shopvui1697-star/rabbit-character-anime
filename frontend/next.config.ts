import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, "../"),
  
  // Suppress Next.js 15 dynamic API warnings
  // These are false positives from Next.js internals
  // Our code uses "use client" so doesn't trigger these
  logging: {
    fetches: {
      fullUrl: false,
    },
  },

  // Custom headers for Brotli dictionary files (kuroshiro-browser)
  async headers() {
    return [
      {
        source: "/dict/:path*",
        headers: [
          {
            key: "Content-Type",
            value: "application/octet-stream",
          },
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // onnxruntime-web wasm runtime + Silero VAD ONNX model (see
        // sileroVadClient.ts) — versioned static assets, safe to cache hard.
        // (.wasm already gets the correct application/wasm Content-Type from
        // Next's static file serving by default — no override needed here.)
        source: "/ort/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/models/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
