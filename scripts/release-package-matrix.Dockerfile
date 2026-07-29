ARG NODE_IMAGE=node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b
FROM ${NODE_IMAGE}

ARG PNPM_VERSION
ARG PNPM_INTEGRITY

# Node 25 no longer ships Corepack. Fetch one exact pnpm tarball during image
# construction, verify its SRI value, then run the candidate matrix with Docker
# networking disabled. This separates the bootstrap trust boundary from the
# offline consumer proof.
RUN npm pack --ignore-scripts --loglevel=error --pack-destination /tmp "pnpm@${PNPM_VERSION}" \
  && node --input-type=module -e "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; const [file, expected] = process.argv.slice(1); const actual = 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64'); if (actual !== expected) throw new Error('pnpm integrity drift: ' + actual);" "/tmp/pnpm-${PNPM_VERSION}.tgz" "$PNPM_INTEGRITY" \
  && npm install --global --ignore-scripts --no-audit --no-fund "/tmp/pnpm-${PNPM_VERSION}.tgz" \
  && test "$(pnpm --version)" = "$PNPM_VERSION" \
  && command -v pnpm >/pdpp-pnpm-path

WORKDIR /workspace
COPY pnpm-lock.yaml ./
# The lockfile's package integrities bind this networked prefetch. The matrix
# row then uses this store with `--offline` and Docker networking disabled.
RUN pnpm fetch --frozen-lockfile --store-dir /pdpp-pnpm-store \
  && chmod -R a+rwX /pdpp-pnpm-store

# Seed the same semver range the candidate MCP package declares. Pinning this
# bootstrap to its lower bound cached metadata for newer compatible SDK
# releases but not their transitive tarballs, so an offline empty-consumer
# install could resolve one and fail with ENOTCACHED.
RUN mkdir -p /tmp/npm-seed-v4-old /tmp/npm-seed-v4-new /tmp/npm-seed-v3 /tmp/npm-seed-mcp /pdpp-npm-cache \
  && npm_config_cache=/pdpp-npm-cache npm install --prefix /tmp/npm-seed-v4-old --ignore-scripts --no-audit --no-fund --package-lock=false zod@4.3.6 \
  && npm_config_cache=/pdpp-npm-cache npm install --prefix /tmp/npm-seed-v4-new --ignore-scripts --no-audit --no-fund --package-lock=false zod@4.4.3 \
  && npm_config_cache=/pdpp-npm-cache npm install --prefix /tmp/npm-seed-v3 --ignore-scripts --no-audit --no-fund --package-lock=false zod@3.25.76 \
  && npm_config_cache=/pdpp-npm-cache npm install --prefix /tmp/npm-seed-mcp --ignore-scripts --no-audit --no-fund --package-lock=false "@modelcontextprotocol/sdk@^1.29.0" \
  && chmod -R a+rwX /pdpp-npm-cache
