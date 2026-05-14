# PDPP Reference Implementation

This package is the forkable PDPP reference substrate in this repository.

It contains the current:

- authorization server and resource server
- Collection Profile runtime
- CLI
- reference manifests and sample connector
- executable black-box test suite

It is not the website. The website in `apps/web/` explains and showcases the reference implementation, but the runnable implementation lives here.

## What it proves today

The current provider-connect story is intentionally thin and honest. It proves:

- standards-based discovery via RFC 9728 protected-resource metadata and RFC 8414 AS metadata
- PAR-backed request staging through `POST /oauth/par`
- public-client self-registration through `POST /oauth/register`
- a consent shell and approval surface for issued grants
- owner self-export through the device flow
- pre-registered and dynamically registered client paths for the current third-party connect flow

It does **not** yet prove:

- a full generic third-party authorization-code redirect flow
- a broader ecosystem profile beyond the currently advertised metadata and `authorization_details` type

## What this package is proving

The current reference is centered on one architectural claim:

- one engine substrate can support both a **native provider** realization and a **polyfill/connector** realization
- public source identity stays honest:
  - `provider_id` for native providers such as `Northstar HR`
  - `connector_id` for collected/polyfill sources such as Spotify
- owner self-export, client grants, and reference-only traces can all be exercised against the same running system

## Package layout

- `server/`
  - authorization server, resource server, metadata, consent, grant issuance, introspection
- `runtime/`
  - Collection Profile runner and related runtime helpers
- `cli/`
  - `pdpp` CLI for owner login, export, provider inspection, grant staging, and trace/timeline inspection
- `manifests/`
  - sample connector manifests plus the native `northstar-hr` manifest
- `test/`
  - black-box integration, metadata, CLI, event-spine, and Collection Profile conformance tests
- `lib/`
  - shared implementation helpers such as the durable event spine

## Primary surfaces

### Discovery

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

Protected-resource metadata includes advisory agent discovery. The generated
CLI command is:

```bash
npx -y @pdpp/cli@beta connect <provider-url>
```

The no-owner-token completion path is beta but complete in the reference flow.
Metadata sets `pdpp_agent_discovery.cli.no_owner_token` true when the AS can
complete owner-approved scoped token handoff without asking for an owner bearer
token.

### Client request start

- `POST /oauth/par`

### Client registration

- `POST /oauth/register`

Dynamic client registration is enabled **by default**. Public clients can
self-register supported public-client metadata without an initial access token.
Registration creates only a public `client_id`; it does not grant data access or
mint bearer tokens.

Overrides:

- `PDPP_DCR_INITIAL_ACCESS_TOKENS=token1,token2` — comma-separated initial
  access tokens for optional operator/bootstrap registration. If a caller sends
  a bearer token, it must be one of these tokens; callers can omit the bearer
  token for public self-registration.
- `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` — explicitly disables DCR. The
  AS metadata then omits `registration_endpoint` and advertises only
  `pdpp_registration_modes_supported: ["pre_registered_public"]`.

Default pre-registered public clients seeded at startup include the real
first-party demo clients (`longview`, `longview_planning_v1`, `cli_longview`,
`concert_recommendation_app`) plus the dashboard/bootstrap clients
`pdpp-web-dashboard` and `pdpp-polyfill-owner-bootstrap` so owner device
bootstrap from the dashboard and the polyfill orchestrator works out of the
box. The pre-registered set is reference-local convenience; production
deployments should supply their own `preRegisteredPublicClients` option.

### Consent and grant issuance

- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`

The reference AS also exposes a stable owner-entry page at `GET /owner/login`.
It behaves as a small reference-only owner access hub:

- when `PDPP_OWNER_PASSWORD` is unset, it explains that placeholder auth is
  disabled and points operators at the hosted device approval UI
- when `PDPP_OWNER_PASSWORD` is set, it renders the owner sign-in form
- when already signed in, it becomes a signed-in landing page with device
  approval and sign-out actions

### Owner self-export

- `POST /oauth/device_authorization`
- `GET /device`
- `POST /device/approve`
- `POST /oauth/token`

### Resource access

- `/v1/streams/...`
- owner and client queries under the current reference contract

### Expandable records

`GET /v1/streams/:stream/records` and
`GET /v1/streams/:stream/records/:id` support `expand=<relation>` only when
the stream manifest declares the relation under both `relationships[]` and
`query.expand[]`. Relationship metadata is descriptive; `query.expand[]` is
the public allowlist.

Expansion is one hop, grant-safe, and bounded. Expanded child records are
authorized through the child stream grant and projected to the child fields the
caller can read. `has_many` children use `expand_limit[relation]`, returning a
list object with `data[]` and `has_more`. Missing `has_one` children return
`null`; missing `has_many` children return an empty list.

The first-party Gmail manifest enables `messages -> message_bodies` and
`messages -> attachments`. Gmail attachment expansion is metadata-only in this
slice: it does not expose bytes, `blob_ref`, extracted PDF/docx text, or blob
fetch access. Reverse/belongs-to expansion such as `messages -> thread` remains
deferred; clients can still query directly by the relevant foreign key.

### Filtered retrieval

`GET /v1/search` and `GET /v1/search/semantic` accept record-list compatible
`filter[...]` parameters only when the request names exactly one `streams`
value. Exact filters apply to authorized top-level scalar fields. Range filters
must be declared by the named stream under `query.range_filters`, so clients
should inspect stream metadata before sending `filter[field][gte|gt|lte|lt]`.

Cross-stream filtered search, public relevance scores/reranking, and
caller-controlled hybrid ranking are intentionally deferred.

### Semantic retrieval

`GET /v1/search/semantic` is an experimental optional extension. In normal
local operation (`pnpm run dev` or this package's `dev`/`server` scripts), the
reference uses a local Transformers.js embedding backend by default:

- backend mode: `PDPP_SEMANTIC_EMBEDDING_BACKEND=local`
- default profile: `PDPP_EMBEDDING_PROFILE_ID=minilm`
- default model: `Xenova/all-MiniLM-L6-v2`
- dimensions / metric: `384` / `cosine`
- default dtype: `PDPP_EMBEDDING_DTYPE=q4`
- default cache: `reference-implementation/.cache/transformers`

The first semantic backfill downloads model files unless
`PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` is set. Tests and programmatic `startServer`
calls keep the deterministic stub backend unless they opt into operational
defaults with `PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1`; the stub is only for
deterministic exact-match assertions and does not claim paraphrase or
multilingual behavior.

Operators can switch profiles without changing the public API:

- `PDPP_EMBEDDING_PROFILE_ID=minilm` — compact English-biased default.
- `PDPP_EMBEDDING_PROFILE_ID=multilingual-minilm` — multilingual MiniLM profile
  suitable for Italian-language data.
- `PDPP_EMBEDDING_MODEL_ID=...` — override the Hugging Face model ID.
- `PDPP_EMBEDDING_CACHE_DIR=...` — override the local model cache.
- `PDPP_SEMANTIC_EMBEDDING_BACKEND=stub|local|disabled` — force a backend mode.

Changing the profile/model/dtype/dimensions/metric invalidates existing
semantic vectors. The reference reports `index_state: "stale"` or `"building"`
and rebuilds from stored records; it does not require connector re-ingest.
Use `/dashboard/deployment` or `GET /_ref/deployment` to inspect backend
availability, cache state, active language bias, participating semantic fields,
and warnings such as zero participation or a rebuilding index.

For reference inspection, successful and route-level rejected `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/records`, and `/v1/streams/:stream/records/:id` responses also expose:

- `Request-Id`
- `PDPP-Reference-Trace-Id`

That pair lets a caller correlate a live query response to `GET /_ref/traces/:traceId` without widening the `_ref` surface itself.

### Reference-only debugging surfaces

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/dataset/summary`

These `_ref` endpoints are intentionally reference-only artifacts, not core PDPP protocol requirements.

`GET /_ref/dataset/summary` returns a live aggregate description of what the
substrate is holding: connector count, stream count, live record count, and
three separately-labeled byte totals (`record_json_bytes` for live payloads,
`record_changes_json_bytes` for retained change history, `blob_bytes` for
blobs), summed into `total_retained_bytes`. Counts exclude soft-deleted
records. The response also carries two pairs of temporal bounds:
`earliest_record_time` / `latest_record_time` are real-world timestamps
mined from record payloads via each stream's manifest-declared
`consent_time_field`, and `earliest_ingested_at` / `latest_ingested_at` are
the substrate's own `emitted_at` bounds (when the runtime wrote each row).
Plus a top-3 `top_connectors` list. Used by the operator-console hero band;
see `openspec/changes/reference-implementation-program/design-notes/dashboard-hero-plan-2026-04-22.md`
for the design rationale.

### Reference-only owner-auth placeholder

The reference ships a minimal local-only owner-auth placeholder for the current owner/operator browser surfaces. It is **not** part of the PDPP protocol and is **not** a finished owner-auth product. See
[`openspec/changes/reference-implementation-program/design-notes/owner-auth-placeholder-open-question-2026-04-22.md`](../openspec/changes/reference-implementation-program/design-notes/owner-auth-placeholder-open-question-2026-04-22.md)
for scope and rationale.

Environment variables:

- `PDPP_OWNER_PASSWORD` — if set, the current owner/operator browser surfaces below require a valid owner session. If unset, the server keeps its current open local-dev behavior.
- `PDPP_OWNER_SUBJECT_ID` — optional. Defaults to `owner_local`. When placeholder auth is enabled, this value is the owner subject id used for every approved grant and device authorization; any `subject_id` submitted from a form or JSON body is ignored.

Routes gated by the placeholder (when enabled):

- `GET /consent`, `POST /consent/approve`, `POST /consent/deny`
- `GET /device`, `POST /device/approve`, `POST /device/deny`
- `/dashboard`, `/dashboard/*` (via the composed web origin)
- every reference-only `_ref` read (`GET /_ref/*`) and mutation (`POST/PUT /_ref/*`). When `PDPP_OWNER_PASSWORD` is unset, `_ref` routes preserve the open local-dev behavior. When set, callers must present an owner session — the dashboard already forwards the `pdpp_owner_session` cookie, and CLI callers can pass the same value via `PDPP_OWNER_SESSION_COOKIE`.

Stable owner-entry routes:

- `GET /owner/login` — owner access page (supports a safe same-origin `return_to` query parameter). When placeholder auth is disabled it renders an honest disabled-state landing page; when enabled it renders either the sign-in form or a signed-in landing page.
- `POST /owner/login` — when placeholder auth is enabled, submits the owner password; on success sets a signed HTTP-only session cookie (`pdpp_owner_session`, 12 hour lifetime, `SameSite=Lax`, `Secure` when served over HTTPS) and redirects to `return_to`
- `POST /owner/logout` — clears the session cookie when present

Unauthenticated HTML requests to the protected routes redirect to `/owner/login?return_to=...`; non-HTML callers receive an honest `401` with error code `owner_session_required`.

The placeholder is intentionally narrow:

- no user table, no external IdP, no multi-user auth
- stateless HMAC-signed session cookie — rotating `PDPP_OWNER_PASSWORD` invalidates existing sessions
- public protocol surfaces (`/oauth/par`, `/oauth/register`, `/oauth/token`, `/v1/*`, `/.well-known/*`) are **not** gated
- the placeholder is still not a durable owner-auth story; it is only the current reference-local browser/session gate

### Reference-only hosted-UI layer

Server-rendered HTML pages (`GET /consent`, `GET /device` and its result pages, `POST /consent/approve`/`deny` result pages, and the stable owner-entry page at `GET /owner/login`) all go through a small shared hosted-UI module, [`server/hosted-ui.js`](server/hosted-ui.js). That module renders the PDPP brand mark and typography, reuses the `data-surface="human"` / `data-surface="protocol"` language from `packages/pdpp-brand/base.css`, and serves a single shared stylesheet at `GET /__pdpp/hosted-ui.css`.

This hosted-UI layer is **reference-only** implementation support. It is **not** a PDPP protocol surface; clients and providers never need to fetch `/__pdpp/hosted-ui.css` or consume any of the `hosted-ui-*` class names. The React/Next website in `apps/web/` remains the canonical design-system surface.

## How to use it

### Reference hosting modes

The reference now supports two deliberate local hosting modes:

- `direct` — AS on `:7662`, RS on `:7663`; best for protocol debugging, conformance-style testing, CLI, and agents
- `composed` — one browser-facing origin (default `http://localhost:3002`) proxying the internal AS/RS; best for the dashboard, owner flows, and demos

The shared topology inputs are:

- `PDPP_REFERENCE_MODE=direct|composed`
- `PDPP_REFERENCE_ORIGIN=http://...` for the browser-facing origin in composed mode

Legacy `AS_PUBLIC_URL` / `RS_PUBLIC_URL` overrides still work, but the preferred local/product path is the explicit composed-mode pair above.

### Same-origin local reference composition

The preferred local reference-product entrypoint is now the composed browser
origin at `http://localhost:3002`.

Run the full local stack from the repo root:

```bash
pnpm dev
```

In that mode:

- the Next app serves the browser-facing origin on `http://localhost:3002`
- the internal AS/RS still listen on `:7662` / `:7663`
- the browser-facing origin proxies the reference namespaces:
  - `/.well-known/*`
  - `/oauth/*`
  - `/v1/*`
  - `/_ref/*`
  - `/owner/*`
  - `/device`
  - `/consent`
  - `/__pdpp/hosted-ui.css`
- when `PDPP_OWNER_PASSWORD` is set, `/owner/*` and `/dashboard/*` share the
  same `pdpp_owner_session` cookie on the browser-facing origin

If you only need the backing AS/RS side of that composed setup while the web
app is already running, start this package in composition mode:

```bash
pnpm --dir reference-implementation dev
```

That mode sets `PDPP_REFERENCE_MODE=composed` and defaults
`PDPP_REFERENCE_ORIGIN` to `http://localhost:3002`, so the internal AS/RS
still listen on `:7662/:7663` while advertising the browser-facing origin in
metadata, device verification URLs, and PAR authorization URLs.

### Standalone reference server

Run the server:

```bash
pnpm --dir reference-implementation run server
```

That starts the AS/RS directly on their own listen ports (`:7662` / `:7663`)
without the composed browser-facing web origin.

If you need to force direct mode while other composition-oriented env is set in
your shell, run:

```bash
PDPP_REFERENCE_MODE=direct pnpm --dir reference-implementation run server
```

Inspect the CLI:

```bash
pnpm --dir reference-implementation cli --help
```

Run the test suite:

```bash
pnpm --dir reference-implementation test
```

Verify the generated contract artifacts are current:

```bash
pnpm reference-contract:check-generated
```

### Docker Compose reference stack

The supported Docker path is a root-level Compose assembly for the live
reference stack. The quickest self-hosted path uses the public GHCR images:

```bash
cp .env.docker.example .env.docker
# edit .env.docker and set PDPP_OWNER_PASSWORD for a protected dashboard
# (also gates every `_ref` read + mutation so deployed reference instances
#  never expose grants/runs/timelines/connectors/diagnostics unauthenticated)
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

Open `http://localhost:${PDPP_WEB_PORT:-3002}` for the browser-facing reference origin. The
Compose stack runs:

- `reference` — one AS/RS process, AS on `:7662`, RS on `:7663`
- `web` — the Next app on container `:3000`, mapped to host `${PDPP_WEB_PORT:-3002}` by default,
  proxying the AS/RS in composed mode

To test the owner-present n.eko interaction-streaming backend, add the n.eko
Compose overlay:

```bash
pnpm docker:neko
```

or directly:

```bash
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml up --build
```

Then open `http://localhost:${PDPP_WEB_PORT:-3002}/dashboard/stream-playground?backend=neko`.
The overlay runs n.eko in the reference container's network namespace, so the
reference process uses the loopback `http://127.0.0.1:8080/neko` target. The
browser still uses the same public origin through the reference `/neko/*`
proxy, including WebSocket upgrade traffic.

The overlay builds a thin local image on top of the pinned upstream n.eko
Chromium image. That layer only overrides the Chromium launcher/supervisor
entry so Chromium runs with the container-required `--no-sandbox` flag and the
same `/neko` path-prefix health shape used by the proxy.

The playground is disabled in production-mode builds unless
`PDPP_ENABLE_STREAM_PLAYGROUND=1` is set. The n.eko Compose overlay sets that
flag for both `web` and `reference`; the default Compose stack does not. The
overlay also sets `PDPP_NEKO_PROXY_AUTOLOGIN=1`, which lets the token-scoped
entry route pass dummy noauth `usr`/`pwd` query params to n.eko so the owner
lands directly in the WebRTC control surface instead of a sidecar login form.

For phone/LAN testing, set `NEKO_WEBRTC_NAT1TO1` in `.env.docker` to the host
IP the device can reach and allow `NEKO_WEBRTC_PORT` over both TCP and UDP.
The HTTPS route and `/neko/*` proxy cover page/signaling traffic; WebRTC media
still needs reachable ICE candidates. For public-device or LTE testing where
direct candidates may fail, start the authenticated coturn fallback:

```bash
pnpm docker:neko:turn
```

Set `TURN_PUBLIC_IP` and `NEKO_WEBRTC_ICESERVERS` in `.env.docker` to the
public address and TURN credentials for that host. TURN is a relay fallback and
adds bandwidth/latency only when WebRTC selects it; direct LAN/public candidates
remain the preferred path when they work.

Default public images:

- `ghcr.io/vana-com/pdpp/reference:main`
- `ghcr.io/vana-com/pdpp/web:main`

The `main` tag is a moving default-branch build. Stable semantic-release images
are published as exact version tags such as `1.2.3`, moving minor-series tags
such as `1.2`, and `latest`. For durable self-hosting, pin an exact version,
`sha-*` tag, or digest in `.env.docker`:

```bash
PDPP_REFERENCE_IMAGE=ghcr.io/vana-com/pdpp/reference:1.2.3
PDPP_WEB_IMAGE=ghcr.io/vana-com/pdpp/web:1.2.3
```

The important topology rule is that `PDPP_REFERENCE_ORIGIN` is what the
browser uses, while `PDPP_AS_URL` and `PDPP_RS_URL` are container-internal
service URLs. The default Compose values are:

```bash
PDPP_REFERENCE_ORIGIN=http://localhost:3002
PDPP_AS_URL=http://reference:7662
PDPP_RS_URL=http://reference:7663
```

Do not use `localhost` for cross-container AS/RS calls; inside Docker,
`localhost` means the current container.

Persistent mounts are defined for:

- `packages/polyfill-connectors/.pdpp-data/` bind-mounted to `/var/lib/pdpp`,
  with `PDPP_DB_PATH` at `/var/lib/pdpp/pdpp.sqlite`
- `PDPP_EMBEDDING_CACHE_DIR` at `/var/cache/pdpp/transformers`
- `~/.pdpp/` for browser profiles, daemon files, and connector session state

The first boot may download the default MiniLM model into the embedding cache.
Set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` if you want to avoid that and accept
the corresponding deployment diagnostic warning until the cache is prewarmed.

Secrets must be supplied at runtime through environment variables,
`.env.docker`, or Docker secrets. Do not bake `PDPP_OWNER_PASSWORD`, connector
passwords, tokens, cookies, or DCR initial access tokens into images. The
repo-root `.env.local` remains a local development convenience, not a Docker
or production posture.

Browser-based polyfill connectors are not clean-room portable demos. They need
persistent browser profiles and remain subject to upstream anti-bot behavior.
Mount any optional local connector inputs, such as Slack archives, explicitly
when testing those connectors.

Update public-image deployments by pulling newer images and restarting the
stack. This keeps the persisted SQLite DB, embedding cache, and browser profile
volumes in place:

```bash
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

To build from the current local checkout instead of pulling public images:

```bash
docker compose --env-file .env.docker up --build
```

The `.git` directory is excluded from the Docker build context, so the
reference image cannot derive a real revision at startup and falls back to
`pdpp-reference@<package-version>+unknown` in the
`PDPP-Reference-Revision` response header and the `GET /` discovery index.
Pass the running commit through the `PDPP_REFERENCE_REVISION` build arg so
production images publish a real revision:

```bash
docker build \
  --build-arg PDPP_REFERENCE_REVISION="$(git rev-parse --short=12 HEAD)" \
  --target reference \
  -t pdpp-reference:local .
```

The runtime continues to honor the `PDPP_REFERENCE_REVISION` env var, so the
revision can also be set or overridden at container start time.

Run the smoke validation:

```bash
pnpm docker:smoke
```

The smoke check builds the stack, verifies AS/RS metadata through the composed
browser origin, checks that public metadata does not leak Docker service names,
and confirms `/dashboard` redirects to `/owner/login` when owner auth is
configured.

Scheduler startup uses the same `reference-implementation/server/index.js`
entrypoint in Docker as local long-lived startup. To smoke enabled schedule
execution in Compose, seed a connector and enabled `connector_schedules` row in
the mounted reference database, restart only the `reference` service, then
confirm a new `scheduler_run_history` row appears for that connector without
pressing Run now. Disabled or deleted rows should not add history after restart.

For Docker-based development with hot reload, run:

```bash
pnpm docker:dev
```

That overlays `docker-compose.dev.yml`, bind-mounts the repo into the
containers, runs the reference server with Node watch mode, and runs the web
app with Next dev. Dependency folders stay in Docker named volumes so host
installs and container installs do not trample each other.

Docker dev loads repo-root `.env.local` in the reference container so local
connector credentials such as `GITHUB_PERSONAL_ACCESS_TOKEN` are available to
controller-managed connector runs. Public-image and default Compose operation
do not load `.env.local`; use `.env.docker`, environment variables, or Docker
secrets there.

When accessing Docker dev through a LAN IP or reverse proxy, add the browser
hostnames to `PDPP_WEB_ALLOWED_DEV_ORIGINS` in `.env.docker`, for example:

```bash
PDPP_WEB_ALLOWED_DEV_ORIGINS=peregrine-dev.vivid.fish,192.168.1.180
```

Reverse proxies must also forward WebSocket upgrade traffic for
`/_next/webpack-hmr`; otherwise the page loads but Next HMR cannot connect.

CI builds the Docker targets on pull requests without pushing images. On
`main`, semantic-release creates GitHub releases from Conventional Commits and
the same release workflow publishes stable GHCR tags for both Docker targets:
`${version}`, `${major}.${minor}`, `latest`, and `sha-*`. Maintainers should
make the first published GHCR packages public in GitHub's package settings if
the registry creates them private.

Maintainers can preview the next release calculation locally:

```bash
GITHUB_TOKEN=$(gh auth token) pnpm release:dry-run
```

The release path uses GitHub Actions credentials for GitHub releases and GHCR.
It does not publish npm packages and must not bundle `.env.local`, owner
passwords, connector credentials, SQLite data, model cache files, or browser
profiles into images.

### Example third-party client app

A minimal example app illustrates the **current** thin reference
provider-connect flow end to end (register &rarr; PAR &rarr; owner approval
&rarr; token &rarr; RS query). It lives at
[`examples/third-party-app/`](examples/third-party-app/) and runs on its own
port (default `7674`) separate from the AS/RS:

```bash
pnpm --dir reference-implementation example-client
```

Defaults: `PORT=7674`, `AS_URL=http://localhost:7662`, `RS_URL=http://localhost:7663`.

The example supports both approval modes honestly:

- when the reference server runs without `PDPP_OWNER_PASSWORD`, the example
  uses the reference-local JSON shortcut at `POST /consent/approve` and
  captures the token inline
- when `PDPP_OWNER_PASSWORD` is set, the inline shortcut is refused by the
  reference server. The example surfaces that honestly, links out to the
  hosted `/consent` page, and lets you paste the issued token back

The example is a third-party client illustration — it is **not** a full
generic OAuth authorization-code redirect client. It has no PKCE, no
`/callback`, and no code exchange. It only exercises the endpoints the
reference currently advertises.

## Published generated artifacts

The reference publishes generated machine-readable and human-readable contract
artifacts derived from `@pdpp/reference-contract`. These are treated as
versioned reference outputs, not throwaway build noise.

- `openapi/reference-public.openapi.json`
  - public PDPP JSON APIs only
- `openapi/reference-full.openapi.json`
  - public APIs plus reference-only `/_ref` operator surfaces
- `docs/generated/reference-routes.md`
  - generated route index for public APIs
- `docs/generated/reference-ref-routes.md`
  - generated route index for reference-only APIs
- `docs/generated/query-cookbook.md`
  - generated query and flow cookbook

Regenerate them with:

```bash
pnpm reference-contract:generate
```

## Relationship to the root PDPP specs

The root `spec-*.md` files remain normative for PDPP protocol semantics.

This package is the executable reference implementation:

- use the root specs to understand what PDPP means
- use this package to see what the current reference actually does
- use OpenSpec to understand project-level architecture and active implementation changes
