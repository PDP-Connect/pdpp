# Deploy a PDPP Core node on Railway

This runbook describes how an operator runs the PDPP reference implementation as
a **Core node** on Railway: a node that boots, stays healthy, gates owner data,
and answers an authenticated query over public HTTPS. It is the first concrete
managed-platform target for the deploy contract in
[`openspec/changes/add-railway-core-deploy-target`](../../openspec/changes/add-railway-core-deploy-target/proposal.md).

This is operator documentation for someone running their own instance. The
reference implementation is forkable and self-hostable; there is no hosted PDPP
service you sign up for. The Docker images at `ghcr.io/vana-com/pdpp/*` are the
reference, published for inspection and self-hosting.

Scope of this first slice — and what it deliberately leaves out:

- **In scope:** one public origin, durable storage, owner gating, an
  authenticated MCP query against a small hand-imported record set, and a
  restart-survival check. The repo also carries the template-publication handoff
  needed to turn this deploy target into a Railway "Deploy" button.
- **Out of scope (by design):** browser-backed connector collection. Browser
  connectors (ChatGPT, USAA, Chase, …) fail closed inside the server container
  (`headed_browser_unavailable`) and run off-box via the local collector, so
  they are not part of a Core query test. Semantic retrieval, the scheduler,
  recurring collection, and n.eko are also out of scope here.

## Pushbutton Railway template

The end-user path is a published Railway Template with this button shape:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<template-code>?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core)
```

Railway assigns `<template-code>` when the template is published. Do not present
the placeholder URL as a live deploy button. The template owner publishes from a
validated Railway project using [`template.md`](./template.md), then replaces
`<template-code>` in the docs or site surface that should carry the button.

The published template uses public, anonymously pullable GHCR images as the
service source (the selected first-button shape). Each app service maps to one
published image:

| Service     | Public image source                          | Why |
|-------------|----------------------------------------------|-----|
| `console`   | `ghcr.io/vana-com/pdpp/web:<version-tag>`    | The `web` image is the root Dockerfile's `console` stage: the public, browser-free console. |
| `reference` | `ghcr.io/vana-com/pdpp/reference:<version-tag>` | The `reference` image is the root Dockerfile's `reference` stage: the private AS/RS runtime. |

Pin a concrete version tag (not `latest`) so the template is reproducible. The
images must be public; as of 2026-06-05 the two GHCR packages are private, so
publishing the button requires an owner-only visibility flip first. See the
source-accessibility gate in [`template.md`](./template.md).

The alternative source shape is the public source repository plus a Dockerfile
path whose final stage is the service image (`console` -> `Dockerfile`,
`reference` -> `deploy/railway/reference.Dockerfile`). Railway's config-as-code
schema exposes `build.dockerfilePath` but not a Docker build target field, so the
template selects a Dockerfile whose final stage is already the desired service
image. The committed [`railway.console.json`](./railway.console.json) and
[`railway.reference.json`](./railway.reference.json) carry that Dockerfile-path
shape; an image source supersedes them.

## Topology

One public service, one private service, one storage backend.

```
internet ──HTTPS──▶  console  (public, the only internet-reachable origin)
                        │ proxies the full protocol surface over the private network
                        ▼
                     reference (private: Authorization Server :7662 + Resource Server :7663)
                        │
                        ▼
                     Postgres  (managed plugin)   OR   SQLite file on a mounted volume
```

Why the console is the front door, not the reference image: the reference server
binds two HTTP listeners in one process — the Authorization Server on `AS_PORT`
(`7662`) and the Resource Server on `RS_PORT` (`7663`). A managed platform routes
one public port per service. The console (`apps/console`) already proxies the
full protocol surface — OAuth metadata, OAuth endpoints, the hosted MCP endpoint,
the `/v1` query API, and owner/device surfaces — to the internal AS and RS using
`PDPP_AS_URL` / `PDPP_RS_URL`, and it forwards `x-forwarded-host` /
`x-forwarded-proto` so composed mode advertises the single public origin. So the
supported shape exposes only the console; the AS `7662` and RS `7663` listeners
stay private. Both Core app images are browser-free for this target, so the
internet-facing service and private AS/RS service carry no browser binary.

This is the same composed-origin topology that `scripts/docker-smoke.sh` already
validates against the real images. See
[`design.md`](../../openspec/changes/add-railway-core-deploy-target/design.md)
for the full rationale and the alternatives that were rejected.

## Services to create

Create one Railway project with two application services plus a storage backend.
For the published-button shape, both app services use public GHCR images; for a
build-from-source project, both use the service-specific Dockerfile paths.

| Service     | Public? | Image source | Listens on        | Notes |
|-------------|---------|--------------|-------------------|-------|
| `console`   | yes     | `ghcr.io/vana-com/pdpp/web:<version-tag>` (or final stage in `Dockerfile`) | `$PORT` (Railway) | The single public origin. Generate a public domain for it. |
| `reference` | no      | `ghcr.io/vana-com/pdpp/reference:<version-tag>` (or final stage in `deploy/railway/reference.Dockerfile`) | `7662`, `7663` | Private networking only. Do **not** generate a public domain. |
| `Postgres`  | n/a     | managed plugin | private | Option A storage (recommended). |

The committed [`railway.console.json`](./railway.console.json) and
[`railway.reference.json`](./railway.reference.json) carry the builder, the
Dockerfile path, the healthcheck path, and the restart policy for the
build-from-source shape. They are service-specific source-of-truth blocks for the
Railway template composer; a Docker Image source supersedes the Dockerfile-path
build. The healthcheck path and the env contract apply to both source shapes.

## Environment

The variable names and meanings match `.env.docker.example`. Use
[`console.env.example`](./console.env.example) and
[`reference.env.example`](./reference.env.example) as the service-specific
templates, and [`env.example`](./env.example) as a consolidated reference.
Set the variables on the services indicated below. Provide `PDPP_OWNER_PASSWORD`
and any database URL as Railway secrets, not committed files.

Set on **both** services:

- `PDPP_REFERENCE_ORIGIN=https://<your-console-domain>` — the public origin.
- `PDPP_REFERENCE_MODE=composed`
- `PDPP_OWNER_PASSWORD=<non-empty secret>` — required (see Security below).

Set on the **console** service:

- `PDPP_AS_URL=http://reference.railway.internal:7662`
- `PDPP_RS_URL=http://reference.railway.internal:7663`
- `PDPP_ENABLE_DASHBOARD=1`
- Do not set `PORT`; Railway injects it and the console binds it.

Set on the **reference** service:

- `NODE_ENV=production`, `AS_PORT=7662`, `RS_PORT=7663`
- `PORT=7662` — Railway healthchecks use `PORT`; set it to the Authorization
  Server listener so `/.well-known/oauth-authorization-server` resolves.
- `PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1`
- `PDPP_RS_URL=http://127.0.0.1:7663` (loopback, for internal hosted-MCP
  self-calls — keep it distinct from the public origin so self-calls do not
  hairpin through the proxy).
- `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` (semantic retrieval stays off for a Core
  test).
- The storage variables from the option you pick below.

Preflight the service envs locally before deploying:

```sh
node scripts/check-railway-deploy-env.mjs \
  --console <your-console-env-file> \
  --reference <your-reference-env-file>
```

The check is offline and deterministic. It flags a missing or non-HTTPS public
origin, an empty owner password, mismatched shared values, console URLs that do
not target the private Railway reference service, reference healthcheck `PORT`
misconfiguration, and storage left on the non-durable default. Run against the
committed service templates it reports the placeholder origin and empty owner
password on purpose — they are templates, not ready-to-deploy files.

## Storage — pick one

The non-durable in-memory / unmounted-SQLite default is not a valid configured
backend for a deploy that must survive restart.

### Option A (recommended): managed Postgres

Add Railway's Postgres plugin and set, on the reference service:

```
PDPP_STORAGE_BACKEND=postgres
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The schema bootstraps idempotently at boot — no separate migrate step, no
volume. The database persists independently of the app container, so a redeploy
does not force a volume remount. Railway's managed Postgres is plain `postgres`,
not `pgvector`; with semantic retrieval off, the reference's grant-scoped JSONB
fallback is fine.

### Option B: SQLite on a mounted volume

Attach a Railway volume to the reference service and point `PDPP_DB_PATH` onto
the mount:

```
PDPP_STORAGE_BACKEND=sqlite
PDPP_DB_PATH=/data/pdpp.sqlite      # must be on the mounted volume
```

The default `PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite` is **not** on a Railway
volume; if you leave it at the default, the SQLite file is lost on every
redeploy. A volume-backed service also incurs brief redeploy downtime while the
volume remounts.

## Security posture for a public origin

- `PDPP_OWNER_PASSWORD` is required and non-empty. With it empty, the dashboard
  and device-approval surfaces render live owner data and approve flows
  anonymously — unacceptable on a public URL. The live gate verifies the
  `/dashboard` → `/owner/login` redirect.
- The public origin is served over HTTPS; Railway terminates TLS and forwards
  the protocol, so owner-session and CSRF cookies are marked `Secure`.
- The owner-session signing key derives from `PDPP_OWNER_PASSWORD`, so a stable
  password keeps owner sessions valid across restarts. There is no separate
  session secret to set.
- The reference service is private; only the console origin is reachable from the
  internet. No connector credentials and no
  `PDPP_CREDENTIAL_ENCRYPTION_KEY` are needed for a Core query test.

## First-live-test gate

Run the local proxy first; only request a live run once it passes. The local
checks stand in for the live run's application behavior, so the live run
validates platform specifics (real TLS, real DNS, durability across a real
restart) rather than first-discovery of application bugs.

Local, before any live run (from a main checkout with Docker):

1. `node scripts/check-railway-deploy-env.mjs --console <console-env> --reference <reference-env>` — env contract holds.
2. `pnpm docker:smoke` — composed-origin assertions (AS `issuer`, RS `resource`,
   and RS `authorization_servers[0]` all equal the public origin; no internal
   service name leaks) and the `/dashboard` → `/owner/login` redirect, on the
   real images.
3. `pnpm railway:sqlite-restart-smoke` — boots the stack on SQLite forced onto
   the persistent volume, seeds a deterministic record set, force-recreates the
   reference container, and proves the records and owner login survive on the
   volume (the local proxy for live step 7). This runs
   `scripts/railway-mcp-query-smoke.mjs` internally, so it also exercises the
   anonymous-refusal and scoped-query checks (live steps 5–6) end to end.

The seed + MCP query check can also be run on its own against any running
composed origin (local or live):

```sh
node scripts/railway-mcp-query-smoke.mjs --origin <origin> --owner-password "$PDPP_OWNER_PASSWORD"
```

It seeds a small record set with **no connector run** (it registers a fixture
manifest and writes records over the owner-gated `POST /v1/ingest/:stream`
path), asserts that an anonymous `/mcp` request is refused, and proves a scoped
client grant can `tools/list` and `query_records` those exact records. The
decision logic it uses is unit-tested offline by
`node --test scripts/railway-mcp-query-smoke.test.mjs`.

Live go/no-go on Railway:

1. Deploy contract applied: one public `console`, one private `reference`,
   durable storage, the env above set to the real public origin and the private
   internal targets.
2. The console reaches healthy via the healthcheck path
   `/.well-known/oauth-authorization-server` (HTTP 200).
3. Composed-origin metadata on the public origin: AS `issuer`, RS `resource`,
   and RS `authorization_servers[0]` all equal the public origin; no internal
   service name leaks.
4. `GET /_ref/deployment` (owner-gated) reports the deploy facts; semantic
   retrieval shows as an honest "not enabled," not a defect.
5. An anonymous `/dashboard` request redirects to `/owner/login`; a valid owner
   session passes.
6. The hosted MCP endpoint at the public `/mcp` refuses anonymous access and
   completes `tools/list` for a scoped grant; one scoped record query returns
   data from a small hand-imported record set (no connector run). Run
   `node scripts/railway-mcp-query-smoke.mjs --origin https://<your-console-domain> --owner-password "$PDPP_OWNER_PASSWORD"`
   against the live origin to drive and assert this end to end.
7. Restart the `reference` service; the owner login and the stored records
   survive; re-run the query. Re-run the step-6 script with `--no-seed` after the
   restart to confirm the records are still returned without re-writing them.
   (The local `pnpm railway:sqlite-restart-smoke` is the rehearsal of this on
   the SQLite-on-volume option.)

## Rollback and cleanup

- **Roll back a bad deploy:** in the Railway service's Deployments tab, redeploy
  the previous known-good deployment. Owner sessions and stored data are
  unaffected because they live in the storage backend, not the app container.
- **Tear down:** delete the `console` and `reference` services and the Postgres
  plugin (or the attached volume). Removing the console service releases the
  public domain; deleting the Postgres plugin or the volume removes the stored
  data. Do not leave the public domain attached to a deleted service, and do not
  orphan the volume.

## Cost note

This runs two always-on application services plus a storage backend on your
Railway account; you pay Railway for that usage. The Core template keeps browser
execution out of both app services. Browser-backed collection belongs to a
separate local-collector or explicit browser profile, not the pushbutton Core
deployment.

## Related

- [`proposal.md`](../../openspec/changes/add-railway-core-deploy-target/proposal.md),
  [`design.md`](../../openspec/changes/add-railway-core-deploy-target/design.md),
  [`tasks.md`](../../openspec/changes/add-railway-core-deploy-target/tasks.md)
- [`.env.docker.example`](../../.env.docker.example) — the full Docker env block.
- [`scripts/docker-smoke.sh`](../../scripts/docker-smoke.sh) — the composed-origin
  smoke that stands in for the live metadata/owner-gating checks.
- [`scripts/railway-mcp-query-smoke.mjs`](../../scripts/railway-mcp-query-smoke.mjs) —
  deterministic record seed (no connector run) + scripted external MCP query
  (anonymous refusal + scoped `query_records`); the proxy for live steps 5–6.
- [`scripts/railway-sqlite-restart-smoke.sh`](../../scripts/railway-sqlite-restart-smoke.sh) —
  SQLite-on-volume restart-survival smoke; the proxy for live step 7.
- [`scripts/check-railway-deploy-env.mjs`](../../scripts/check-railway-deploy-env.mjs) —
  the offline env-contract preflight (live step 1).
- [`docs/voice-and-framing.md`](../../docs/voice-and-framing.md) — the voice this
  doc follows.
