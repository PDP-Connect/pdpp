# PDPP

PDPP is a protocol and reference implementation for user-controlled, purpose-bound access to personal data.

This repository contains three primary layers:

- **Normative PDPP specs** at the repo root in `spec-*.md`
- **Forkable reference implementation** in [`reference-implementation/`](reference-implementation/README.md)
- **Public docs and illustrated surfaces** in `apps/site/`, and the **operator console** in `apps/console/`

## Repository guide

### Protocol specs

The root `spec-*.md` files are the normative protocol documents.

Start with:

- [`spec-core.md`](spec-core.md)
- [`spec-collection-profile.md`](spec-collection-profile.md)
- [`spec-architecture.md`](spec-architecture.md)
- [`spec-reference-implementation-examples.md`](spec-reference-implementation-examples.md)

### Reference implementation

The current executable reference lives in [`reference-implementation/`](reference-implementation/README.md).

It includes:

- authorization server and resource server
- Collection Profile runtime
- CLI
- manifests and sample connector paths
- black-box integration and conformance-style tests

The reference currently proves one shared substrate with two honest realizations:

- public source identity is `source: { kind: "provider_native" | "connector", id: string }`

Legacy docs may call `source.id` a `provider_id` for native providers or a `connector_id` for polyfill connectors.

### Website and console

The public site and the operator console are two separate apps after the
split (`openspec/changes/split-public-site-and-operator-console`).

The **public site** lives in `apps/site/` and is deployable without any
reference-implementation runtime. It renders:

- `/docs` for protocol docs plus clearly labeled reference notes
- `/reference` for the public reference-implementation explainer and coverage matrix
- `/sandbox` for the mock-owner reference dashboard backed by deterministic fictional data
- `/planning` for OpenSpec project planning artifacts
- `/design` and `/palette` for local contributor workbench surfaces

The **operator console** lives in `apps/console/` and is deployed alongside a
self-hosted reference instance. It renders `/dashboard` for a running local or
self-hosted reference instance and hosts the BFF/proxy to the AS/RS.

The public site is a downstream consumer of the protocol and reference docs,
not the implementation boundary itself, and never serves live owner state. The
operator console is the live-instance operator surface, not protocol
documentation.

## Quick start

Run the default contributor stack (operator console + reference AS/RS):

```bash
pnpm dev
```

`pnpm dev` boots the reference AS/RS (`:7662` / `:7663`) plus the operator
console (`apps/console`), the default workflow for work that touches reference
behavior or the console. For the docs/marketing surface, run `pnpm site:dev`
(boots `apps/site` only, mock-backed, no AS/RS). To boot reference + console +
site together for cross-surface link checks, run `pnpm dev:full`. Semantic
retrieval uses a local Transformers.js embedding model by default; the first
semantic backfill may download model files into
`reference-implementation/.cache/transformers` while the servers are already
listening.

Run the same live reference stack from public Docker images:

```bash
cp .env.docker.example .env.docker
# edit .env.docker and set PDPP_OWNER_PASSWORD for a protected dashboard
docker compose --env-file .env.docker pull
pnpm docker:reference:quick
```

Owner sessions are finite signed cookies. The default placeholder session lasts
7 days to avoid interrupting long-running personal dashboard operation; set
`PDPP_OWNER_SESSION_TTL_SECONDS` to a positive number of seconds to shorten or
extend that tradeoff for a deployment.

To connect ChatGPT, Claude, or another remote MCP client to a self-hosted
reference instance, use the hosted MCP runbook:
[`docs/operator/hosted-mcp-setup.md`](docs/operator/hosted-mcp-setup.md).

Then open `http://localhost:3002`. The Compose stack keeps the browser-facing
origin on host `:3002` by default and runs the reference AS/RS internally as the same AS
`:7662` / RS `:7663` process pair used by local development. Secrets belong in
runtime env or `.env.docker`; they are not baked into the images.

The `web` service waits for `reference` to be healthy before starting, so the
first dashboard request never races the AS/RS listeners. "Healthy" means the AS
is serving public OAuth metadata on `:7662` and the RS is serving protected
resource metadata on `:7663`; the embedding-model download and semantic backfill
continue in the background after the stack reports healthy and are intentionally
not gated. Expect the first `up` to spend up to ~30s in `starting` while
`reference` boots — `docker compose ps` shows the live state.

Default public images:

- `ghcr.io/vana-com/pdpp/reference:main`
- `ghcr.io/vana-com/pdpp/web:main`

`main` is a moving default-branch build. Stable semantic-release images are
published as exact version tags such as `1.2.3`, moving minor-series tags such
as `1.2`, and `latest`. For durable self-hosting, prefer an exact version,
`sha-*` tag, or digest pin over a moving tag. To build from local source
instead of pulling public images, run:

```bash
pnpm docker:reference:up
```

#### Postgres service (profile-gated)

The Compose file ships an optional `postgres` service gated behind the
`postgres` profile. It backs env-gated conformance/runtime proofs such as
`reference-implementation/test/connector-state-scheduler-conformance-postgres.test.js`
and
`reference-implementation/test/consent-device-auth-conformance-postgres.test.js`,
plus `reference-implementation/test/postgres-runtime-storage.test.js`. The
default reference runtime uses SQLite; `reference` and `web` do **not** depend on
this service unless Postgres runtime storage is explicitly selected.

Postgres runtime mode is opt-in and fresh-storage only:

```bash
PDPP_STORAGE_BACKEND=postgres
PDPP_DATABASE_URL=postgres://pdpp:pdpp@localhost:55432/pdpp_proof
```

This does not migrate an existing SQLite database. Leave
`PDPP_STORAGE_BACKEND` unset for the default SQLite behavior.

The expected image is `pgvector/pgvector:pg16`. Runtime bootstrap enables the
`vector` extension on that path. If a custom Postgres image lacks pgvector, the
reference falls back to grant-scoped JSONB vector storage as a degraded
compatibility path, not the normal production configuration.

The service binds to loopback only by default (`127.0.0.1:55432`) and ships
with default `pdpp/pdpp` credentials, so it is reachable only from the host
running Docker. LAN/WAN exposure requires deliberately overriding
`PDPP_POSTGRES_BIND_HOST` **and** changing `PDPP_POSTGRES_USER` /
`PDPP_POSTGRES_PASSWORD` to non-default values; do not do one without the
other.

```bash
# Start just the proof service. Default host port is 55432 to avoid
# colliding with operator-installed Postgres on 5432; override with
# PDPP_POSTGRES_PORT in .env.docker. The default bind is 127.0.0.1 only.
docker compose --profile postgres --env-file .env.docker up -d postgres

# Run the env-gated Postgres proofs against it.
PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55432/pdpp_proof \
  node --test --test-force-exit \
  reference-implementation/test/connector-state-scheduler-conformance-postgres.test.js \
  reference-implementation/test/consent-device-auth-conformance-postgres.test.js \
  reference-implementation/test/postgres-runtime-storage.test.js

# Stop and remove only the proof service when done.
docker compose --profile postgres --env-file .env.docker stop postgres
docker compose --profile postgres --env-file .env.docker rm -f postgres
```

A default `docker compose up` does not start the `postgres` service.

For Docker-based development with hot reload:

```bash
pnpm docker:dev
```

That uses `docker-compose.dev.yml` to bind-mount the repo, run the reference
server under Node watch mode, and run the operator console (`apps/console`) with
Next dev behind host `:3002` by default. The `web` service (now publishing the
console app) still listens on `:3000` internally; the service name is retained
to preserve the existing compose override and `PDPP_WEB_*` env-var contracts.
Use the default Compose command above or `pnpm docker:smoke` when you want the
production-style Docker path instead.

For host-based development with `pnpm run dev`, the launcher picks the first
available web port starting at `3000`, exports it to both Next dev and the
reference server, and prints the resulting browser-facing origin. Set
`PDPP_WEB_PORT=3002` when you need a fixed port. The dev proxy auto-allows
loopback, private LAN, link-local, and CGNAT IPv4 interface addresses reported
by the OS. If you access the dev server through a custom DNS name or reverse
proxy, set `PDPP_WEB_ALLOWED_DEV_ORIGINS` explicitly.

Local repo shells do not put the workspace `pdpp` binary on PATH by default.
When dashboard or docs copy shows a command such as
`pdpp ref run timeline <run-id>`, run it from this repo as:

```bash
pnpm exec pdpp ref run timeline <run-id>
```

Use the bare `pdpp ...` spelling only after installing `@pdpp/cli` from npm or
linking the workspace binary into your shell PATH.

When accessing Docker dev through a LAN IP or reverse proxy, add the browser
hostnames to `PDPP_WEB_ALLOWED_DEV_ORIGINS` in `.env.docker`, for example:

```bash
PDPP_WEB_ALLOWED_DEV_ORIGINS=pdpp-dev.example.test,192.168.0.2
```

Reverse proxies must also forward WebSocket upgrade traffic for
`/_next/webpack-hmr`; otherwise the page loads but Next HMR cannot connect.

#### Local collectors and browser-backed connectors in Docker

Connectors like ChatGPT and USAA need a real browser the operator can see and
click for login, OTP, or Cloudflare challenges. The provider/control-plane
container cannot render a visible browser; those connectors must run in a
**workspace local collector runner** on a host the operator can see, paired to
the provider via device-scoped enrollment. See
`openspec/changes/introduce-local-collector-runner/design.md` for the full
design.

The public `@pdpp/local-collector@beta` package currently ships only the
filesystem-class Claude Code and Codex collectors. Browser/Patchright-backed
connectors remain in the monorepo runner until each has its own publishability
review.

```bash
# Claude Code / Codex from any host with Node 22.14+:
npx -y @pdpp/local-collector@beta advertise
npx -y @pdpp/local-collector@beta enroll \
  --base-url http://localhost:7662 \
  --code <enrollment-code-from-provider>

# Browser-backed connectors from a checkout of this repo on the operator's host:
pnpm install
pnpm exec pdpp collector advertise
pnpm exec pdpp collector enroll \
  --base-url http://localhost:7662 \
  --code <enrollment-code-from-provider>

# The collector prints a device id + token; persist them somewhere safe.
PDPP_LOCAL_DEVICE_ID=<id> PDPP_LOCAL_DEVICE_TOKEN=<token> \
PDPP_CONNECTION_ID=<source-instance> \
pnpm exec pdpp collector run \
  --base-url http://localhost:7662 \
  --connector chatgpt
```

`pdpp collector ...` is a thin `@pdpp/cli` shim. In a monorepo checkout it
prefers `packages/polyfill-connectors/bin/collector-runner.ts` so development
and browser-backed connector work can use workspace-only dependencies. Outside
the repo it resolves an installed `@pdpp/local-collector` package; until npm
`latest` is intentionally promoted, install that package as
`@pdpp/local-collector@beta`.

When a HEADED browser-backed connector is attempted inside the
provider/control-plane container, headed acquisitions fail closed before
spawn with `headed_browser_unavailable` — launching an invisible
in-container Chromium for an interactive flow would silently hang on the
operator's `auto-login` handshake. Headless container acquisitions are
unaffected. The escape hatch for explicit X11/VNC debugging is
`PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`, which emits a per-acquisition
warning.

Current Docker connector-support posture:

| Connector(s) | Docker posture | Operator requirement | Current caveat |
| --- | --- | --- | --- |
| YNAB, GitHub, Notion, Oura, Strava, Gmail | API-shaped; supported in Docker. | Provide the connector's token/PAT/IMAP credentials through `.env.docker`, shell env, or Docker secrets. | Some connectors are maintainer-verified live; others are code-ready and unverified — see `packages/polyfill-connectors/CONNECTORS.md`. Connector correctness is still subject to live upstream behavior and each connector's declared stream contract. |
| Slack | Subprocess-shaped; **not supported in the stock reference image**. | Slack's connector spawns the `slackdump` binary, which is AGPL-3.0 and is intentionally **not** bundled. To run Slack in Docker, build a derived image that installs `slackdump` (or mount it in) and set `SLACKDUMP_BIN` to its in-container path. | Stock `ghcr.io/vana-com/pdpp/reference` images cannot run the Slack connector as published. |
| OpenAI Codex CLI, Claude Code | Filesystem-only; supported in same-host Docker when host agent state is mounted read-only. | Point `PDPP_DOCKER_CLAUDE_CODE_HOME` and `PDPP_DOCKER_CODEX_HOME` at `${HOME}/.claude` and `${HOME}/.codex` (or any host directory holding those layouts). The compose file already mounts them read-only to `/imports/claude` and `/imports/codex` and sets `CLAUDE_CODE_HOME` / `CLAUDE_CODE_PROJECTS_DIR` / `CODEX_HOME` accordingly. | Default Compose seeds those host overrides to `./packages/polyfill-connectors/.pdpp-imports/{claude,codex}` (empty on a fresh checkout); the source-preflight will fail until the host paths are set. Multi-device collection belongs to the proposed `design-local-device-exporter-collection` topology. |
| WhatsApp, Google Takeout, Twitter archive, Apple Health, iCal | Filesystem-only; supported in Docker via the `pdpp-home` named volume. | Drop extracted exports into the volume at `/root/.pdpp/imports/<connector>/`, or override the connector-specific `*_DIR` env var. iCal also accepts `ICAL_SUBSCRIPTION_URL` (pure HTTP, no mount needed). | Defaults already point at `~/.pdpp/imports/<connector>/` which the named volume covers; `docker cp` or a one-time bind-mount is the simplest way to seed the volume. |
| iMessage | Filesystem-only; **not supported in Linux Docker**. | iMessage is hardcoded to `~/Library/Messages/chat.db` (macOS-format SQLite). | Effectively macOS-only; runs on the host, not in Linux containers. |
| Amazon, Chase, ChatGPT, Reddit, USAA + scaffolded browser-scrapers (Anthropic, Shopify, HEB, Whole Foods, LinkedIn, Meta, Loom, Uber, DoorDash) | Browser-backed; Docker needs the workspace local collector runner on a visible-browser host. | Pair the workspace collector with `pnpm exec pdpp collector enroll`, then run connectors via `pnpm exec pdpp collector run`. | These connectors are not in `@pdpp/local-collector@beta` yet. Inside the provider/control-plane container, headed-browser acquisitions fail closed with `headed_browser_unavailable` (`packages/polyfill-connectors/src/browser-launch.ts:decideContainerHeadedBrowserGate`); browser-backed connectors must run in a local runtime that advertises a `browser` binding. The four "verified" entries are end-to-end maintainer-verified; the rest are scaffolded and need DOM selectors before they're usable. |
| Spotify, Pocket | Blocked upstream. | n/a | Spotify's OAuth app registration is frozen as of Feb 2026; Pocket sunset 2025-07-08. |

CI builds Docker targets on pull requests without pushing images. On `main`,
semantic-release creates GitHub releases from Conventional Commits and the same
release workflow publishes npm beta packages plus stable GHCR tags for both
Docker targets. Maintainers should make the first published GHCR packages
public in GitHub's package settings if the registry creates them private.

Run the reference implementation server:

```bash
pnpm reference-implementation:server
```

Inspect the reference CLI:

```bash
pnpm reference-implementation:cli --help
```

Run the reference implementation tests:

```bash
pnpm reference-implementation:test
```

## Releases

Releases are automated with semantic-release on `main`. Commit messages follow
Conventional Commits: `fix:` creates a patch release, `feat:` creates a minor
release, and breaking changes create a major release.

Preview the next release locally:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm release:dry-run
```

The release workflow validates generated reference-contract artifacts, verifies
the reference implementation, typechecks the web app, publishes the npm package
release train, builds both Docker image targets, creates the GitHub release and
`v${version}` tag, then publishes:

- `@pdpp/cli@beta`
- `@pdpp/local-collector@beta`

- `ghcr.io/vana-com/pdpp/reference:${version}`
- `ghcr.io/vana-com/pdpp/reference:${major}.${minor}`
- `ghcr.io/vana-com/pdpp/reference:latest`
- `ghcr.io/vana-com/pdpp/reference:sha-*`
- matching `web` tags

Release automation uses GitHub Actions credentials for GitHub releases and
GHCR, and npm trusted publishing for public packages. It must not bundle
`.env.local`, owner passwords, connector credentials, SQLite data, model cache
files, or browser profiles into images.

## Authority order

This repo uses a strict authority order:

1. **Root PDPP specs** define normative protocol semantics.
2. **Code and tests** define what the current reference implementation actually does.
3. **OpenSpec** defines project-level architecture and change planning.

Public web spec pages are downstream copies of the root specs. `pnpm spec:check`
enforces parity, with only explicitly allowlisted web-only extension specs and
reference-only root examples exempt from one-to-one pairing.

OpenSpec in this repo is intentionally project-scoped. It does not replace or compete with the normative PDPP specs.

## OpenSpec

OpenSpec artifacts live in `openspec/`.

Current durable OpenSpec specs include:

- `reference-implementation-governance`
- `reference-implementation-architecture`

Use OpenSpec here for:

- reference-implementation architecture
- project-level boundary decisions
- multi-step implementation changes

Do not use it as a second copy of the PDPP protocol spec.
