# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=25.8.2-bookworm-slim@sha256:71be4054ee7a5fc8d0b2a66060705988b09a782025d70ba9318b29ff1a931fc0
ARG PNPM_VERSION=10.33.0
ARG PNPM_INTEGRITY=sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==
ARG GO_VERSION=1.24.2-bookworm@sha256:79390b5e5af9ee6e7b1173ee3eac7fadf6751a545297672916b59bfa0ecf6f71

FROM node:${NODE_VERSION} AS base

ARG PNPM_VERSION
ARG PNPM_INTEGRITY

# PLAYWRIGHT_BROWSERS_PATH is pinned to a stable, image-wide location so the
# bundled-Patchright browser tree can be installed once in a dedicated cache
# stage and copied into browser-enabled final images. Without this, Patchright defaults to
# $HOME/.cache/ms-playwright which is invisible to inter-stage COPY and forces
# every reference build to reinstall ~300MB of browsers + their apt deps.
ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm pack --ignore-scripts --loglevel=error --pack-destination /tmp "pnpm@${PNPM_VERSION}" \
  && node --input-type=module -e "import { createHash } from 'node:crypto'; import { readFileSync } from 'node:fs'; const [file, expected] = process.argv.slice(1); const actual = 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64'); if (actual !== expected) throw new Error('pnpm integrity drift: ' + actual);" "/tmp/pnpm-${PNPM_VERSION}.tgz" "$PNPM_INTEGRITY" \
  && npm install --global --ignore-scripts --no-audit --no-fund "/tmp/pnpm-${PNPM_VERSION}.tgz" \
  && test "$(pnpm --version)" = "$PNPM_VERSION"

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
COPY packages/pdpp-brand-react/package.json packages/pdpp-brand-react/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/read-core/package.json packages/read-core/package.json
COPY packages/polyfill-connectors/package.json packages/polyfill-connectors/package.json
COPY packages/polyfill-connectors/scripts/install-patchright-browser.ts packages/polyfill-connectors/scripts/install-patchright-browser.ts
COPY packages/reference-contract/package.json packages/reference-contract/package.json
COPY reference-implementation/package.json reference-implementation/package.json
# LOCAL-ONLY: brings the vendored unpublished remote-surface tarball into the
# deps stage so `pnpm install --frozen-lockfile` below can resolve
# reference-implementation's direct `file:` optionalDependency pointing at
# it. Only makes sense while that local vendor path/dependency exists — MUST
# be removed along with reference-implementation's package.json entry and
# pnpm-lock.yaml entry before any push/PR/merge to main.
COPY local-artifacts/vendor/opendatalabs-remote-surface-0.3.1-rs-lease-cleanup-contract-0803.tgz local-artifacts/vendor/opendatalabs-remote-surface-0.3.1-rs-lease-cleanup-contract-0803.tgz

# Do not run workspace prepare scripts against this manifest-only tree. Native
# dependencies still need their approved install hooks before the runtime is
# assembled; workspace outputs are built from the complete source stage below.
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm -r rebuild better-sqlite3 esbuild onnxruntime-node protobufjs

FROM deps AS source

COPY . .

RUN pnpm --filter @pdpp/polyfill-connectors run postinstall \
  && pnpm --filter @pdpp/read-core run build \
  && pnpm --filter @pdpp/cli run build \
  && pnpm --filter @pdpp/mcp-server run build

# The Slack connector's identity companion is deliberately built in a pinned
# Go stage: the Node runtime stages do not carry a Go toolchain, and a
# package.json script alone would never put this executable in a reference
# image. Keep module metadata in its own cacheable layer and verify the exact
# Slackdump v3.1.13 module before compiling the static runtime binary.
FROM golang:${GO_VERSION} AS slackdump-identity-builder

WORKDIR /src/slackdump-identity
COPY packages/polyfill-connectors/connectors/slack/slackdump-identity/go.mod packages/polyfill-connectors/connectors/slack/slackdump-identity/go.sum ./
RUN go mod download \
  && go mod verify
COPY packages/polyfill-connectors/connectors/slack/slackdump-identity/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/slackdump-identity . \
  && test -x /out/slackdump-identity \
  && test "$(/out/slackdump-identity --version)" = "pdpp-slackdump-identity/3.1.13 github.com/rusq/slackdump/v3@v3.1.13"

FROM source AS console-builder

RUN pnpm --filter pdpp-console build

# Core AS/RS reference runtime. Keep this browser-free: managed-platform Core
# deploys do not run browser-backed collection inside the server container.
FROM base AS connector-runtime

COPY --from=slackdump-identity-builder /out/slackdump-identity /opt/pdpp-tools/slackdump/slackdump-identity

FROM connector-runtime AS reference

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

# The source stage contains lifecycle-independent, dependency-ordered workspace
# outputs. Runtime imports must use that completed tree, not a manifest-only
# dependency stage overlaid with raw source.
COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["sh", "-c", "export AS_PORT=\"${PORT:-${AS_PORT:-7662}}\"; export PDPP_RS_URL=\"${PDPP_RS_URL:-http://127.0.0.1:${RS_PORT:-7663}}\"; exec node reference-implementation/server/index.ts"]

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
FROM connector-runtime AS browsers

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

# See the `reference` stage: retain built workspace artifacts from source.
COPY --from=source /app /app

EXPOSE 7662 7663

CMD ["node", "reference-implementation/server/index.ts"]

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
#
# The same image is the Docker quickstart target (deploy/docker/README.md), so
# it carries laptop-friendly defaults that managed platforms override per
# deploy: PDPP_REFERENCE_ORIGIN defaults to the published localhost port, and
# PDPP_DB_PATH defaults onto /var/lib/pdpp so `-v pdpp_data:/var/lib/pdpp`
# makes the SQLite database (and first-boot credentials, see
# deploy/railway/core-first-boot.ts) durable. With a database URL present the
# runtime selects Postgres and the SQLite default is ignored.
FROM connector-runtime AS railway-core

ARG PDPP_REFERENCE_REVISION=unknown

# PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT is baked in (unlike the
# root docker-compose.yml `reference` service, which sets it explicitly in
# compose env) because this image stage is deployed exclusively through
# platform config that already carries a real restart policy for it:
# Railway's railway.console.json/railway.reference.json commit
# restartPolicyType=ON_FAILURE, and Fly's fly.toml uses this same
# `platform-core` target under Fly's default on-failure machine restart (no
# [[restart]] override). If this stage is ever deployed through a path with
# no restart policy, that deployment is the truthful gap to fix, not this
# flag.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_AS_URL=http://127.0.0.1:7662 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_REFERENCE_ORIGIN=http://localhost:3000 \
    PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

# See the `reference` stage: retain built workspace artifacts from source.
COPY --from=source /app /app
COPY --from=console-builder /app/apps/console/.next/standalone /console
COPY --from=console-builder /app/apps/console/.next/static /console/apps/console/.next/static
COPY --from=console-builder /app/apps/console/public /console/apps/console/public

EXPOSE 3000

CMD ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"]

# Single-container Core node WITH the browser runtime.
#
# `railway-core` above is deliberately browser-free, and `reference-browser`
# carries Chromium but no console (it EXPOSEs 7662/7663 only). That left no
# image where one `docker run` gives an owner both a dashboard and the
# browser-backed connectors, so the documented answer for ChatGPT was a
# multi-file Compose stack. This stage is the missing combination: the
# `browsers` lineage plus the same console bundle and supervisor as
# `railway-core`.
#
# It is a separate tag rather than a replacement because Chromium and its apt
# deps add ~300MB+ that a network-only owner should not pay for.
FROM browsers AS core-browser

ARG PDPP_REFERENCE_REVISION=unknown

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_AS_URL=http://127.0.0.1:7662 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_REFERENCE_ORIGIN=http://localhost:3000 \
    PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

COPY --from=source /app /app
COPY --from=console-builder /app/apps/console/.next/standalone /console
COPY --from=console-builder /app/apps/console/.next/static /console/apps/console/.next/static
COPY --from=console-builder /app/apps/console/public /console/apps/console/public

EXPOSE 3000

CMD ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"]

# Generic managed-platform Core alias. It uses the same one-public-service
# supervisor as the Railway target: console on $PORT, AS/RS on loopback.
FROM railway-core AS platform-core
