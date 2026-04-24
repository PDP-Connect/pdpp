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

The reference service runs `node --watch reference-implementation/server/index.js`.
The web service runs Next dev on `0.0.0.0:3000`. Compose still supplies the same
public/internal URL topology as the production stack.

## Non-Goals

- Do not make dev mode the default Docker path.
- Do not optimize image size.
- Do not guarantee browser connector anti-bot behavior improves in dev mode.

## Acceptance Checks

- `docker compose -f docker-compose.yml -f docker-compose.dev.yml config`
  succeeds.
- README documents the dev command and the distinction from smoke/production
  Compose.
