# Deploy a PDPP Core node on Fly.io

This runbook describes how an operator runs the PDPP reference implementation as
a **Core node** on Fly.io: a node that boots, stays healthy, gates owner data,
and answers an authenticated query over public HTTPS. It implements the same
platform-neutral deploy contract as the Railway target in
[`openspec/changes/add-railway-core-deploy-target`](../../openspec/changes/add-railway-core-deploy-target/proposal.md);
the Fly.io-specific differences are documented explicitly.

This is operator documentation for someone running their own instance. The
reference implementation is forkable and self-hostable; there is no hosted PDPP
service you sign up for.

Scope of this first slice — and what it deliberately leaves out:

- **In scope:** one public origin (the console app), one private origin (the
  reference app, AS + RS), durable Postgres, owner gating, an authenticated MCP
  query against a small hand-imported record set, and a restart-survival check.
- **Out of scope (by design):** browser-backed connector collection (fails closed
  inside the server container; runs off-box via the local collector), semantic
  retrieval, the scheduler, recurring collection, and n.eko.

## Pushbutton path

> **No live "Launch on Fly" button yet.** Fly.io does not have a mature
> equivalent to Railway's one-click published Template as of 2026-06. The
> operator path is 3–5 CLI commands documented below. A placeholder badge for
> a future one-click path is shown here for intent only:
>
> ```
> <!-- NOT YET LIVE — placeholder for a future slice -->
> [![Launch on Fly](https://fly.io/launch-on-fly.svg)](https://fly.io/launch?source=<placeholder>)
> ```
>
> A future slice can replace this with a live link once Fly.io matures its
> template ecosystem and the GHCR images are public. The requirements are:
> public GHCR images (`ghcr.io/vana-com/pdpp/web` and
> `ghcr.io/vana-com/pdpp/reference`) or a public repository source, plus a
> Fly-side launch configuration that encodes both apps, Postgres, and the
> required secrets. Do not present the placeholder as a live deploy button.

The Railway target carries a live `[![Deploy on Railway](…)]` button with the
same underlying contract; see `deploy/railway/README.md` if you prefer Railway.

## Topology

One public app, one private app, one Postgres database.

```
internet ──HTTPS──▶  pdpp-console  (public Fly app, the only internet-reachable origin)
                        │ proxies the full protocol surface over the private WireGuard network
                        ▼
                     pdpp-reference  (private Fly app: AS :7662 + RS :7663)
                        │               reachable only at <app>.internal
                        ▼
                     Postgres  (fly postgres cluster)
```

Why the console is the front door, not the reference image: the reference server
binds two HTTP listeners in one process — the Authorization Server on AS_PORT
(`7662`) and the Resource Server on RS_PORT (`7663`). A Fly app routes one public
port. The console already proxies the full protocol surface to internal AS and RS
via `PDPP_AS_URL` / `PDPP_RS_URL`, and forwards `x-forwarded-host` /
`x-forwarded-proto` so composed mode advertises the single public origin. The
reference app has no `[http_service]` block and is not internet-reachable.

Both images are browser-free for this target (the Core reference stage).

This is the same composed-origin topology that `scripts/docker-smoke.sh` already
validates. See
[`design.md`](../../openspec/changes/add-flyio-core-deploy-target/design.md)
for the full rationale.

## Apps to create

| App | Public? | Build source | Listens on | Notes |
|-----|---------|-------------|------------|-------|
| `pdpp-console` | Yes (`fly.dev` domain) | Root `Dockerfile` (console stage) | `$PORT` (3000) | The only internet-reachable origin |
| `pdpp-reference` | No (private only) | Root `Dockerfile`, `target = reference` | 7662 (AS), 7663 (RS) | Reachable at `<app>.internal` |
| Postgres | No | `fly postgres create` | n/a | Attached to both apps |

Choose app names that are unique on Fly.io. The reference app name sets its
`.internal` DNS name: `<reference-app-name>.internal`.

## First deploy: step by step

Prerequisites: `fly` CLI installed and authenticated (`fly auth login`).

### 1. Create the Postgres cluster

```sh
fly postgres create --name pdpp-postgres --region iad
```

Note the connection string; you will attach it to both apps.

### 2. Create and configure the reference app (private)

```sh
# Create the app without deploying yet
fly apps create pdpp-reference --region iad

# Set required secrets on the reference app
fly secrets set --app pdpp-reference \
  PDPP_REFERENCE_ORIGIN="https://pdpp-console.fly.dev" \
  PDPP_OWNER_PASSWORD="$(openssl rand -base64 24)" \
  PDPP_DATABASE_URL="<postgres-connection-string-from-step-1>"

# Attach Postgres (alternative to setting PDPP_DATABASE_URL manually above)
# fly postgres attach --app pdpp-reference pdpp-postgres
# Then map DATABASE_URL -> PDPP_DATABASE_URL in the reference.env.example secrets.

# Deploy the reference app (private; no public port)
fly deploy --config deploy/flyio/fly.reference.toml --app pdpp-reference
```

The reference app has no public URL. Verify it started:

```sh
fly status --app pdpp-reference
```

### 3. Create and configure the console app (public)

```sh
# Create the console app
fly apps create pdpp-console --region iad

# Set required secrets (use the same PDPP_OWNER_PASSWORD as the reference app)
fly secrets set --app pdpp-console \
  PDPP_REFERENCE_ORIGIN="https://pdpp-console.fly.dev" \
  PDPP_AS_URL="http://pdpp-reference.internal:7662" \
  PDPP_RS_URL="http://pdpp-reference.internal:7663" \
  PDPP_OWNER_PASSWORD="<same-value-as-reference-app>" \
  PDPP_DATABASE_URL="<postgres-connection-string>"

# Deploy the console app (public on pdpp-console.fly.dev)
fly deploy --config deploy/flyio/fly.toml --app pdpp-console
```

### 4. Verify the deploy

```sh
# Health check: should return HTTP 200 with AS metadata JSON
curl -s https://pdpp-console.fly.dev/.well-known/oauth-authorization-server | jq .

# Composed-origin check: issuer, resource, and authorization_servers[0] must
# all equal https://pdpp-console.fly.dev; no *.internal URL should appear.

# Owner gating: anonymous /dashboard hit must redirect to /owner/login
curl -sv https://pdpp-console.fly.dev/dashboard 2>&1 | grep -i location

# Owner-gated diagnostics (after owner login)
# GET https://pdpp-console.fly.dev/_ref/deployment
```

For the full first-live-test gate (MCP query, restart survival), use the
platform-neutral harnesses:

```sh
# Composed-origin + owner-gating assertions (local proxy, requires Docker)
pnpm docker:smoke

# MCP anonymous-refusal + scoped query (requires a running origin)
pnpm railway:mcp-query-smoke -- \
  --origin https://pdpp-console.fly.dev \
  --owner-password "<your-owner-password>"
```

The `railway:mcp-query-smoke` script name is historical; the harness is
platform-neutral and works against any PDPP composed origin.

## Offline env-contract preflight

Before a live deploy, validate the env contract offline:

```sh
node scripts/check-flyio-deploy-env.mjs \
  PDPP_REFERENCE_ORIGIN="https://pdpp-console.fly.dev" \
  PDPP_AS_URL="http://pdpp-reference.internal:7662" \
  PDPP_RS_URL="http://pdpp-reference.internal:7663" \
  PDPP_OWNER_PASSWORD="<your-owner-password>" \
  PDPP_DATABASE_URL="postgres://..."
```

Run the offline test suite:

```sh
pnpm flyio:env:check:test
```

## Storage

**Fly Postgres** (recommended): `fly postgres create` + `fly postgres attach`
provisions a Fly-managed Postgres cluster. The schema bootstraps idempotently at
boot — no separate migrate step, no volume. Fly's managed Postgres is plain
`postgres`, not `pgvector`; the reference falls back to grant-scoped JSONB vector
storage, which is fine with semantic retrieval off.

Note: Fly Postgres is a Fly-managed Fly app, not a fully managed external
database service. You are responsible for backups, failover, and version
upgrades. For a Core query test this is acceptable; for production use, evaluate
an external managed Postgres provider.

SQLite on a Fly volume is also possible but is out of scope for this slice; the
Railway runbook documents the SQLite-on-volume pattern if needed.

## Rollback and teardown

**Redeploy the prior image:**

```sh
fly deploy --config deploy/flyio/fly.toml --app pdpp-console --image <prior-image>
fly deploy --config deploy/flyio/fly.reference.toml --app pdpp-reference --image <prior-image>
```

**Full teardown:**

```sh
fly apps destroy pdpp-console
fly apps destroy pdpp-reference
fly postgres destroy pdpp-postgres
```

Destroying the Postgres cluster deletes all data. Back up first if needed:

```sh
fly postgres connect --app pdpp-postgres
# \copy ... or pg_dump from within the Fly proxy shell
```

## Using public GHCR images instead of building from source

If the GHCR images are public, you can skip the build step and point each app at
a pinned image. Set the `[build]` block in each `fly.toml` to use the image
source:

```toml
[build]
  image = "ghcr.io/vana-com/pdpp/web:<version-tag>"     # console
  # OR:
  image = "ghcr.io/vana-com/pdpp/reference:<version-tag>"  # reference
```

As of 2026-06-06, the GHCR packages are private; building from source is the
available path. An owner-only visibility flip unblocks the image-source path.

## Environment variable reference

See [`console.env.example`](./console.env.example) and
[`reference.env.example`](./reference.env.example) for the service-specific
templates. These are a Fly-scoped subset of `.env.docker.example`; the variable
names and meanings are identical.

| Variable | Console | Reference | Notes |
|----------|---------|-----------|-------|
| `PDPP_REFERENCE_ORIGIN` | required | required | `https://<console-app>.fly.dev`; same on both |
| `PDPP_AS_URL` | required | — | `http://<reference-app>.internal:7662` |
| `PDPP_RS_URL` | required | — | `http://<reference-app>.internal:7663` |
| `PDPP_OWNER_PASSWORD` | required | required | same on both; derive from `openssl rand -base64 24` |
| `PDPP_DATABASE_URL` | required | required | Postgres connection string; same on both |
| `NODE_ENV` | set in fly.toml | set in fly.toml | `production`; do not override as a secret |
| `PORT` | injected by Fly | set in fly.toml | console: do not set; reference: `7662` |
| `PDPP_EMBEDDING_DOWNLOAD_ALLOWED` | — | set in fly.toml | `0`; semantic retrieval off |
