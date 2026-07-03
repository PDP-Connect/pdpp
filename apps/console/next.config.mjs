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
