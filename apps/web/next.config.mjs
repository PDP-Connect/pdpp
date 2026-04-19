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
