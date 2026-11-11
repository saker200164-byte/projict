import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // حزم بِنية native — لا تُدمجها في الـ bundle، عاملها كـ external
  serverExternalPackages: [
    "ffmpeg-static",
    "ffprobe-static",
    "@libsql/client",
    "@modelcontextprotocol/sdk",
  ],
  // في إنتاج Vercel serverless نعتمد على تثبيت الحزم بشكل طبيعي
  experimental: {
    // اسمح بقراءة الحزم الخارجية من node_modules
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
