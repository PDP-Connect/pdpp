# Proposal: add-railway-core-deploy-target

## Why

The reference implementation has a committed Docker assembly (root `Dockerfile`,
`docker-compose.yml`, `scripts/docker-smoke.sh`) and a composed-origin topology
that already collapses the Authorization Server and Resource Server behind one
browser-facing origin. What it does not have is a documented, reproducible
**deploy-target contract** for running that same assembly on a managed platform
and a defined **first live deployment test** that proves a Core node boots,
stays healthy, gates owner data, and answers an authenticated query over public
HTTPS. The first target is Railway. Live template publication also showed that
literal source-project env values become user prompts, so this change now
includes the narrow image/runtime defaults needed to keep the Railway Template
pushbutton.

Three prior evidence reports
(`tmp/workstreams/ri-railway-runtime-audit-v1-report.md`,
`ri-railway-slvp-plan-v1-report.md`, `ri-railway-current-docs-v1-report.md`)
disagreed on the deployment topology. The disagreement is load-bearing, so it
was resolved against the actual routing code rather than the reports:

- `apps/console/src/app/reference-proxy.ts` and the App Router route handlers
  (`mcp/route.ts` -> RS, `v1/[...path]` -> RS, `oauth/[...path]` -> AS, both
  `well-known/*` -> AS/RS) prove the **console already proxies the full
  protocol surface** to internal AS/RS via `PDPP_AS_URL` / `PDPP_RS_URL`,
  forwarding `x-forwarded-host` / `x-forwarded-proto` so the AS issuer and RS
  resource rewrite to the public console origin.
- `scripts/docker-smoke.sh` already proves this exact shape on the real images:
  one public origin serves both `.well-known` documents, asserts
  `issuer === origin`, `resource === origin`, `authorization_servers[0] ===
  origin`, that no internal Docker service name leaks, and that `/dashboard`
  redirects to `/owner/login` when `PDPP_OWNER_PASSWORD` is set.

So the "two HTTP listeners (AS + RS) but one public port" problem that two
reports treated as gating does **not** gate the console front door. It only
applies if a deploy naively points the platform at the `reference` image
directly. The selected Railway button shape is therefore the same
single-public-origin composed topology packaged as **one public `railway-core`
service plus a storage backend**: the console binds Railway's injected `$PORT`,
while the reference AS/RS listeners stay private on loopback inside the same
container. Live Railway template publication added one constraint: a separate
private `reference` image service requires an explicit service `PORT` to boot
reliably, and Railway turns that `PORT` into an extra required deploy-page
prompt. The one-service `railway-core` image removes that prompt without adding
a second public origin.

This change records that topology decision as a durable deployment contract,
adds the platform-neutral deploy artifacts and env block needed to reproduce it,
and defines the executable first-live-test acceptance so a future operator (or a
future maintainer) can audit why the Railway slice is shaped the way it is. It
deliberately excludes browser/ChatGPT collection from the first slice: browser
connectors fail closed inside the server container (`headed_browser_unavailable`)
and run off-box via the local-collector, so they are not part of a Core query
test.

## What Changes

- Add a `reference-implementation-architecture` requirement defining a
  **managed-platform Core deploy target** built from the existing composed-origin
  topology: exactly one internet-reachable origin fronts the full protocol
  surface, the AS/RS listeners stay private, and the public origin is supplied
  through `PDPP_REFERENCE_ORIGIN`. For the selected Railway Template this is one
  `railway-core` app service that runs console plus loopback AS/RS in the same
  image; split public/private app services remain a manual platform shape, not
  the published-button path.
- Require the deploy target to provide **durable storage explicitly**: either a
  managed Postgres backend (`PDPP_DATABASE_URL`, with
  `PDPP_STORAGE_BACKEND=postgres` optional because the runtime selects Postgres
  when the database URL is present, schema bootstrapped idempotently at boot) or
  a SQLite database file on a mounted persistent volume with `PDPP_DB_PATH`
  pointed onto that volume. The default in-memory / unmounted SQLite path SHALL
  NOT be the configured storage for a deploy that must survive restart.
- Require the deploy target to **gate owner data by default**: a non-empty
  `PDPP_OWNER_PASSWORD` SHALL be required, and the deploy SHALL NOT serve the
  owner console or device-approval surfaces anonymously. The public origin SHALL
  be served over HTTPS with forwarded-proto trusted so owner-session cookies are
  marked `Secure`.
- Require an **executable first-live-test gate**: a reproducible health and
  diagnostics check (the public well-known probe plus the existing
  `GET /_ref/deployment` diagnostics and the composed-origin smoke assertions), a
  storage-persistence check across a restart, an MCP reachability check that
  refuses anonymous access and succeeds for a scoped grant, and a
  rollback/cleanup path. These SHALL be runnable against a local composed-origin
  stack before any live platform run is requested.
- Add the platform-neutral **deploy artifacts** required to reproduce the target:
  a documented env block (consistent with `.env.docker.example`), a
  `deploy/railway/` config/runbook describing the selected one-service Railway
  button shape, the storage choice, the public health probe, and the rollback steps,
  and an operator-voice "Deploy on Railway" section. Add a Railway Template
  handoff and published button code. No protocol, API, manifest, or connector
  behavior changes.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Configuration, deployment artifacts, narrow image/runtime defaults, and
  documentation for the reference implementation only. Does not change the PDPP
  protocol, the public
  record/query/search/schema/blob `/v1` API, MCP semantics, Collection Profile
  JSONL messages, connector manifests, owner-auth semantics, or the storage
  schema. The composed-origin proxy, the AS/RS rewrite behavior, and the smoke
  assertions are reused as-is; this change documents and constrains how they are
  deployed, and adds defaults only where Railway would otherwise turn safe
  constants into user prompts.
- The deploy target is platform-neutral by construction (it is the existing
  composed-origin contract plus private AS/RS listeners and explicit storage),
  so Fly / a VPS / Coolify can reproduce it with different service plumbing.
  Railway is the first concrete target because it has the lowest-friction
  pushbutton path once the app is packaged as `railway-core`.
- Deliberately out of scope, recorded as explicit non-goals: browser / ChatGPT
  collection (off-box via local-collector; fails closed in-container), the
  operator-console-as-separate-public-service variant, semantic retrieval and the
  embedding-cache volume, the scheduler and recurring collection, n.eko, backup /
  restore tooling, and Cloudflare Access / Tunnel / R2 adjuncts. A `pdpp doctor`
  CLI remains an optional follow-on enhancement. The browser-free Core reference
  image is now part of the deploy target: live Railway evidence showed the
  browser-enabled reference image was too heavy for the pushbutton path, and Core
  does not need browser binaries to prove auth, storage, hosted MCP, or record
  query behavior.
- The `surface-database-physical-footprint` change (active, extends
  `GET /_ref/deployment`) and `reduce-main-docker-image-ci-cost` (CI-publish
  policy) also touch this capability. Neither defines a deploy target, a
  public/private service split, or a first-live-test gate, so there is no
  MODIFIED-requirement collision; the doctor/diagnostics half of this change
  consumes `/_ref/deployment` rather than re-deriving it.
