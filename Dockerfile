# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=25-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM node:${NODE_VERSION} AS base

ARG PNPM_VERSION

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --force corepack \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/pdpp-brand/package.json packages/pdpp-brand/package.json
COPY packages/polyfill-connectors/package.json packages/polyfill-connectors/package.json
COPY packages/reference-contract/package.json packages/reference-contract/package.json
COPY packages/remote-surface/package.json packages/remote-surface/package.json
COPY reference-implementation/package.json reference-implementation/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS source

COPY . .

FROM source AS web-builder

RUN pnpm --filter pdpp-web build

FROM base AS reference

# `.git` is excluded from the Docker build context (.dockerignore), so the
# runtime cannot derive a real git revision at startup and falls back to
# `+unknown`. Pass the real revision in at build time so production images
# advertise the running commit:
#   docker build --build-arg PDPP_REFERENCE_REVISION=$(git rev-parse --short=12 HEAD) ...
ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

# Runtime browser assets are installed outside /app, so the deps-stage
# postinstall cache is not present in final images. Install real Chrome for
# Patchright's recommended channel plus bundled Chromium as an explicit
# fallback for the isolated launcher.
RUN pnpm --dir packages/polyfill-connectors exec patchright install --with-deps chrome chromium

EXPOSE 7662 7663

CMD ["node", "reference-implementation/server/index.js"]

FROM base AS web

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=web-builder /app/apps/web/.next/standalone ./
COPY --from=web-builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-builder /app/apps/web/public ./apps/web/public
COPY --from=web-builder /app/openspec ./openspec
COPY --from=web-builder /app/design-notes ./design-notes
COPY --from=web-builder /app/spec-*.md ./

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
