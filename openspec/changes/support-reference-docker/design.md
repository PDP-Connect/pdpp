## Context

The current reference stack runs locally through `pnpm dev`: the reference server starts one AS/RS process with AS on `:7662` and RS on `:7663`, while the Next web app presents the browser-facing origin on `:3000` and proxies protocol plus reference-only routes in composed mode.

The repo has archived demo Docker artifacts, but no current Docker/Compose support for the live reference implementation. Existing research and architecture notes already say Docker Compose is a good assembly mechanism, but it must not become product behavior, a hidden control plane, or protocol authority.

Important current constraints:

- This is a pnpm `10.33.0` monorepo. Containers must install from the repo root with Corepack/pnpm, not run per-package `npm install`.
- Use Debian/Ubuntu Node images, not Alpine. Native dependencies matter: `better-sqlite3`, `sqlite-vec`, browser automation dependencies, and `node:sqlite` usage. Node 25.x matches local development; Node 22.5+ is the minimum for `node:sqlite`.
- The reference server is AS+RS in one process. The browser-facing web app is a separate process.
- In composed mode, `PDPP_REFERENCE_ORIGIN` is the external URL the browser uses, not an internal Docker service URL.
- Containers must not use `localhost` to call each other. Split services need internal URLs such as `PDPP_AS_URL=http://reference:7662` and `PDPP_RS_URL=http://reference:7663`, while `PDPP_REFERENCE_ORIGIN` stays browser-facing.
- SQLite data, embedding model cache, connector/browser session state, and optional local connector inputs need persisted volumes.
- Secrets must come from env, `env_file`, or Docker secrets. `.env.local` remains a local dev convenience, not the production posture.
- First boot may download the MiniLM model unless downloads are disabled and the cache is prewarmed.
- Browser connectors are operationally messy: persistent profiles and upstream anti-bot behavior are part of the honest story, not a clean-room demo.

## Goals / Non-Goals

**Goals:**

- Provide a supported Docker Compose path for the current live reference stack.
- Keep `pnpm` workspace installation and builds faithful to local development.
- Make internal service URLs and external browser-facing URLs explicit and hard to confuse.
- Persist the state needed for real reference operation: SQLite DB, semantic model cache, owner/browser connector state, and optional connector inputs.
- Keep secrets out of images and document the expected secret injection posture.
- Add a smoke check that proves the Docker stack reaches the same reference surfaces as local `pnpm dev`.

**Non-Goals:**

- Do not define PDPP protocol semantics through Docker.
- Do not turn Compose into a control plane or product surface.
- Do not build a production multi-tenant hosted PDPP deployment.
- Do not guarantee every browser connector works unattended in every container environment.
- Do not require Docker for normal local development or tests.

## Decisions

### 1. Build from the monorepo root with Corepack/pnpm

Use a root build context and Corepack-managed pnpm matching `packageManager: pnpm@10.33.0`. The Dockerfiles should install workspace dependencies once from the root lockfile and run workspace scripts.

Alternative considered: package-local Dockerfiles with `npm install` inside `apps/web` or `reference-implementation`. That would diverge from the workspace dependency graph, miss workspace packages such as `@pdpp/reference-contract` and `@pdpp/brand`, and reproduce a different system from the one reviewers run locally.

### 2. Use Debian/Ubuntu Node images

Use a Debian/Ubuntu-based Node image, preferably Node 25.x to match local. Node 22.5+ is the minimum floor because `node:sqlite` support matters to the broader stack. Alpine is out of scope for the first supported Docker path.

Alternative considered: Alpine for smaller images. That is a poor first target because native modules and browser automation dependencies are more important than image size for this reference.

### 3. Compose the same two-process reference product

Use Compose to start:

- `reference`: the AS/RS process, listening on `7662` and `7663`.
- `web`: the Next app, listening on `3000`, browser-facing, and proxying the AS/RS through the existing composed topology.

The default composed env should set:

- `PDPP_REFERENCE_MODE=composed`
- `PDPP_REFERENCE_ORIGIN=<browser-facing URL, usually http://localhost:3000>`
- `PDPP_AS_URL=http://reference:7662`
- `PDPP_RS_URL=http://reference:7663`

The public metadata and device/consent URLs should use `PDPP_REFERENCE_ORIGIN`. Container-to-container fetches should use `PDPP_AS_URL` and `PDPP_RS_URL`.

Implementation choice: use one root `Dockerfile` with separate `reference` and
`web` targets. This keeps build mechanics shared while producing service-
specific runtime images for Compose.

Validation facts learned during implementation:

- The Node 25 Bookworm image used for validation did not expose `corepack` on
  `PATH`, while still carrying package-manager shims such as `yarn`; the
  Dockerfile force-installs Corepack before preparing `pnpm@10.33.0`.
- The reference image must run the server entrypoint directly with
  `node reference-implementation/server/index.js`. The shorter
  `pnpm --dir reference-implementation server` form invokes pnpm's own
  `server` command and exits without starting the AS/RS process, while the
  local-dev package script emits an expected but confusing `.env.local` warning
  inside Docker.
- Native module validation loaded `better-sqlite3` and `sqlite-vec` inside the
  reference image, with `sqlite-vec` reporting `v0.1.9`.
- Composed-origin validation caught the dashboard sidebar rendering the
  internal AS/RS probe URLs. The dashboard now still probes internal URLs
  server-side, but renders the browser-facing reference origin in the endpoint
  footer.
- Docker defaults bind-mount the existing repo-local
  `packages/polyfill-connectors/.pdpp-data/` directory and use
  `/var/lib/pdpp/pdpp.sqlite`, matching the renamed host DB
  `packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`. The smoke script
  overrides `PDPP_DB_PATH` to a throwaway `/tmp/pdpp-smoke.sqlite` so smoke
  validation does not mutate the owner's local data.

Alternative considered: one container running both processes. That may be useful later, but split services keep the current architecture visible and avoid inventing a process supervisor for the first cut.

### 4. Persist operational state by default

Compose should define named volumes or documented bind mounts for:

- the SQLite DB location, either `packages/polyfill-connectors/.pdpp-data/` or an explicit `PDPP_DB_PATH`
- `reference-implementation/.cache/transformers` or `PDPP_EMBEDDING_CACHE_DIR`
- `~/.pdpp/` for browser profiles, daemon files, and connector session state
- optional host paths for Slack archives or local connector input files when testing those connectors

First boot may be slow because the default local semantic backend can download MiniLM model files. Operators can either persist the cache, prewarm the cache, or set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` and accept the resulting diagnostic warning if the model is absent.

### 5. Treat secrets as runtime configuration

The Docker artifacts must not bake `PDPP_OWNER_PASSWORD`, connector passwords, tokens, cookies, or DCR initial access tokens into image layers. Local Compose can use `env_file` for convenience, but docs should label it as secret-bearing local configuration and keep `.env.local` framed as development convenience.

### 6. Validate with a Docker smoke path

Add a script or documented command sequence that builds and starts the stack, then verifies:

- the web app responds on the browser-facing origin
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` route through the web origin in composed mode
- AS/RS metadata does not leak internal Docker service URLs in public browser-facing fields
- `/dashboard/deployment` is reachable after owner auth is satisfied or honestly redirects to `/owner/login` when `PDPP_OWNER_PASSWORD` is set

This smoke path must not require real third-party connector credentials.

## Risks / Trade-offs

- Native module build failures -> Use Debian/Ubuntu Node images, root pnpm install, and CI smoke coverage.
- Browser connector flakiness -> Document that browser connectors depend on persistent profiles and upstream anti-bot behavior; smoke tests should not depend on real browser connector credentials.
- URL confusion between browser and container networks -> Keep `PDPP_REFERENCE_ORIGIN` and `PDPP_AS_URL` / `PDPP_RS_URL` distinct in docs, defaults, and smoke assertions.
- Secret leakage through images or diagnostics -> Use env/runtime injection only and keep deployment diagnostics redacted.
- First boot model download surprises -> Persist the embedding cache and document download/prewarm/disable options.
- Compose becoming architectural truth -> Keep Compose docs framed as assembly only and continue to make CLI/tests consume real reference surfaces.

## Migration Plan

1. Add root Docker ignore/build context hygiene.
2. Add Dockerfile(s) using Debian/Ubuntu Node, Corepack, and root pnpm install.
3. Add Compose services for `reference` and `web` with explicit internal and browser-facing URL env.
4. Add persistent volumes and example env file template.
5. Add smoke script/checks for composed metadata and dashboard owner-auth behavior.
6. Update README/reference docs with Docker startup, volume, secret, and browser connector caveats.
7. Leave archived demo Docker files untouched unless docs currently point to them as current live support.

Rollback is straightforward: remove the new Compose path and docs. The change does not alter protocol behavior or require data migration.

## Open Questions

- Should the shared root Dockerfile eventually split into independently optimized Dockerfiles if image size or build time becomes a problem?
- Should Playwright/Patchright browser dependencies ship in the default image, or should browser connectors get a separate heavier profile?
- Should CI run the full Docker smoke by default, or only on demand until image build time is acceptable?
