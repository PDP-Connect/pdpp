## 1. Compose Dev Overlay

- [x] 1.1 Add `docker-compose.dev.yml` with source bind mounts and dev commands.
- [x] 1.2 Preserve container dependency installs with named `node_modules` volumes.
- [x] 1.3 Keep Docker public/internal URL defaults consistent with the base Compose file.
- [x] 1.4 Load repo-root `.env.local` in Docker dev for reference connector credentials.

## 2. Scripts And Docs

- [x] 2.1 Add a root script for the Docker dev command.
- [x] 2.2 Document Docker dev hot reload in README/reference docs.
- [x] 2.3 Ensure `.gitignore` allows the dev Compose file.
- [x] 2.4 Add configurable Next dev origins for LAN/reverse-proxy HMR.

## 3. Acceptance Checks

- [x] 3.1 Run `docker compose -f docker-compose.yml -f docker-compose.dev.yml config`.
- [x] 3.2 Run `openspec validate add-docker-dev-hot-reload --strict`.
- [x] 3.3 Run web type checking for the dev-origin and run-detail UI changes.
