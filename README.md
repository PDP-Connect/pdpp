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

For durable self-hosting, prefer a release tag, `sha-*` tag, or digest pin over
the moving `main` tag. To build from local source instead of pulling public
images, run:

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

CI builds the Docker targets on pull requests and publishes public GHCR images
from trusted refs. Maintainers should make the first published GHCR packages
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
