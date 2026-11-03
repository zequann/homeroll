import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source (no build step), so Next compiles them.
  transpilePackages: ["@homeroll/shared", "@homeroll/fixtures"],
};

export default config;
