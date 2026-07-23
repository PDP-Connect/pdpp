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
  && chmod -R a+rX /pdpp-pnpm-store
