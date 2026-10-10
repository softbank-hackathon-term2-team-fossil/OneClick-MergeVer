import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // ssh2 ships a native addon that cannot be bundled; load it with Node's require at runtime.
  serverExternalPackages: ["ssh2"],
};

export default nextConfig;
