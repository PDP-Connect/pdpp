# PDPP

PDPP is a protocol and reference implementation for user-controlled, purpose-bound access to personal data.

This repository contains three primary layers:

- **Normative PDPP specs** at the repo root in `spec-*.md`
- **Forkable reference implementation** in [`reference-implementation/`](reference-implementation/README.md)
- **Docs and illustrated surfaces** in `apps/web/`

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

- **native provider** access identified publicly with `provider_id`
- **polyfill/connector** access identified publicly with `connector_id`

### Website and docs

The canonical site lives in `apps/web/`.

It renders:

- `/docs` for protocol docs plus clearly labeled reference notes
- `/reference` for the public reference-implementation explainer and coverage matrix
- `/sandbox` for the mock-owner reference dashboard backed by deterministic fictional data
- `/planning` for OpenSpec project planning artifacts
- `/dashboard` for a running local or self-hosted reference instance
- `/design` and `/palette` for local contributor workbench surfaces

The website is a downstream consumer of the reference implementation, not the implementation boundary itself. Hosted or
public docs should treat `/dashboard` as a live-instance operator surface, not protocol documentation.

## Quick start

Run the docs/site:

```bash
pnpm dev
```

The default dev stack starts the dashboard plus the reference AS/RS. Semantic
retrieval uses a local Transformers.js embedding model by default; the first
semantic backfill may download model files into
`reference-implementation/.cache/transformers` while the servers are already
listening.

Run the same live reference stack from public Docker images:

```bash
cp .env.docker.example .env.docker
# edit .env.docker and set PDPP_OWNER_PASSWORD for a protected dashboard
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

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
docker compose --env-file .env.docker up --build
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
server under Node watch mode, and run the web app with Next dev behind host
`:3002` by default. The web container still listens on `:3000` internally.
Use the default Compose command above or `pnpm docker:smoke` when you want the
production-style Docker path instead.

For host-based development with `pnpm run dev`, the launcher picks the first
available web port starting at `3000`, exports it to both Next dev and the
reference server, and prints the resulting browser-facing origin. Set
`PDPP_WEB_PORT=3002` when you need a fixed port. The dev proxy auto-allows
loopback, private LAN, link-local, and CGNAT IPv4 interface addresses reported
by the OS. If you access the dev server through a custom DNS name or reverse
proxy, set `PDPP_WEB_ALLOWED_DEV_ORIGINS` explicitly.

When accessing Docker dev through a LAN IP or reverse proxy, add the browser
hostnames to `PDPP_WEB_ALLOWED_DEV_ORIGINS` in `.env.docker`, for example:

```bash
PDPP_WEB_ALLOWED_DEV_ORIGINS=pdpp-dev.example.test,192.168.0.2
```

Reverse proxies must also forward WebSocket upgrade traffic for
`/_next/webpack-hmr`; otherwise the page loads but Next HMR cannot connect.

#### Browser-backed connectors in Docker

Connectors like ChatGPT and USAA need a real browser the operator can see and
click for login, OTP, or Cloudflare challenges. In Docker, those interactions
go through the host browser bridge — a small process that runs on the host,
owns a Patchright persistent context against `~/.pdpp/profiles/<name>/`, and
exposes its CDP endpoint to the container.

The bridge bind host depends on platform:

##### macOS / Windows Docker Desktop

`host.docker.internal` is forwarded to host loopback by Docker Desktop, so
the default 127.0.0.1 bind works:

```bash
# 1. Start the bridge for the target connector profile.
pnpm --dir packages/polyfill-connectors exec tsx \
  bin/host-browser-bridge.ts --profile chatgpt
# The bridge prints a URL+token. Export them into your Compose environment:
export PDPP_HOST_BROWSER_BRIDGE_URL=ws://host.docker.internal:7670
export PDPP_HOST_BROWSER_BRIDGE_TOKEN=<token-printed-by-bridge>

# 2. Start the stack as usual; ChatGPT runs will drive the host browser.
docker compose --env-file .env.docker up
```

##### Linux Docker

`host.docker.internal:host-gateway` resolves to the docker bridge gateway IP
(typically `172.17.0.1`), which is **not** host loopback. A 127.0.0.1-only
bind is unreachable from the container — verified empirically. Bind the
bridge to the docker bridge IP and tell the container to use that IP:

```bash
DOCKER_BRIDGE_IP=$(ip -4 addr show docker0 | awk '/inet /{print $2}' | cut -d/ -f1)

# 1. Start the bridge bound to the docker bridge IP.
pnpm --dir packages/polyfill-connectors exec tsx \
  bin/host-browser-bridge.ts --profile chatgpt --bind-host "$DOCKER_BRIDGE_IP"

# 2. The bridge prints the matching URL — use it directly:
export PDPP_HOST_BROWSER_BRIDGE_URL=ws://$DOCKER_BRIDGE_IP:7670
export PDPP_HOST_BROWSER_BRIDGE_TOKEN=<token-printed-by-bridge>

# 3. Verify the container can reach the bridge before running connectors:
docker run --rm --add-host=host.docker.internal:host-gateway \
  curlimages/curl:latest \
  curl -sf "http://$DOCKER_BRIDGE_IP:7670/"  # expects: pdpp-host-browser-bridge
```

The bridge prints a Linux-specific warning when started with
`--bind-host=127.0.0.1`, with the exact `ip` invocation above. Binding to
`0.0.0.0` is supported via `--allow-public-bind` but exposes the bridge to
the LAN — prefer the bridge IP, which limits exposure to local containers.

When the bridge env vars are set but the bridge isn't reachable, runs fail
fast with `host_browser_bridge_unavailable` rather than waiting on an
invisible browser. When the env vars are **unset** and the runtime detects
it's running in a container (`/.dockerenv`), headed-browser acquisitions
also fail closed with `host_browser_bridge_unavailable` — launching an
invisible in-container Chromium for an interactive flow would silently hang
on the operator's `auto-login` handshake. Headless container acquisitions
are unaffected. The escape hatch for explicit X11/VNC debugging is
`PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`, which emits a per-acquisition
warning. See
`openspec/changes/design-host-browser-bridge-for-docker/design.md` for the
full design.

Current Docker connector-support posture:

| Connector(s) | Docker posture | Operator requirement | Current caveat |
| --- | --- | --- | --- |
| YNAB, GitHub, Notion, Oura, Strava, Gmail | API-shaped; supported in Docker. | Provide the connector's token/PAT/IMAP credentials through `.env.docker`, shell env, or Docker secrets. | Some connectors are maintainer-verified live; others are code-ready and unverified — see `packages/polyfill-connectors/CONNECTORS.md`. Connector correctness is still subject to live upstream behavior and each connector's declared stream contract. |
| Slack | Subprocess-shaped; **not supported in the stock reference image**. | Slack's connector spawns the `slackdump` binary, which is AGPL-3.0 and is intentionally **not** bundled. To run Slack in Docker, build a derived image that installs `slackdump` (or mount it in) and set `SLACKDUMP_BIN` to its in-container path. | Stock `ghcr.io/vana-com/pdpp/reference` images cannot run the Slack connector as published. |
| OpenAI Codex CLI, Claude Code | Filesystem-only; supported in same-host Docker when host agent state is mounted read-only. | Add a local Compose override such as `${HOME}/.codex:/root/.codex:ro` and `${HOME}/.claude:/root/.claude:ro`; no extra env vars are needed because the connectors default to `~/.codex` and `~/.claude`. | Default Compose uses a named `pdpp-home` volume, which exposes `/root/.pdpp` but **not** `/root/.codex` or `/root/.claude`. Multi-device collection belongs to the proposed `design-local-device-exporter-collection` topology. |
| WhatsApp, Google Takeout, Twitter archive, Apple Health, iCal | Filesystem-only; supported in Docker via the `pdpp-home` named volume. | Drop extracted exports into the volume at `/root/.pdpp/imports/<connector>/`, or override the connector-specific `*_DIR` env var. iCal also accepts `ICAL_SUBSCRIPTION_URL` (pure HTTP, no mount needed). | Defaults already point at `~/.pdpp/imports/<connector>/` which the named volume covers; `docker cp` or a one-time bind-mount is the simplest way to seed the volume. |
| iMessage | Filesystem-only; **not supported in Linux Docker**. | iMessage is hardcoded to `~/Library/Messages/chat.db` (macOS-format SQLite). | Effectively macOS-only; runs on the host, not in Linux containers. |
| Amazon, Chase, ChatGPT, Reddit, USAA + scaffolded browser-scrapers (Anthropic, Shopify, HEB, Whole Foods, LinkedIn, Meta, Loom, Uber, DoorDash) | Browser-backed; Docker needs the host browser bridge for owner-visible login/challenge flows. | Start `host-browser-bridge.ts`, export the printed bridge URL/token, then run Compose. | When no bridge is configured, headed-browser acquisitions in a container fail fast with `host_browser_bridge_unavailable` rather than launching an invisible in-container Chromium (`packages/polyfill-connectors/src/browser-launch.ts:decideContainerHeadedBrowserGate`). The four "verified" entries are end-to-end maintainer-verified; the rest are scaffolded and need DOM selectors before they're usable. Future remote deployments may use a streamed-browser backend instead. |
| Spotify, Pocket | Blocked upstream. | n/a | Spotify's OAuth app registration is frozen as of Feb 2026; Pocket sunset 2025-07-08. |

CI builds Docker targets on pull requests without pushing images. On `main`,
semantic-release creates GitHub releases from Conventional Commits and the same
release workflow publishes stable GHCR tags for both Docker targets. Maintainers
should make the first published GHCR packages public in GitHub's package
settings if the registry creates them private.

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
the reference implementation, typechecks the web app, builds both Docker image
targets, creates the GitHub release and `v${version}` tag, then publishes:

- `ghcr.io/vana-com/pdpp/reference:${version}`
- `ghcr.io/vana-com/pdpp/reference:${major}.${minor}`
- `ghcr.io/vana-com/pdpp/reference:latest`
- `ghcr.io/vana-com/pdpp/reference:sha-*`
- matching `web` tags

Release automation uses GitHub Actions credentials for GitHub releases and
GHCR. It does not publish npm packages and must not bundle `.env.local`, owner
passwords, connector credentials, SQLite data, model cache files, or browser
profiles into images.

## Authority order

This repo uses a strict authority order:

1. **Root PDPP specs** define normative protocol semantics.
2. **Code and tests** define what the current reference implementation actually does.
3. **OpenSpec** defines project-level architecture and change planning.

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
