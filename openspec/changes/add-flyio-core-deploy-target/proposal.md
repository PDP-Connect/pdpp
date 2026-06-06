# Proposal: add-flyio-core-deploy-target

## Why

The reference implementation already carries a durable managed-platform deploy
contract — defined in `add-railway-core-deploy-target` — that proves a Core node
boots, gates owner data, persists storage, and answers an authenticated MCP query
on a single public HTTPS origin. Railway is the first concrete target because it
has the lowest-friction pushbutton path. Fly.io is the natural second target: it
offers persistent Postgres via a managed add-on, private networking between
services, and a straightforward `fly launch` / `fly deploy` CLI path that fits
the same composed-origin topology without a new abstraction.

Where Railway offers a one-click published Template, Fly.io does not have an
equivalent anonymous-deploy button built on public GHCR images. A Fly.io "Launch
on Fly" button exists in early platform form but is not yet the same level of
maturity as Railway's Template system — so this change documents the closest
honest SLVP path: a scripted `fly launch` + `fly deploy` setup that an operator
can reproduce in under ten minutes from a clean Fly account, rather than
pretending a pushbutton equivalent exists. The deploy contract (one public
console service, one private reference app, explicit durable Postgres, owner
password required) is identical to the Railway target.

## What Changes

- Add a `reference-implementation-architecture` spec delta (appended to the
  Railway delta) defining a **Fly.io Core deploy target** that satisfies the
  same platform-neutral contract: single public console app, private reference
  app reachable only over Fly's private WireGuard network (`<app>.internal`), and
  durable Postgres via a `fly postgres` cluster.
- Add `deploy/flyio/` with a `fly.toml` for the console app, a
  `fly.reference.toml` for the private reference app, documented env blocks, and
  a runbook covering first deploy, health/smoke checks, owner gating, and rollback.
- Document the honest delta from Railway: no anonymous-deploy button yet; the
  operator path is `fly launch` + `fly postgres create` + `fly deploy` using
  public GHCR images or a build-from-source clone. Lean on existing `fly`
  toolchain rather than inventing a wrapper that adds surface without adding value.
- Add a narrow `scripts/check-flyio-deploy-env.mjs` offline env-contract
  preflight (mirrors the Railway equivalent) that catches misconfigurations
  before a live deploy.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Configuration, deploy artifacts, and documentation only. Does not change the
  PDPP protocol, API semantics, connector behavior, or the storage schema.
- The same composed-origin topology and smoke harness (`pnpm docker:smoke`,
  `pnpm railway:mcp-query-smoke`) apply directly; no Fly-specific runtime change
  is required.
- Explicitly out of scope: a Fly.io "Launch on Fly" button (no mature equivalent),
  browser collection, semantic retrieval, the scheduler, n.eko, multi-region
  deploys, and Tigris/R2 object storage adjuncts.
- A future slice could add a Fly.io "Launch on Fly" button when Fly matures its
  template/one-click ecosystem; this change records the current honest state and
  leaves a placeholder.
