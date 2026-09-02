# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG PNPM_VERSION=10.33.0
ARG PNPM_INTEGRITY=sha512-EFaLtKavtYyes2MNqQzJUWQXq+vT+rvmc58K55VyjaFJHp21pUTHatjrdXD1xLs9bGN7LLQb/c20f6gjyGSTGQ==

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
# packages/polyfill-connectors depends on these via `file:../../vendor/*.tgz`;
# pnpm resolves and unpacks that tarball during install, so it must be present
# before the manifest-only install below, not just in the full source stage.
COPY vendor/ vendor/

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

FROM source AS console-builder

RUN pnpm --filter pdpp-console build

# Split-service AS/RS reference runtime. Keep this stage browser-free; the
# browser-capable Core payload is assembled by the core-browser stage below.
FROM base AS reference

# `.git` is excluded from the Docker build context (.dockerignore), so the
# runtime cannot derive a real git revision at startup and falls back to
# `+unknown`. Pass the real revision in at build time so production images
# advertise the running commit. Use the FULL SHA, not an abbreviated form:
# the core-browser stage's build-time identity check (and
# deploy/docker/check-image-identity.sh, the pre-acceptance gate) both
# require a full 40-character (SHA-1) or 64-character (SHA-256) hex value —
# an abbreviated SHA is ambiguous and is rejected as not shaped like a real
# git object id. This `reference` stage carries no OCI revision label and is
# not gated the same way, but using the full SHA here keeps every
# PDPP_REFERENCE_REVISION build invocation in this repo consistent with the
# one that IS gated (`--target core`/`core-browser`):
#   docker build --build-arg PDPP_REFERENCE_REVISION=$(git rev-parse HEAD) ...
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

# Isolated sigtop (v0.24.0, ISC) builder stage.
# sigtop publishes only a Windows binary on its releases, so Linux is built
# from the pinned source tag in a throwaway Go stage. Only the resulting
# binary and its license are copied into the final image -- Go itself is not.
# Go 1.25+: sigtop v0.24.0's go.mod requires it, and GOTOOLCHAIN=local in the
# official image means an older base fails the build outright rather than
# silently fetching a newer toolchain.
FROM golang:1.25-bookworm AS sigtop-builder

ARG SIGTOP_VERSION=v0.24.0

WORKDIR /build

# libsecret-1-dev is a build dependency, not an optional extra: sigtop builds
# with CGO_ENABLED=1 and links against libsecret to read Signal Desktop's
# encrypted database key from the OS keyring. Without the headers the cgo step
# fails at pkg-config.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libsecret-1-dev pkg-config && \
    rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${SIGTOP_VERSION}" https://github.com/tbvdm/sigtop.git src && \
    cd src && \
    git rev-parse HEAD > /build/SOURCE_COMMIT && \
    CGO_ENABLED=1 go build -o /build/sigtop . && \
    test -x /build/sigtop && \
    cp LICENSE.md /build/LICENSE && \
    printf 'https://github.com/tbvdm/sigtop/tree/%s\n' "$(cat /build/SOURCE_COMMIT)" > /build/SOURCE_URL

# Isolated slackdump (v4.4.2, AGPL-3.0) builder stage.
# Downloads pre-built tarball, verifies SHA256, extracts binary and license.
# Only the binary (not build deps or Go) is copied to final image.
FROM debian:bookworm-slim AS slackdump-builder

ARG TARGETARCH

WORKDIR /build

# Map Docker TARGETARCH to slackdump release tarball name
RUN case "${TARGETARCH}" in \
      x86_64|amd64) SLACKDUMP_TARBALL="slackdump_Linux_x86_64.tar.gz"; SLACKDUMP_SHA256="e2f386b2af30b0ba0ae98973f6a053225fba7d7127a20ad196cfdd96bf601052" ;; \
      arm64) SLACKDUMP_TARBALL="slackdump_Linux_arm64.tar.gz"; SLACKDUMP_SHA256="71d8b55b9132c0d39d6fe66e3542ee7d2ec6c032b7701928124c736611cc235e" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    echo "${SLACKDUMP_TARBALL}" > /tmp/tarball.txt && \
    echo "${SLACKDUMP_SHA256}" > /tmp/sha256.txt

# Install only ca-certificates and curl; minimal runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Download from official GitHub release, verify SHA256, extract
RUN TARBALL=$(cat /tmp/tarball.txt) && \
    EXPECTED_SHA=$(cat /tmp/sha256.txt) && \
    curl -fsSL -o "${TARBALL}" "https://github.com/rusq/slackdump/releases/download/v4.4.2/${TARBALL}" && \
    ACTUAL_SHA=$(sha256sum "${TARBALL}" | awk '{print $1}') && \
    if [ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]; then \
      echo "SHA256 mismatch for ${TARBALL}" >&2; \
      echo "Expected: ${EXPECTED_SHA}" >&2; \
      echo "Actual:   ${ACTUAL_SHA}" >&2; \
      exit 1; \
    fi && \
    tar -xzf "${TARBALL}" && \
    test -x slackdump && \
    ./slackdump version

# Download LICENSE and source reference from upstream
# AGPL section 6(d): Corresponding Source URL must resolve to exact versioned tree
RUN curl -fsSL -o LICENSE "https://raw.githubusercontent.com/rusq/slackdump/v4.4.2/LICENSE" && \
    echo "https://github.com/rusq/slackdump/tree/v4.4.2" > SOURCE_URL && \
    test -f LICENSE && test -s LICENSE

# Dedicated browsers stage. Patchright + bundled Chromium + (on amd64) Google
# Chrome stable + their apt deps are baked into a stage whose cache key is
# only the patchright version and target arch. This is independent of the
# rest of the lockfile or any source change, so ordinary code edits do not
# reinvalidate the ~300MB browser install. Bumping the pinned version is the
# only thing that forces a rebuild of this layer.
#
# The browser installer reads the exact dependency version from the workspace
# manifest. Keeping the runtime dependency exact and deriving this install from
# it makes a Patchright/Chromium revision drift fail at build review time rather
# than at connector launch.
FROM base AS browsers

ARG TARGETARCH

# Image-owned runtime capability. Browser-bearing final stages inherit this
# marker; non-browser stages start from `base` and therefore remain false.
ENV PDPP_RUNTIME_BROWSER=1

# Core's default browser mode is headed. Keep the virtual display explicit in
# the image rather than relying on Patchright's transitive OS dependencies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && test -x /usr/bin/Xvfb

COPY packages/polyfill-connectors/package.json /tmp/polyfill-connectors-package.json

WORKDIR /tmp/patchright-install

RUN PATCHRIGHT_VERSION="$(node --input-type=module -e "import { readFileSync } from 'node:fs'; const version = JSON.parse(readFileSync('/tmp/polyfill-connectors-package.json', 'utf8')).dependencies.patchright; if (!/^\\d+\\.\\d+\\.\\d+$/.test(version)) throw new Error('Patchright dependency must be exact, got: ' + version); process.stdout.write(version)")" \
  && echo '{"name":"patchright-installer","private":true,"version":"0.0.0"}' > package.json \
  && npm install --no-save --ignore-scripts "patchright@${PATCHRIGHT_VERSION}" \
  && if [ "$TARGETARCH" = "arm64" ]; then \
       npx patchright install --with-deps chromium; \
     else \
       npx patchright install --with-deps chrome chromium; \
     fi \
  && test -n "$(find /opt/patchright-browsers -type f \( -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux/chrome' \) -print -quit)" \
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

# The console image is paired with the current reference implementation, whose
# merged-timeline contract supports direction=asc. Keep the explicit capability
# gate enabled for that pairing; an older external RS can still fail closed by
# setting PDPP_EXPLORE_TIMELINE_DIRECTION=0.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PDPP_EXPLORE_TIMELINE_DIRECTION=1

COPY --from=console-builder /app/apps/console/.next/standalone ./
COPY --from=console-builder /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=console-builder /app/apps/console/public ./apps/console/public

EXPOSE 3000

CMD ["node", "apps/console/server.js"]

# Browser-capable Core payload: one public service runs the console on Railway
# $PORT and the reference AS/RS on loopback. This avoids a separate private app
# service whose reserved PORT variable becomes a template prompt.
#
# The same image is the Docker quickstart target (deploy/docker/README.md), so
# it carries laptop-friendly defaults that managed platforms override per
# deploy. PDPP_REFERENCE_ORIGIN is intentionally NOT baked here (previously a
# fixed http://localhost:3000, which is only correct when the container's
# internal PORT=3000 is republished on the SAME host port — an operator who
# reassigns PDPP_WEB_PORT to anything else silently got the wrong port back
# in resource_metadata for any direct, unproxied client on its first 401).
# Leaving it unset lets the RS/AS derive their own base from the live
# request's Host header instead, which always matches the port a client
# actually used to connect. Set PDPP_REFERENCE_ORIGIN explicitly only when
# fronting this container with a reverse proxy or TLS terminator, where the
# request Host the container sees differs from the origin clients dial.
# PDPP_DB_PATH defaults onto /var/lib/pdpp so `-v pdpp_data:/var/lib/pdpp`
# makes the SQLite database (and first-boot credentials, see
# deploy/railway/core-first-boot.ts) durable. With a database URL present the
# runtime selects Postgres and the SQLite default is ignored.
#
# PDPP_CONNECTOR_ARTIFACT_ROOT is set explicitly rather than left to its
# derive-from-PDPP_DB_PATH default. The default would resolve correctly here
# (dirname of the baked SQLite path is /var/lib/pdpp), but a Postgres
# deployment ignores PDPP_DB_PATH entirely — pinning the artifact root means
# durable connector artifacts (the Slack archive, statement PDFs) do not
# silently depend on an unrelated SQLite default that a future change could
# move. See packages/polyfill-connectors/src/connector-artifact-root.ts.
#
# reference-implementation/server/index.ts's generic
# shouldAutoReconcilePolyfillManifests() default stays fail-closed for SQLite
# (it only recognizes the dev script's ../packages/polyfill-connectors/
# path) so ad-hoc/test SQLite DBs never get unexpected auto-registration.
# /var/lib/pdpp/pdpp.sqlite is NOT that dev path, so this stage is the only
# place that knows its own DB is the real polyfill deployment DB: bake
# PDPP_RECONCILE_POLYFILL_MANIFESTS=1 so first-party manifests (amazon, ...)
# get registered on boot. An operator can still force it off with
# `-e PDPP_RECONCILE_POLYFILL_MANIFESTS=0`; the env var always overrides this
# default (see index.ts's envEnabled handling).
FROM browsers AS core-browser

ARG PDPP_REFERENCE_REVISION=unknown

# Image provenance. Without these the deployed artifact cannot say what source
# it was built from, and identifying production means md5-diffing files against
# candidate worktrees. Sampling files that way is actively misleading: a file
# unchanged between two commits matches BOTH, so a sample that happens to miss
# the changed files "confirms" the wrong commit. Labels remove the guesswork.
#
# PDPP_BUILD_REVISION defaults to PDPP_REFERENCE_REVISION rather than its own
# independent "unknown" default. Every build caller (CI, reference-stack.sh,
# ad-hoc `docker build`) already sets PDPP_REFERENCE_REVISION to identify the
# runtime; before this default existed, a caller had to remember to ALSO pass
# PDPP_BUILD_REVISION identically or the org.opencontainers.image.revision
# label silently stayed "unknown" even on a real release build (exactly what
# happened to the retained production Core image). One build-arg is now the
# single source of truth for both the label and the runtime env; a caller
# only needs to override PDPP_BUILD_REVISION explicitly to intentionally
# diverge it from the runtime revision, which the RUN check below then
# refuses to allow silently.
#
# PDPP_BUILD_DIRTY must be set from `git status --porcelain` at build time. A
# silently-dirty build tree is how bad images shipped before, so an unclean
# tree is recorded in the artifact rather than left to memory.
ARG PDPP_BUILD_REVISION=${PDPP_REFERENCE_REVISION}
ARG PDPP_BUILD_SOURCE=unknown
ARG PDPP_BUILD_CREATED=unknown
ARG PDPP_BUILD_DIRTY=unknown
ARG PDPP_BUILD_COMPOSITION=unknown

# Fail the build itself, not just a post-hoc audit, when the two identity
# values a caller can independently set actually diverge. Both "unknown" is
# allowed (an ordinary local dev build with no revision supplied at all —
# see the Dockerfile-wide default above); anything else must match exactly
# AND be shaped like a real, full-length git object id (40 lowercase hex
# chars for SHA-1, or 64 for a future SHA-256 repository) — not merely
# equal. Equality alone is not sufficient: a build invoked with
# PDPP_REFERENCE_REVISION=main would make both values equal, non-"unknown",
# and still name a MUTABLE branch, not an immutable commit. Abbreviated
# SHAs are also rejected: a short SHA is ambiguous and this is a build-time
# identity contract, not a display convenience. This RUN is the earliest
# point a duplicate/mismatched/non-SHA revision can be caught, before the
# image is ever pushed or deployed; deploy/docker/check-image-identity.sh
# re-proves the same two properties (match + SHA-shape) against any already
# -built or pulled image afterward, since not every image this repo builds
# necessarily passes through this exact Dockerfile invocation at rest (a
# re-tagged image, a manifest copy via `docker buildx imagetools create`).
RUN if [ "${PDPP_BUILD_REVISION}" != "${PDPP_REFERENCE_REVISION}" ]; then \
      echo "image identity mismatch: PDPP_BUILD_REVISION='${PDPP_BUILD_REVISION}' != PDPP_REFERENCE_REVISION='${PDPP_REFERENCE_REVISION}'" >&2; \
      echo "the OCI revision label and the runtime revision must be the exact same immutable git SHA (or both 'unknown' for a plain local dev build)" >&2; \
      exit 1; \
    fi; \
    if [ "${PDPP_BUILD_REVISION}" != "unknown" ]; then \
      hex_len=$(printf '%s' "${PDPP_BUILD_REVISION}" | tr -d '0-9a-f' | wc -c); \
      full_len=$(printf '%s' "${PDPP_BUILD_REVISION}" | wc -c); \
      if [ "$hex_len" -ne 0 ] || { [ "$full_len" -ne 40 ] && [ "$full_len" -ne 64 ]; }; then \
        echo "image identity is not a real git object id: PDPP_REFERENCE_REVISION='${PDPP_REFERENCE_REVISION}' is not 40 or 64 lowercase hex characters" >&2; \
        echo "a mutable ref name (branch/tag) or an abbreviated SHA is not an immutable commit identity" >&2; \
        exit 1; \
      fi; \
    fi

LABEL org.opencontainers.image.revision="${PDPP_BUILD_REVISION}" \
      org.opencontainers.image.source="${PDPP_BUILD_SOURCE}" \
      org.opencontainers.image.created="${PDPP_BUILD_CREATED}" \
      pdpp.build.dirty="${PDPP_BUILD_DIRTY}" \
      pdpp.build.composition="${PDPP_BUILD_COMPOSITION}"

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
# Core bundles the matching reference implementation, including the
# direction=asc merged-timeline read contract. Keep the UI capability gate
# explicit; an older external RS can still fail closed with =0.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AS_PORT=7662 \
    RS_PORT=7663 \
    PDPP_AS_URL=http://127.0.0.1:7662 \
    PDPP_RS_URL=http://127.0.0.1:7663 \
    PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite \
    PDPP_BROWSER_PROFILE_ROOT=/var/lib/pdpp/browser-profiles \
    PDPP_CONNECTOR_ARTIFACT_ROOT=/var/lib/pdpp/connector-artifacts \
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED=1 \
    PDPP_EMBEDDING_CACHE_DIR=/var/lib/pdpp/transformers \
    PDPP_EXPLORE_TIMELINE_DIRECTION=1 \
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 \
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 \
    PDPP_RECONCILE_POLYFILL_MANIFESTS=1 \
    PDPP_REFERENCE_REVISION=${PDPP_REFERENCE_REVISION}

# See the `reference` stage: retain built workspace artifacts from source.
COPY --from=source /app /app
COPY --from=console-builder /app/apps/console/.next/standalone /console
COPY --from=console-builder /app/apps/console/.next/static /console/apps/console/.next/static
COPY --from=console-builder /app/apps/console/public /console/apps/console/public

# Copy slackdump binary (AGPL-3.0, v4.4.2) from builder stage.
# Binary required by Slack connector; upstream: https://github.com/rusq/slackdump/blob/v4.4.2
COPY --from=slackdump-builder /build/slackdump /usr/local/bin/slackdump
COPY --from=slackdump-builder /build/LICENSE /usr/local/share/slackdump/LICENSE.agpl-3.0.txt
COPY --from=slackdump-builder /build/SOURCE_URL /usr/local/share/slackdump/SOURCE_URL

# Verify slackdump is executable and functional
RUN chmod +x /usr/local/bin/slackdump && /usr/local/bin/slackdump version

# Copy sigtop binary (ISC, v0.24.0) from builder stage.
# Binary required by the Signal connector; upstream: https://github.com/tbvdm/sigtop
COPY --from=sigtop-builder /build/sigtop /usr/local/bin/sigtop
COPY --from=sigtop-builder /build/LICENSE /usr/local/share/sigtop/LICENSE.isc.txt
COPY --from=sigtop-builder /build/SOURCE_URL /usr/local/share/sigtop/SOURCE_URL

# Verify sigtop is present and executable. The Signal connector shipped
# registered and rostered while this binary was absent from the image
# entirely, so the row rendered health for a collector that could never run.
# Fail the build here rather than discover it from a dead source.
#
# libsecret is a RUNTIME dependency too, not only a build one. sigtop links
# against it dynamically to read Signal Desktop's encrypted database key from
# the OS keyring, so the shared library must exist in the final image — the
# `-dev` package in the builder stage supplies headers for the cgo compile and
# nothing at all here.
#
# This was caught by running the binary in the built image, NOT by the build:
# `test -x` passed on an executable that could not load
# (`libsecret-1.so.0: cannot open shared object file`). A presence check is not
# a liveness check, and the whole reason this stage exists is that Signal
# shipped for weeks against a binary that was not there.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 \
  && rm -rf /var/lib/apt/lists/*

# `ldd` proves every shared object RESOLVES, then a bare invocation proves the
# binary actually loads and reaches its own usage text. Presence alone is not
# liveness — `test -x` passed on a binary that could not load at all. No real
# subcommand is run: each needs a Signal Desktop directory absent at build time.
RUN chmod +x /usr/local/bin/sigtop \
  && test -x /usr/local/bin/sigtop \
  && ! ldd /usr/local/bin/sigtop | grep -q "not found" \
  && /usr/local/bin/sigtop 2>&1 | grep -qiE "usage|command"

EXPOSE 3000

CMD ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"]

# Public platform-neutral self-host artifact. Core is the browser-capable
# default; core-browser remains only as a build/backward-compatibility alias.
FROM core-browser AS core

# Keep the historical Railway target available for old source-build references.
FROM core AS railway-core

# Generic managed-platform alias for Fly and other source-build paths.
FROM core AS platform-core
