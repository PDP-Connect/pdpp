# syntax=docker/dockerfile:1.7

# Railway templates/config-as-code expose a Dockerfile path but not a Docker
# target-stage field. This Dockerfile is the template-safe private reference
# service image: its final stage is the reference runtime, so a Railway Template
# can select it directly without a manual "Target Stage" setting.
#
# Keep the dependency/reference stages in sync with the root Dockerfile.

ARG NODE_VERSION=24-bookworm-slim
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

ENV PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/console/package.json apps/console/package.json
COPY packages/operator-ui/package.json packages/operator-ui/package.json
COPY packages/pdpp-brand/package.json packages/pdpp-brand/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/polyfill-connectors/package.json packages/polyfill-connectors/package.json
COPY packages/polyfill-connectors/scripts/install-patchright-browser.ts packages/polyfill-connectors/scripts/install-patchright-browser.ts
COPY packages/reference-contract/package.json packages/reference-contract/package.json
COPY reference-implementation/package.json reference-implementation/package.json
# Two workspace manifests depend on `file:../../vendor/*.tgz`, so the tarballs
# are install inputs exactly like the manifests above — not source. Without
# them `pnpm install` fails with ENOENT on the tarball path. This stage is
# cached on the manifests, so the omission stayed invisible for as long as the
# deps layer kept hitting cache and only surfaced on the first cold build.
COPY vendor/ vendor/

# `--ignore-scripts`, then run the lifecycle in `source` below. Workspace
# `prepare` hooks compile their own package (`@pdpp/mcp-server` runs
# `pnpm build`, which needs `@pdpp/cli` and its own `src/`), and none of that
# source exists yet in this stage — nor should it, since the whole point of
# resolving dependencies against manifests alone is that a source edit does not
# invalidate the layer. Running the hooks here fails with ERR_MODULE_NOT_FOUND
# on `packages/mcp-server/scripts/build.ts`.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS source

COPY . .

# Now that every workspace's source is present, run the `prepare` hooks the
# install deliberately skipped. `@pdpp/mcp-server` builds its gitignored
# `dist/` here, which its `bin` entry points at — so skipping this entirely
# would produce an image whose MCP binary silently does not exist.
# `pnpm rebuild` is NOT the right verb: it runs install/postinstall, not
# `prepare`. Invoke the hook directly, and only where one is declared.
RUN pnpm --recursive --if-present run prepare

FROM base AS reference

ARG PDPP_REFERENCE_REVISION=unknown

# PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT is baked in because this
# image is deployed exclusively through railway.reference.json, which commits
# restartPolicyType=ON_FAILURE for this exact service — a real supervisor
# restart on the fail-stop the flag asserts. If this stage is ever deployed
# through a path with no restart policy, that deployment is the truthful gap
# to fix, not this flag.
ENV NODE_ENV=production \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["sh", "-c", "export AS_PORT=\"${PORT:-${AS_PORT:-7662}}\"; export PDPP_RS_URL=\"${PDPP_RS_URL:-http://127.0.0.1:${RS_PORT:-7663}}\"; exec node reference-implementation/server/index.ts"]
