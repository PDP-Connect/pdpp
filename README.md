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
- `/sandbox` for the mock-backed sandbox placeholder
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

Then open `http://localhost:3000`. The Compose stack keeps the browser-facing
origin on `:3000` and runs the reference AS/RS internally as the same AS
`:7662` / RS `:7663` process pair used by local development. Secrets belong in
runtime env or `.env.docker`; they are not baked into the images.

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

For Docker-based development with hot reload:

```bash
pnpm docker:dev
```

That uses `docker-compose.dev.yml` to bind-mount the repo, run the reference
server under Node watch mode, and run the web app with Next dev on `:3000`.
Use the default Compose command above or `pnpm docker:smoke` when you want the
production-style Docker path instead.

When accessing Docker dev through a LAN IP or reverse proxy, add the browser
hostnames to `PDPP_WEB_ALLOWED_DEV_ORIGINS` in `.env.docker`, for example:

```bash
PDPP_WEB_ALLOWED_DEV_ORIGINS=peregrine-dev.vivid.fish,192.168.1.180
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
  curl -sf "$PDPP_HOST_BROWSER_BRIDGE_URL"  # 404 is fine; UNREACHABLE is not
```

The bridge prints a Linux-specific warning when started with
`--bind-host=127.0.0.1`, with the exact `ip` invocation above. Binding to
`0.0.0.0` is supported via `--allow-public-bind` but exposes the bridge to
the LAN — prefer the bridge IP, which limits exposure to local containers.

When the bridge env vars are set but the bridge isn't reachable, runs fail
fast with `host_browser_bridge_unavailable` rather than waiting on an
invisible browser. When the env vars are unset, browser-backed Docker runs
behave as before (in-container Chromium). See
`openspec/changes/design-host-browser-bridge-for-docker/design.md` for the
full design.

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
