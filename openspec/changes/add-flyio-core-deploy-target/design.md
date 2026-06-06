# Design: add-flyio-core-deploy-target

## Scope

In scope: a Fly.io deploy target for the PDPP Core reference node: topology,
env contract, deploy artifacts, offline preflight, a shareable CLI launch path,
and first-live-test acceptance.

Out of scope: protocol behavior, connector behavior, browser collection inside
the deployed app, scheduler operation, semantic retrieval, multi-region design,
and a Fly-hosted one-click template publication system.

## Topology Decision

Decision: one public Fly Core app, one Fly Postgres database, AS/RS on loopback.

This matches the proven Railway pushbutton shape. The `platform-core` Docker
target runs:

- the operator console on Fly's public service port;
- the Authorization Server on `127.0.0.1:7662`;
- the Resource Server on `127.0.0.1:7663`;
- the console proxy with loopback `PDPP_AS_URL` / `PDPP_RS_URL`.

Fly can also run a split app topology with `*.internal` private DNS, but it adds
an extra app, extra secrets, and extra operator steps without proving more of
the protocol. The one-app Core shape is the SLVP for a friend-shareable Fly
deploy because it is simpler, cheaper, and closer to the Railway button.

## Shareable Fly Path

Fly currently supports `fly launch --image`, `fly launch --from <github-url>`,
`--config`, `--build-target`, `--db`, `--secret`, and `--env`. It does not
expose a Railway-style published template URL for arbitrary repos that can
encode this deployment as a hosted one-click button.

Decision: document a single `fly launch` command as the honest Fly-native
shareable path. The fastest path uses the public Core image; the source fallback
uses `fly launch --from https://github.com/vana-com/pdpp`. Both choose a
concrete app name, set `PDPP_REFERENCE_ORIGIN`, generate `PDPP_OWNER_PASSWORD`,
enable Fly Postgres via `--db`, deploy, and print the origin/password for
verification.

This is not called a one-click button. It is the narrowest honest path until Fly
offers a generally available template surface with the same semantics as
Railway Templates.

## Database Env

Fly `--db` injects the standard `DATABASE_URL`. PDPP's explicit
`PDPP_DATABASE_URL` remains supported and wins when both are set, but the runtime
also accepts `DATABASE_URL` as a fallback. This is a small 12-factor-compatible
runtime improvement that avoids Fly-specific attach choreography and benefits
other managed platforms.

## Security Posture

`PDPP_OWNER_PASSWORD` is required and non-empty. Fly terminates HTTPS and the
`fly.toml` service sets `force_https = true`. Browser-backed collection is not
enabled inside the deployed app. The app owns AS/RS loopback targets internally;
operators should not set `PORT`, `AS_PORT`, `RS_PORT`, `PDPP_AS_URL`, or
`PDPP_RS_URL`.

## First-Live-Test Acceptance

The Fly live gate matches the Railway gate:

- metadata health returns HTTP 200 at the public origin;
- AS issuer, RS resource, and RS authorization server point at the public origin;
- anonymous `/dashboard` redirects to owner login;
- deterministic MCP smoke refuses anonymous access and returns a scoped query;
- restart plus `--no-seed` smoke proves stored records and owner login survive.

The local proxy checks remain `pnpm docker:smoke` and
`pnpm railway:mcp-query-smoke`; the latter name is historical.

## Alternatives Considered

- Split Fly apps with `*.internal` private DNS: rejected for the selected path
  because it adds complexity and does not improve the first-live-test proof.
- Fly "Launch on Fly" button: rejected as the primary claim because it is not a
  generally available Railway-template equivalent for this repo.
- Manual `fly postgres attach --variable-name PDPP_DATABASE_URL`: valid fallback,
  but no longer the primary path because `DATABASE_URL` fallback lets `--db` work.
- Separate Fly-specific Docker target: rejected. `platform-core` is intentionally
  platform-neutral and shares the proven one-service supervisor.

## Residual Risks

- The exact `fly launch --from ... --config deploy/flyio/fly.toml` command still
  requires live proof against Fly after these artifacts land.
- Fly's unmanaged Postgres option is operator-managed. The runbook calls this out
  and points operators to Fly Managed Postgres or an external provider for
  production-grade database operations.
