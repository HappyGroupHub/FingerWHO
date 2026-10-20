import type { NextConfig } from "next";

// `npm run build:cf` exports plain files for Cloudflare; `server.ts` serves the normal build.
// Export mode can't prerender partially, so it turns those features off.
const staticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(staticExport && { output: "export" as const }),
  cacheComponents: !staticExport,
  partialPrefetching: !staticExport,
  // Phones open the dev server by its LAN address or through an ngrok tunnel.
  allowedDevOrigins: [
    "192.168.*.*",
    "10.*.*.*",
    "172.*.*.*",
    "*.ngrok-free.app",
    "*.ngrok-free.dev",
    "*.ngrok.app",
    "*.ngrok.io",
  ],
};

export default nextConfig;
