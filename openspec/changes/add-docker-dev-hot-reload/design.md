## Context

The supported Docker stack builds production-style images for reproducibility.
For development, operators need a separate mode that trades reproducibility for
fast feedback: source bind mounts, dev servers, and file watching.

## Decisions

### 1. Use a Compose override

Add `docker-compose.dev.yml` rather than changing the default
`docker-compose.yml`. The default remains the smoke/reviewer path; the dev
override is opt-in.

### 2. Preserve container dependencies in named volumes

Bind-mounting `.` over `/app` would hide image-installed `node_modules`. The dev
override mounts named volumes at `/app/node_modules`, `/app/apps/web/node_modules`,
and workspace package `node_modules` paths so dependencies stay inside Docker
while source files hot reload from the host.

### 3. Run real dev servers

The reference service runs
`node --env-file-if-exists=.env.local --watch reference-implementation/server/index.js`.
Loading the repo-root `.env.local` is development-only and keeps local connector
credentials such as `GITHUB_PERSONAL_ACCESS_TOKEN` available to
controller-managed runs. The production/public-image path continues to use
runtime env, env files, or Docker secrets instead.

The web service runs Next dev on `0.0.0.0:3000`. Compose still supplies the same
public/internal URL topology as the production stack.

### 4. Make external dev origins explicit

Next dev blocks internal resources such as `/_next/webpack-hmr` from unlisted
non-local origins. The web app reads comma-separated hostnames from
`PDPP_WEB_ALLOWED_DEV_ORIGINS` and maps them to Next's `allowedDevOrigins`.
Reverse proxies still need to forward WebSocket upgrade traffic for HMR; this
knob only allows the origin once the WebSocket reaches Next.

## Non-Goals

- Do not make dev mode the default Docker path.
- Do not optimize image size.
- Do not guarantee browser connector anti-bot behavior improves in dev mode.
- Do not make `.env.local` part of the production Docker posture.

## Acceptance Checks

- `docker compose -f docker-compose.yml -f docker-compose.dev.yml config`
  succeeds.
- README documents the dev command and the distinction from smoke/production
  Compose.
- README documents `PDPP_WEB_ALLOWED_DEV_ORIGINS` and HMR WebSocket proxying.
