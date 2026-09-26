/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // src/instrumentation.ts — boots the Pause Campaigns resume scheduler at
    // server start, so a scheduled resume fires even if nobody opens the app.
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
