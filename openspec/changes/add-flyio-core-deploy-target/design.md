# Design: add-flyio-core-deploy-target

## Scope

In scope: the Fly.io deploy target for the PDPP Core reference node — topology,
env contract, deploy artifacts, offline env-contract preflight, and the honest
assessment of the Fly.io pushbutton situation. Out of scope: protocol behavior,
connector behavior, the Fly.io "Launch on Fly" button (see below), browser
collection, multi-region deploys, and any broader runtime redesign.

## The topology decision

**Decision: same composed-origin topology as Railway. One public Fly app (the
console), one private Fly app (the reference runtime), one managed Postgres
database. Fly's private WireGuard network replaces Railway's private networking.**

The topology rationale is identical to the Railway design: the reference server
binds two HTTP listeners (AS on `7662`, RS on `7663`) in one Node process. A
managed platform routes one public port per service. The console already proxies
the full protocol surface via `PDPP_AS_URL` / `PDPP_RS_URL`, forwards
`x-forwarded-host` / `x-forwarded-proto`, and composed mode advertises a single
public origin. So the public app is the console; the AS/RS reference app is
private and reachable only over Fly's internal network.

**Fly-specific topology mechanics:**

- A Fly app without `[http_service]` or `[[services]]` blocks has no public
  listener. The reference app omits the public service block; it listens on its
  process-internal ports (`7662` / `7663`) and is reachable only at
  `<app-name>.internal` over the private WireGuard mesh.
- The console app sets `PDPP_AS_URL=http://<reference-app>.internal:7662` and
  `PDPP_RS_URL=http://<reference-app>.internal:7663`.
- The console app sets `PDPP_REFERENCE_ORIGIN=https://<console-app>.fly.dev` (or
  the operator's custom domain) so composed mode advertises the correct public
  origin as the AS issuer and RS resource.
- Both apps can be deployed from public GHCR images or built from source. The
  `[build]` section in `fly.toml` carries the Dockerfile path and (for the
  reference app) the target stage; unlike Railway's config-as-code, Fly's
  `fly.toml` supports a `target` field under `[build]`, so there is no need for
  a separate `reference.Dockerfile`.

## Fly.io "Launch on Fly" button — honest assessment

Fly.io does not have a mature equivalent to Railway's one-click published
Template. As of 2026-06:

- Fly's `fly launch` command reads a `fly.toml` from a repository and
  interactively (or `--yes`-flag non-interactively) configures a new app. A
  GitHub repository can carry a `fly.toml` and document `fly launch` as the
  operator path. This is well-supported and reproducible.
- A "Deploy to Fly.io" button badge similar to Railway's does not exist as a
  first-class Fly feature with the same one-click new-account experience.
- Fly's "Launch on Fly" early-access feature exists for specific partners and is
  not generally available for arbitrary repositories.

**Decision: document the `fly launch` + `fly postgres create` + `fly deploy`
scripted path as the honest SLVP.** This is 3–5 CLI commands from a clean Fly
account and is reproducible without any platform-side template publication gate.
A placeholder `[![Launch on Fly](...)]` button is included in the README with
an explicit note that it is not yet a live path; a future slice can replace it
when Fly matures its template ecosystem.

This is the right honest call: documenting a fake one-click button would mislead
operators, while documenting the real CLI path sets correct expectations and is
immediately actionable.

## Fly.io Postgres

Fly offers two managed Postgres options:

- **Fly Postgres** (`fly postgres create`): a Fly-managed Postgres cluster
  (actually a Fly app running Postgres, not a fully managed external service).
  Free-tier available; easy `fly postgres attach` wires `DATABASE_URL` into the
  app automatically. Plain `postgres` dialect — no `pgvector` extension by
  default, matching the Railway setup.
- **Supabase / external Postgres**: an operator can point `PDPP_DATABASE_URL` at
  any reachable Postgres URL. Out of scope for this slice; the runbook documents
  Fly Postgres as the default.

**Decision: Fly Postgres via `fly postgres create` + `fly postgres attach`.**
`fly postgres attach` writes `DATABASE_URL` into the console app's secrets
automatically; the runbook documents mapping it to `PDPP_DATABASE_URL` via the
app's env block.

## Target-stage support in fly.toml

Unlike Railway's `build.dockerfilePath`-only config, Fly's `fly.toml` supports:

```toml
[build]
  dockerfile = "Dockerfile"
  target = "reference"
```

This means the reference app can use the root `Dockerfile` directly with
`target = "reference"`, with no need for a separate `deploy/flyio/reference.Dockerfile`
wrapper. The `fly.reference.toml` carries the `[build]` block with
`target = "reference"`.

## Security posture

Same as Railway: `PDPP_OWNER_PASSWORD` required and non-empty; HTTPS via Fly's
built-in TLS termination with `force_https = true`; `x-forwarded-proto` trusted
(Fly sets it, the console proxy honors it); the reference app has no public
service block so it is not internet-reachable. Fly's WireGuard mesh is the
isolation boundary for the private reference app.

## First-live-test acceptance

The same composed-origin acceptance gate as Railway applies (see
`add-railway-core-deploy-target/design.md` §"First-live-test acceptance"). The
local proxy is identical: `pnpm docker:smoke` + `pnpm railway:mcp-query-smoke`
(the MCP smoke harness is platform-neutral; "railway:" is a historical name in
the script, not a Railway-only runtime dependency). The Fly-specific difference
is the deploy mechanism (`fly deploy`) and the `<app-name>.fly.dev` public
origin.

## Offline env-contract preflight

`scripts/check-flyio-deploy-env.mjs` mirrors `check-railway-deploy-env.mjs` but
validates Fly-specific constraints:

- `PDPP_REFERENCE_ORIGIN` is `https://<app>.fly.dev` or a custom domain (HTTPS).
- `PDPP_AS_URL` and `PDPP_RS_URL` use `*.internal` hostnames (Fly's private DNS),
  not a public URL or `localhost`.
- `PDPP_OWNER_PASSWORD` is non-empty.
- `PDPP_DATABASE_URL` is present (Fly Postgres path).
- No forbidden mismatches (e.g. console URL in `PDPP_AS_URL`).

## Alternatives considered

- **Fly "Launch on Fly" button**: as assessed above, not mature enough to be the
  primary path. Documented as a placeholder for a future slice.
- **Single-app Fly deploy (reference only)**: rejected for the same reason as
  the Railway equivalent — it proves only the RS path and cannot exercise the
  OAuth issuance, owner-console, or device-approval surfaces.
- **Fly Machines API for private networking**: unnecessary complexity; the
  `*.internal` DNS and WireGuard mesh provided by the standard `fly` app model
  satisfy the private-network requirement without additional API calls.
- **Separate `deploy/flyio/reference.Dockerfile`**: unnecessary because Fly's
  `fly.toml` supports `[build] target = "reference"` directly.
- **Coolify or other self-hosted PaaS**: out of scope for this slice; the
  composed-origin contract is platform-neutral and would apply equally.

## Residual risks

- The deploy artifacts and preflight are validated against the local
  composed-origin stack and the routing code; no live Fly run is performed in
  this lane. The live run is the owner's.
- `<app-name>.internal` DNS resolution works inside the Fly private network but
  is not resolvable from outside. The offline preflight catches URL-format errors
  but cannot prove the live inter-app routing works before deploy.
- If the GHCR images stay private, a build-from-source clone is the only
  available path; the runbook documents both options.
- Fly Postgres is a Fly-managed app, not a fully managed external service; the
  operator is responsible for backups, failover, and version upgrades. For a
  Core query test this is acceptable; the runbook calls it out.
