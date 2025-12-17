import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ['@qc/qc-engine', '@qc/shared']
};

export default nextConfig;
