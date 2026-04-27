import { createMDX } from 'fumadocs-mdx/next';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectAllowedDevOrigins } from './scripts/dev-origins.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const withMDX = createMDX();

const allowedDevOrigins = process.env.NODE_ENV === 'production' ? [] : collectAllowedDevOrigins();

function parseBuildWorkers(value) {
  if (!value) {
    return 1;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

const buildWorkers = parseBuildWorkers(process.env.PDPP_WEB_BUILD_WORKERS);

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  reactStrictMode: true,
  experimental: {
    // The default is host CPU count minus one (23 on the owner workstation),
    // which repeatedly trips native SIGSEGV / SIGTRAP during production
    // builds on Next 16.2.x. Keep the canonical build stable by default while
    // still allowing CI/operators to raise it intentionally.
    cpus: buildWorkers,
  },
  // Transpile the reference-implementation workspace package so Next can
  // consume its TypeScript sources directly once shim pairs (.js + .d.ts)
  // collapse into single .ts exports. Without this, Next's bundler would
  // reject .ts entries from a node_modules-resolved workspace package.
  transpilePackages: ['pdpp-reference-implementation', '@pdpp/brand'],
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
          '/dashboard/:connector((?!traces|grants|runs|records|data|search|timeline|schedules|deployment|components|lib)[^/]+)/:rest*',
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
      // Sandbox demo well-known metadata. Next.js cannot route a path
      // segment that starts with a dot directly, so the handlers live
      // under `well-known/**` and we expose them at `/.well-known/**`.
      {
        source: '/sandbox/.well-known/oauth-authorization-server',
        destination: '/sandbox/well-known/oauth-authorization-server',
      },
      {
        source: '/sandbox/.well-known/oauth-protected-resource',
        destination: '/sandbox/well-known/oauth-protected-resource',
      },
      // Sandbox demo reference-only inspection routes. Public path uses
      // the underscore convention from the live reference (`/_ref/`); the
      // handlers live under `ref/**` so Next's "private folder" rule does
      // not exclude them from routing.
      {
        source: '/sandbox/_ref/:path*',
        destination: '/sandbox/ref/:path*',
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
