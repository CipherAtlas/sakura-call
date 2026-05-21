import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const cloudflareHostname = process.env.CLOUDFLARE_HOSTNAME;

const nextConfig: NextConfig = {
  allowedDevOrigins: cloudflareHostname ? [cloudflareHostname] : [],
  outputFileTracingRoot: appDirectory,
  reactStrictMode: true
};

export default nextConfig;
