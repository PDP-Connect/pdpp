# syntax=docker/dockerfile:1.7

# Railway templates/config-as-code expose a Dockerfile path but not a Docker
# target-stage field. This Dockerfile is the template-safe private reference
# service image: its final stage is the reference runtime, so a Railway Template
# can select it directly without a manual "Target Stage" setting.
#
# Keep the dependency/browser/reference stages in sync with the root Dockerfile.

ARG NODE_VERSION=25-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM node:${NODE_VERSION} AS base

ARG PNPM_VERSION

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --force corepack \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

FROM base AS deps

ENV PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/console/package.json apps/console/package.json
COPY packages/operator-ui/package.json packages/operator-ui/package.json
COPY packages/pdpp-brand/package.json packages/pdpp-brand/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/polyfill-connectors/package.json packages/polyfill-connectors/package.json
COPY packages/polyfill-connectors/scripts/install-patchright-browser.mjs packages/polyfill-connectors/scripts/install-patchright-browser.mjs
COPY packages/reference-contract/package.json packages/reference-contract/package.json
COPY packages/remote-surface/package.json packages/remote-surface/package.json
COPY reference-implementation/package.json reference-implementation/package.json

RUN pnpm install --frozen-lockfile

FROM deps AS source

COPY . .

FROM base AS browsers

ARG TARGETARCH
ARG PATCHRIGHT_VERSION=1.59.4

WORKDIR /tmp/patchright-install

RUN echo '{"name":"patchright-installer","private":true,"version":"0.0.0"}' > package.json \
  && npm install --no-save --ignore-scripts "patchright@${PATCHRIGHT_VERSION}" \
  && if [ "$TARGETARCH" = "arm64" ]; then \
       npx patchright install --with-deps chromium; \
     else \
       npx patchright install --with-deps chrome chromium; \
     fi \
  && rm -rf /tmp/patchright-install

WORKDIR /app

FROM browsers AS reference

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["node", "reference-implementation/server/index.js"]
