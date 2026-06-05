# Proposal: add-railway-core-deploy-target

## Why

The reference implementation has a committed Docker assembly (root `Dockerfile`,
`docker-compose.yml`, `scripts/docker-smoke.sh`) and a composed-origin topology
that already collapses the Authorization Server and Resource Server behind one
browser-facing origin. What it does not have is a documented, reproducible
**deploy-target contract** for running that same assembly on a managed platform
and a defined **first live deployment test** that proves a Core node boots,
stays healthy, gates owner data, and answers an authenticated query over public
HTTPS. The first target is Railway.

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

So the "two HTTP listeners (AS `7662` + RS `7663`) but one public port" problem
that two reports treated as gating does **not** gate the console front door. It
only applies if a deploy naively points the platform at the `reference` image
directly. The supported Railway shape is therefore the same single-public-origin
composed topology the smoke test already validates: **one public console
service, one private reference service, and a storage backend** — achievable
with configuration only, no runtime code change.

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
  topology: exactly one public service (the console) fronting the full protocol
  surface, the AS/RS reference service kept private, and AS/RS internal URLs and
  the public origin supplied through the existing
  `PDPP_REFERENCE_ORIGIN` / `PDPP_AS_URL` / `PDPP_RS_URL` env contract. The
  public service SHALL be the only internet-reachable origin; the AS `7662` and
  RS `7663` listeners SHALL NOT be published as separate public origins for this
  target.
- Require the deploy target to provide **durable storage explicitly**: either a
  managed Postgres backend (`PDPP_STORAGE_BACKEND=postgres` +
  `PDPP_DATABASE_URL`, schema bootstrapped idempotently at boot) or a SQLite
  database file on a mounted persistent volume with `PDPP_DB_PATH` pointed onto
  that volume. The default in-memory / unmounted SQLite path SHALL NOT be the
  configured storage for a deploy that must survive restart.
- Require the deploy target to **gate owner data by default**: a non-empty
  `PDPP_OWNER_PASSWORD` SHALL be required, and the deploy SHALL NOT serve the
  owner console or device-approval surfaces anonymously. The public origin SHALL
  be served over HTTPS with forwarded-proto trusted so owner-session cookies are
  marked `Secure`.
- Require an **executable first-live-test gate**: a reproducible health and
  doctor check (the platform healthcheck path plus the existing
  `GET /_ref/deployment` diagnostics and the composed-origin smoke assertions), a
  storage-persistence check across a restart, an MCP reachability check that
  refuses anonymous access and succeeds for a scoped grant, and a
  rollback/cleanup path. These SHALL be runnable against a local composed-origin
  stack before any live platform run is requested.
- Add the platform-neutral **deploy artifacts** required to reproduce the target:
  a documented env block (consistent with `.env.docker.example`), a
  `deploy/railway/` config/runbook describing the two services, the storage
  choice, the healthcheck path, and the rollback steps, and an operator-voice
  "Deploy on Railway" section. No protocol, API, manifest, or connector behavior
  changes.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Configuration, deployment artifacts, and documentation for the reference
  implementation only. Does not change the PDPP protocol, the public
  record/query/search/schema/blob `/v1` API, MCP semantics, Collection Profile
  JSONL messages, connector manifests, owner-auth semantics, or the storage
  schema. The composed-origin proxy, the AS/RS rewrite behavior, and the smoke
  assertions are reused as-is; this change documents and constrains how they are
  deployed, it does not re-implement them.
- The deploy target is platform-neutral by construction (it is the existing
  composed-origin contract plus a public/private service split and explicit
  storage), so Fly / a VPS / Coolify follow the same shape with different
  service plumbing. Railway is the first concrete target because it has the
  lowest-friction push-button path and the cleanest mapping onto the existing
  `Dockerfile` targets.
- Deliberately out of scope, recorded as explicit non-goals: browser / ChatGPT
  collection (off-box via local-collector; fails closed in-container), the
  operator-console-as-separate-public-service variant, semantic retrieval and the
  embedding-cache volume, the scheduler and recurring collection, n.eko, backup /
  restore tooling, Cloudflare Access / Tunnel / R2 adjuncts, and a published
  multi-service Railway template with a Deploy button. A `pdpp doctor` CLI and a
  browser-free `core` image target are **optional follow-on enhancements**, not
  blockers: the existing `docker-smoke.sh`, `GET /_ref/deployment`, and the
  `.well-known` healthcheck already make the first live test executable, and the
  public service (the console image) is already browser-free.
- The `surface-database-physical-footprint` change (active, extends
  `GET /_ref/deployment`) and `reduce-main-docker-image-ci-cost` (CI-publish
  policy) also touch this capability. Neither defines a deploy target, a
  public/private service split, or a first-live-test gate, so there is no
  MODIFIED-requirement collision; the doctor/diagnostics half of this change
  consumes `/_ref/deployment` rather than re-deriving it.
