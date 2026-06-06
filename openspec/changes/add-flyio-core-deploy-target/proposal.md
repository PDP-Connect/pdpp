# Proposal: add-flyio-core-deploy-target

## Why

Railway now has a proven Core deploy target. Fly.io should get the same
platform-neutral Core proof: boot a reference node, gate owner data, persist
storage, and answer an authenticated MCP query on one public HTTPS origin.

The earlier split-service Fly shape is not the SLVP after the Railway proof. Fly
can run the same one-service Core Docker target, and `fly launch --from` can
share that setup as a single CLI command even though Fly does not provide a
Railway-style published Template button.

## What Changes

- Add `deploy/flyio/` with a `fly.toml`, a Core env example, and an operator
  runbook for one public Fly app plus Fly Postgres, including a fast public-image
  launch path and a source-build fallback.
- Add a generic `platform-core` Docker target alias for managed-platform Core
  deploys.
- Allow the runtime to use standard `DATABASE_URL` when `PDPP_DATABASE_URL` is
  absent; `PDPP_DATABASE_URL` remains the explicit override.
- Add `scripts/check-flyio-deploy-env.mjs` and tests for the one-app Fly env
  contract.
- Add a `reference-implementation-architecture` spec delta for the Fly Core
  deploy target and shareable CLI path.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Configuration, deploy artifacts, docs, and a narrow runtime env alias.
- Does not change PDPP protocol semantics, connector behavior, or storage schema.
- Explicitly out of scope: browser collection inside the deployed app, semantic
  retrieval, scheduler operations, n.eko, and a claimed Fly one-click button.
