import type { NextConfig } from 'next';

const supabase = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const supabaseWs = supabase.replace(/^http/, 'ws');
const isDev = process.env.NODE_ENV !== 'production';

// The UI uses inline styles (ported 1:1 from the design) and Next.js inline bootstrap scripts.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabase}`,
  `media-src 'self' blob: ${supabase}`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabase} ${supabaseWs}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets the route-test server build into its own folder alongside a running dev server.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Load the Coinbase CDP SDK from node_modules at runtime instead of bundling it
  // (its optional x402 payment modules are dynamic imports we don't install).
  serverExternalPackages: ['@coinbase/cdp-sdk'],
  poweredByHeader: false,
  images: { unoptimized: true },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
        ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]),
      ],
    }];
  },
};

export default nextConfig;
