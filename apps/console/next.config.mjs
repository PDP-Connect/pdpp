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
const manualUploadBodyLimit = '1024mb';

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
    proxyClientMaxBodySize: manualUploadBodyLimit,
    serverActions: {
      bodySizeLimit: manualUploadBodyLimit,
    },
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
      // ── Clean owner-route topology (redesign-owner-console-product-experience
      // §10.B) ──────────────────────────────────────────────────────────────
      //
      // The owner console serves clean top-level nouns off root (`/`, `/sources`,
      // `/syncs`, `/audit`, `/explore`, `/grants`, `/connect`, `/schedules`, and
      // the deployment/admin nouns). Every legacy `/dashboard/*` link redirects
      // to its clean target so bookmarks and agent-generated links keep working.
      // These targets are final, so the redirects are permanent (308).
      //
      // ORDER MATTERS — Next.js uses first-match. The chained legacy aliases and
      // the three renamed sections (records→sources, runs→syncs, traces→audit)
      // MUST precede the generic prefix-strip and bare-connector rules.

      // Chained legacy aliases that historically resolved to other surfaces.
      // Records-explorer and records-timeline were promoted/absorbed into
      // Explore; `/dashboard/data*` was the old Records alias; `/dashboard/timeline*`
      // was the standalone timeline before it merged into Explore.
      {
        source: '/dashboard/records/explorer',
        destination: '/explore',
        permanent: true,
      },
      {
        source: '/dashboard/records/timeline',
        destination: '/explore',
        permanent: true,
      },
      {
        source: '/dashboard/data',
        destination: '/sources',
        permanent: true,
      },
      {
        source: '/dashboard/data/:rest*',
        destination: '/sources/:rest*',
        permanent: true,
      },
      {
        source: '/dashboard/timeline',
        destination: '/explore',
        permanent: true,
      },
      {
        source: '/dashboard/timeline/:rest*',
        destination: '/explore',
        permanent: true,
      },

      // Renamed sections: records→Sources, runs→Syncs, traces→Audit.
      { source: '/dashboard/records', destination: '/sources', permanent: true },
      { source: '/dashboard/records/:rest*', destination: '/sources/:rest*', permanent: true },
      { source: '/dashboard/runs', destination: '/syncs', permanent: true },
      { source: '/dashboard/runs/:rest*', destination: '/syncs/:rest*', permanent: true },
      { source: '/dashboard/traces', destination: '/audit', permanent: true },
      { source: '/dashboard/traces/:rest*', destination: '/audit/:rest*', permanent: true },

      // Bare connector-style paths from the pre-v1 dashboard map to Sources.
      // Excludes reserved top-level sections so they don't get caught. This must
      // come before the generic prefix-strip so a connector id is not mistaken
      // for a section.
      {
        source:
          '/dashboard/:connector((?!traces|grants|runs|records|data|search|explore|timeline|schedules|connect|deployment|device-exporters|event-subscriptions|stream-playground|components|lib)[^/]+)/:rest*',
        destination: '/sources/:connector/:rest*',
        permanent: true,
      },

      // Same-name sections: strip the `/dashboard` prefix. Covers explore,
      // grants, connect, schedules, deployment, device-exporters,
      // event-subscriptions, search, stream-playground, and any remaining
      // deep paths. The bare `/dashboard` root maps to the overview `/`.
      { source: '/dashboard/:rest*', destination: '/:rest*', permanent: true },
      { source: '/dashboard', destination: '/', permanent: true },
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
