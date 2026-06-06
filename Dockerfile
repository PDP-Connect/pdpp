# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=25-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM node:${NODE_VERSION} AS base

ARG PNPM_VERSION

# PLAYWRIGHT_BROWSERS_PATH is pinned to a stable, image-wide location so the
# bundled-Patchright browser tree can be installed once in a dedicated cache
# stage and copied into browser-enabled final images. Without this, Patchright defaults to
# $HOME/.cache/ms-playwright which is invisible to inter-stage COPY and forces
# every reference build to reinstall ~300MB of browsers + their apt deps.
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

# Skip the patchright postinstall browser download during workspace install.
# Browsers are installed once in the dedicated `browsers` stage so source
# changes do not reinvalidate the browser layer; without this env, the
# polyfill-connectors postinstall would also download browsers into
# /opt/patchright-browsers during every dependency rebuild and would
# slow the console build stage that does not need browsers.
ENV PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The legacy combined `apps/web` app has been removed by the
# public-site/operator-console split. The GHCR `web` image tag now builds the
# `console` stage below. Only the operator-console manifest is needed in the
# deps stage; the public-site (`apps/site`) image is built in a follow-up stage
# and is not required by the operator's default `docker compose up`.
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

FROM source AS console-builder

RUN pnpm --filter pdpp-console build

# Core AS/RS reference runtime. Keep this browser-free: managed-platform Core
# deploys do not run browser-backed collection inside the server container.
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
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["sh", "-c", "export AS_PORT=\"${PORT:-${AS_PORT:-7662}}\"; export PDPP_RS_URL=\"${PDPP_RS_URL:-http://127.0.0.1:${RS_PORT:-7663}}\"; exec node reference-implementation/server/index.js"]

# Dedicated browsers stage. Patchright + bundled Chromium + (on amd64) Google
# Chrome stable + their apt deps are baked into a stage whose cache key is
# only the patchright version and target arch. This is independent of the
# rest of the lockfile or any source change, so ordinary code edits do not
# reinvalidate the ~300MB browser install. Bumping the pinned version is the
# only thing that forces a rebuild of this layer.
#
# The version is pinned to the same patchright used by docker/neko/Dockerfile
# (1.59.4 → Chromium 1217). Bump both files together to keep the driver-side
# (reference container) and binary-side (n.eko container) revisions in
# lockstep; otherwise the CDP attach against n.eko sees a Chromium revision
# the driver was not built for.
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

FROM browsers AS reference-browser

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["node", "reference-implementation/server/index.js"]

# Operator console: self-hosted dashboard + BFF proxy to the AS/RS. This is
# the default target for `docker compose up` (see docker-compose.yml `web`
# service, which selects `target: console`). The GHCR `web` image tag is kept
# as an operator-compatibility alias and now builds this stage; the legacy
# combined `apps/web` app was removed by the public-site/operator-console split.
# The public docs image (apps/site) lands as a separate stage in a follow-up
# tranche. See openspec/changes/split-public-site-and-operator-console.
FROM base AS console

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=console-builder /app/apps/console/.next/standalone ./
COPY --from=console-builder /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=console-builder /app/apps/console/public ./apps/console/public

EXPOSE 3000

CMD ["node", "apps/console/server.js"]

# Railway pushbutton Core image: one public service runs the console on Railway
# $PORT and the reference AS/RS on loopback. This avoids a separate private app
# service whose reserved PORT variable becomes a template prompt.
FROM base AS railway-core

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_AS_URL=http://127.0.0.1:7662 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app
COPY --from=console-builder /app/apps/console/.next/standalone /console
COPY --from=console-builder /app/apps/console/.next/static /console/apps/console/.next/static
COPY --from=console-builder /app/apps/console/public /console/apps/console/public

EXPOSE 3000

CMD ["node", "/app/deploy/railway/core-supervisor.mjs"]
