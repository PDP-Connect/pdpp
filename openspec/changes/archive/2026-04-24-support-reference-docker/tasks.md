## 1. Container Build Foundation

- [x] 1.1 Add root Docker ignore/build-context hygiene so images exclude local databases, caches, worktrees, and secret env files while retaining workspace packages needed for builds.
- [x] 1.2 Add Debian/Ubuntu Node-based Dockerfile support that uses Corepack and pnpm `10.33.0` from the repo root.
- [x] 1.3 Verify native dependencies install/load in the container image, including `better-sqlite3` and `sqlite-vec`.
- [x] 1.4 Decide whether the first cut uses one shared image or separate `reference` and `web` images; record the decision in `design.md` if implementation facts differ from the proposal.

## 2. Compose Topology

- [x] 2.1 Add a Docker Compose file for the live stack with `reference` and `web` services.
- [x] 2.2 Configure `reference` to run the AS/RS process with AS on `7662` and RS on `7663`.
- [x] 2.3 Configure `web` to run the browser-facing app on `3000`.
- [x] 2.4 Configure composed-mode env so `PDPP_REFERENCE_ORIGIN` is browser-facing while `PDPP_AS_URL` and `PDPP_RS_URL` point to internal Docker service URLs.
- [x] 2.5 Ensure public metadata, device verification URLs, and pending-consent URLs use the browser-facing origin, not Docker service names.

## 3. Persistence And Secrets

- [x] 3.1 Add named volumes or documented bind mounts for the SQLite DB path.
- [x] 3.2 Add named volumes or documented bind mounts for the Transformers embedding model cache.
- [x] 3.3 Add named volumes or documented bind mounts for `~/.pdpp/` browser profiles, daemon files, and connector session state.
- [x] 3.4 Add an example env file template that lists required and common optional vars without secret values.
- [x] 3.5 Ensure Dockerfiles and committed Compose defaults do not bake owner passwords, connector credentials, tokens, cookies, or DCR secrets into image layers.

## 4. Documentation

- [x] 4.1 Update README/reference docs with Docker quick start, ports, and expected entry URL.
- [x] 4.2 Document the internal-vs-browser URL rule with examples for local `localhost` and container service DNS.
- [x] 4.3 Document first-boot MiniLM download behavior, cache prewarming, and `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0`.
- [x] 4.4 Document browser connector caveats: persistent profiles, upstream anti-bot behavior, and optional host mounts for local connector inputs.
- [x] 4.5 Remove or relabel any current docs that imply archived demo Docker files are the supported live stack.

## 5. Smoke Validation

- [x] 5.1 Add a script or documented command that builds and starts the Docker stack.
- [x] 5.2 Check that `http://localhost:3000` responds through the web service.
- [x] 5.3 Check that `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` are reachable through the browser-facing origin.
- [x] 5.4 Check that browser-facing metadata does not expose internal Docker service names.
- [x] 5.5 Check dashboard owner-auth behavior with `PDPP_OWNER_PASSWORD` configured: unauthenticated access redirects to `/owner/login` or authenticated access succeeds.

## 6. Acceptance Checks

- [x] 6.1 Run the focused Docker smoke validation from a clean checkout state.
- [x] 6.2 Run `cd reference-implementation && node --test --test-force-exit test/deployment-diagnostics.test.js` or the equivalent focused reference diagnostic test after env/diagnostic changes.
- [x] 6.3 Run `openspec validate support-reference-docker --strict`.
- [x] 6.4 Update this task list and `design.md` with any implementation facts learned during Docker validation.
