import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Cache Components (on in the create-next-app template) stays off on purpose, and explicitly so
  // that a future framework default cannot re-enable it.
  // Every back-office and booking read is tenant-scoped, and request-independent caching is a
  // cross-tenant leak risk. Caching for public pages is decided per route in a later phase.
  // See docs/adr/ADR-001-stack.md.
  cacheComponents: false,
};

export default nextConfig;
