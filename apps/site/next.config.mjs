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
  // Runtime file reads outside the bundled output need explicit tracing
  // includes so Next copies them into the standalone deploy. Without these,
  // /planning, /reference/coverage, the well-known agent-skill catalog, and
  // /llms-full.txt 500 on Vercel because the markdown they read is absent.
  outputFileTracingIncludes: {
    '/planning': [
      '../../openspec/**/*.md',
      '../../pnpm-workspace.yaml',
      '.generated/openspec-git-metadata.json',
    ],
    '/planning/**': [
      '../../openspec/**/*.md',
      '../../pnpm-workspace.yaml',
      '.generated/openspec-git-metadata.json',
    ],
    // resolveRepoRoot() looks for a directory containing both
    // pnpm-workspace.yaml and openspec/, so a stub openspec marker is needed
    // even for routes that only read docs/agent-skills.
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
      // Sandbox IA parity: sandbox/records/timeline redirects to sandbox/explore
      // now that the sandbox Explore canvas exists.
      {
        source: '/sandbox/records/timeline',
        destination: '/sandbox/explore',
        permanent: false,
      },
      // NOTE: `/dashboard/**` and `/explore` redirects were dropped when the
      // operator console moved to `apps/console`. The public site owns no
      // `/dashboard` surface; those redirects live in `apps/console/next.config.mjs`.
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
      // Root agent skill discovery. Keep handlers under a filesystem-safe
      // internal path and expose the standards-shaped public .well-known URL.
      {
        source: '/.well-known/skills/:path*',
        destination: '/well-known/skills/:path*',
      },
      // NOTE: the top-level `/.well-known/oauth-authorization-server` and
      // `/.well-known/oauth-protected-resource` rewrites were dropped with the
      // BFF; the public site does not front a live AS/RS. Operator AS/RS
      // discovery is served by `reference-implementation` and `apps/console`.
      // The sandbox demo keeps its own mock-backed well-known handlers below.
      // Sandbox demo well-known metadata uses the same internal-path adapter:
      // handlers live under `well-known/**`; public URLs stay .well-known.
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
