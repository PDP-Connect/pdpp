import path from 'path';
import { fileURLToPath } from 'url';
import { collectAllowedDevOrigins } from './scripts/dev-origins.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
  outputFileTracingIncludes: {
    '/well-known/skills/**': [
      '../../docs/agent-skills/**/*.md',
      '../../openspec/README.md',
      '../../pnpm-workspace.yaml',
    ],
    '/llms-full.txt': [
      '../../docs/agent-skills/**/*.md',
      '../../openspec/README.md',
      '../../pnpm-workspace.yaml',
    ],
    '/llms.txt': [
      '../../docs/agent-skills/**/*.md',
      '../../openspec/README.md',
      '../../pnpm-workspace.yaml',
    ],
  },
  reactStrictMode: true,
  experimental: {
    cpus: buildWorkers,
  },
  // Transpile the reference-implementation workspace package so Next can
  // consume its TypeScript sources directly once shim pairs (.js + .d.ts)
  // collapse into single .ts exports. Without this, Next's bundler would
  // reject .ts entries from a node_modules-resolved workspace package.
  transpilePackages: ['pdpp-reference-implementation', '@pdpp/brand', '@pdpp/brand-react', '@pdpp/operator-ui'],
  async redirects() {
    return [
      {
        source: '/favicon.ico',
        destination: '/brand/pdpp-favicon.svg',
        permanent: false,
      },
      // Console root → dashboard. The standards/docs site lives in apps/site.
      // Dashboard IA migration: connector browsing lives under /dashboard/records/
      // and the standalone /dashboard/timeline route is now /dashboard/records/timeline.
      // Records-explorer was promoted to the top-level `/dashboard/explore`
      // by `promote-explore-to-top-level-ia`. Keep the redirect non-permanent
      // until the Connections rename retires the entire `/dashboard/records`
      // subtree, at which point a single permanent block can cover it.
      {
        source: '/dashboard/records/explorer',
        destination: '/dashboard/explore',
        permanent: false,
      },
      // Time-range browsing was absorbed into Explore by
      // `absorb-timeline-into-explore-ia`. Non-permanent so the redirect
      // can be folded into a wider records-subtree retirement later.
      {
        source: '/dashboard/records/timeline',
        destination: '/dashboard/explore',
        permanent: false,
      },
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
        destination: '/dashboard/explore',
        permanent: false,
      },
      {
        source: '/dashboard/timeline/:rest*',
        destination: '/dashboard/explore',
        permanent: false,
      },
      // Top-level /explore alias for the operator Explore canvas.
      // The console app is the Docker/reference-server surface, so this must
      // live here as well as in apps/site.
      {
        source: '/explore',
        destination: '/dashboard/explore',
        permanent: false,
      },
      {
        source: '/explore/:rest*',
        destination: '/dashboard/explore/:rest*',
        permanent: false,
      },
      // Bare connector-style paths from the pre-v1 dashboard map to Records.
      // Excludes reserved top-level sections so they don't get caught.
      {
        source:
          '/dashboard/:connector((?!traces|grants|runs|records|data|search|explore|timeline|schedules|connect|deployment|device-exporters|event-subscriptions|stream-playground|components|lib)[^/]+)/:rest*',
        destination: '/dashboard/records/:connector/:rest*',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/well-known/oauth-authorization-server',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/well-known/oauth-protected-resource/:path*',
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/well-known/oauth-protected-resource',
      },
      {
        source: '/.well-known/skills/:path*',
        destination: '/well-known/skills/:path*',
      },
      {
        source: '/.well-known/llms.txt',
        destination: '/llms.txt',
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

export default nextConfig;
