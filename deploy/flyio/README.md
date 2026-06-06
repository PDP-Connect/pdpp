# Deploy a PDPP Core node on Fly.io

This runbook describes how an operator runs the PDPP reference implementation as
a Core node on Fly.io: one public Core app, one durable Postgres database, owner
gating, and an authenticated query over public HTTPS.

This is operator documentation for someone running their own instance. The
reference implementation is forkable and self-hostable; there is no hosted PDPP
service you sign up for.

Scope of this first slice:

- In scope: one public Core app, Fly Postgres, owner gating, an authenticated MCP
  query against a small hand-imported record set, and restart-survival proof.
- Out of scope: browser-backed connector collection inside the deployed app,
  semantic retrieval, recurring collection, scheduler operations, and n.eko.

## Shareable Path

Fly.io does not provide a Railway-style published Template button for arbitrary
repos that can encode this deployment as a hosted one-click link. The selected
Fly-native path is a single `fly launch` command from the public repository:

```sh
APP="pdpp-core-$(openssl rand -hex 3)"
OWNER_PASSWORD="$(openssl rand -base64 24)"

fly launch \
  --from https://github.com/vana-com/pdpp \
  --config deploy/flyio/fly.toml \
  --name "$APP" \
  --region iad \
  --copy-config \
  --build-target platform-core \
  --db \
  --secret "PDPP_OWNER_PASSWORD=$OWNER_PASSWORD" \
  --env "PDPP_REFERENCE_ORIGIN=https://$APP.fly.dev" \
  --no-github-workflow \
  --no-object-storage \
  --no-redis \
  --now \
  --yes

printf 'Origin: https://%s.fly.dev\nOwner password: %s\n' "$APP" "$OWNER_PASSWORD"
```

This is the honest Fly equivalent to the Railway button today: one command that
creates the app, provisions Postgres, deploys the Core image from source, and
prints the owner password the operator needs for login and smoke checks.

If `fly launch --from` cannot read the config path in your local flyctl version,
clone the repository and run the same command from the checkout without the
`--from` flag.

## Topology

One public app, one loopback AS/RS pair, one storage backend.

```
internet --HTTPS--> core (public Fly app)
                       |- console listens on Fly internal_port 3000
                       |- AS listens on 127.0.0.1:7662
                       `- RS listens on 127.0.0.1:7663
                            |
                            v
                         Postgres (created by fly launch --db)
```

Why this is the selected shape: live Railway testing already proved the
one-service Core image is the lowest-prompt, easiest-to-share shape for managed
platforms. Fly can run that same `platform-core` Docker target directly. That
avoids a second private app, avoids `*.internal` wiring, and lets Fly's `--db`
provisioning provide the standard `DATABASE_URL` that the runtime accepts.

## Configuration

[`fly.toml`](./fly.toml) builds the root `Dockerfile` target `platform-core` and
exposes the console on port 3000.

Set or let `fly launch` set:

```sh
PDPP_REFERENCE_ORIGIN=https://<app-name>.fly.dev
PDPP_OWNER_PASSWORD=<required user-provided secret>
DATABASE_URL=<created by fly launch --db>
```

`PDPP_DATABASE_URL` is also accepted and takes precedence over `DATABASE_URL` if
you choose to attach Postgres manually:

```sh
fly postgres attach --app <app-name> <postgres-app> --variable-name PDPP_DATABASE_URL
```

Do not set `PORT`, `AS_PORT`, `RS_PORT`, `PDPP_AS_URL`, or `PDPP_RS_URL` on the
Fly app. The `platform-core` image owns those values internally.

Preflight a local env file before a live deploy:

```sh
node scripts/check-flyio-deploy-env.mjs --core deploy/flyio/core.env.example
```

The committed example intentionally fails until the app origin, owner password,
and database URL are filled.

## Verification

After launch, run:

```sh
ORIGIN="https://$APP.fly.dev"

curl -fsS "$ORIGIN/.well-known/oauth-authorization-server" | jq .
curl -sv "$ORIGIN/dashboard" 2>&1 | grep -i location

pnpm railway:mcp-query-smoke -- \
  --origin "$ORIGIN" \
  --owner-password "$OWNER_PASSWORD"
```

The `railway:mcp-query-smoke` script name is historical; the harness is
platform-neutral and works against any composed PDPP origin.

Restart-survival proof:

```sh
fly apps restart "$APP"
pnpm railway:mcp-query-smoke -- \
  --origin "$ORIGIN" \
  --owner-password "$OWNER_PASSWORD" \
  --no-seed
```

## Storage

The selected path uses Fly Postgres via `fly launch --db`. The runtime selects
Postgres automatically when `PDPP_DATABASE_URL` or `DATABASE_URL` is present and
bootstraps the schema idempotently at startup.

Fly Postgres is a Fly app running Postgres. The operator is responsible for
backups, failover posture, and version upgrades. For a Core query test this is
acceptable; for production use, evaluate the current Fly Managed Postgres option
or an external managed Postgres provider.

## Rollback and Teardown

Rollback:

```sh
fly deploy --config deploy/flyio/fly.toml --app "$APP" --image <prior-image>
```

Teardown:

```sh
fly apps destroy "$APP"
fly postgres list
fly postgres destroy <postgres-app>
```

Destroying Postgres deletes stored data. Back up first if the node contains data
you need to keep.

## Related

- [`proposal.md`](../../openspec/changes/add-flyio-core-deploy-target/proposal.md)
- [`design.md`](../../openspec/changes/add-flyio-core-deploy-target/design.md)
- [`tasks.md`](../../openspec/changes/add-flyio-core-deploy-target/tasks.md)
- [`scripts/check-flyio-deploy-env.mjs`](../../scripts/check-flyio-deploy-env.mjs)
- [`scripts/railway-mcp-query-smoke.mjs`](../../scripts/railway-mcp-query-smoke.mjs)
