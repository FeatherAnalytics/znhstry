import type { NextConfig } from "next";

// Static export for GitHub Pages. basePath is only set in CI, never for local
// dev, so `npm run dev` serves from the root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
