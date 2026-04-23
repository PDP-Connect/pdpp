import { createMDX } from 'fumadocs-mdx/next';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/spec-core',
        destination: '/docs/spec-core',
        permanent: true,
      },
      {
        source: '/spec-collection-profile',
        destination: '/docs/spec-collection-profile',
        permanent: true,
      },
      {
        source: '/spec-architecture',
        destination: '/docs/spec-architecture',
        permanent: true,
      },
      {
        source: '/spec-auth-design',
        destination: '/docs/spec-auth-design',
        permanent: true,
      },
      {
        source: '/spec-change-tracking',
        destination: '/docs/spec-change-tracking',
        permanent: true,
      },
      {
        source: '/spec-connector-ecosystem',
        destination: '/docs/spec-connector-ecosystem',
        permanent: true,
      },
      {
        source: '/spec-data-query-api',
        destination: '/docs/spec-data-query-api',
        permanent: true,
      },
      {
        source: '/spec-deferred',
        destination: '/docs/spec-deferred',
        permanent: true,
      },
      {
        source: '/spec-dti-alignment',
        destination: '/docs/spec-dti-alignment',
        permanent: true,
      },
      {
        source: '/spec-e2e-examples',
        destination: '/docs/reference-implementation-examples',
        permanent: true,
      },
      {
        source: '/spec-reference-implementation-examples',
        destination: '/docs/reference-implementation-examples',
        permanent: true,
      },
      {
        source: '/e2e',
        destination: '/docs/reference-implementation',
        permanent: true,
      },
      {
        source: '/e2e/:path*',
        destination: '/docs/reference-implementation',
        permanent: true,
      },
      {
        source: '/reference-implementation',
        destination: '/docs/reference-implementation',
        permanent: true,
      },
      {
        source: '/openspec',
        destination: '/planning',
        permanent: false,
      },
      {
        source: '/openspec/:path*',
        destination: '/planning/:path*',
        permanent: false,
      },
      // Dashboard IA migration: connector browsing lives under /dashboard/records/
      // and the standalone /dashboard/timeline route is now /dashboard/records/timeline.
      {
        source: '/dashboard/data',
        destination: '/dashboard/records',
        permanent: false,
      },
      {
        source: '/dashboard/data/:rest*',
        destination: '/dashboard/records/:rest*',
        permanent: false,
      },
      {
        source: '/dashboard/timeline',
        destination: '/dashboard/records/timeline',
        permanent: false,
      },
      {
        source: '/dashboard/timeline/:rest*',
        destination: '/dashboard/records/timeline/:rest*',
        permanent: false,
      },
      // Bare connector-style paths from the pre-v1 dashboard map to Records.
      // Excludes reserved top-level sections so they don't get caught.
      {
        source:
          '/dashboard/:connector((?!traces|grants|runs|records|data|search|timeline|components|lib)[^/]+)/:rest*',
        destination: '/dashboard/records/:connector/:rest*',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/docs.mdx',
        destination: '/llms.mdx/docs',
      },
      {
        source: '/docs/:path*.mdx',
        destination: '/llms.mdx/docs/:path*',
      },
      {
        source: '/planning',
        destination: '/openspec',
      },
      {
        source: '/planning/:path*',
        destination: '/openspec/:path*',
      },
    ];
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.join(__dirname, 'src'),
    };
    return config;
  },
};

export default withMDX(nextConfig);
