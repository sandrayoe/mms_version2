import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure Turbopack uses this directory as the workspace root.
  // This prevents Turbopack from inferring a root higher up the filesystem
  // when multiple lockfiles exist in the repository and avoids build flakiness on Vercel.
  turbopack: {
    root: ".",
  },
};

export default nextConfig;
