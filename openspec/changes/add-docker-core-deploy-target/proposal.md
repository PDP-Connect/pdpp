# Proposal: add-docker-core-deploy-target

## Why

Railway has a proven one-click Core deploy and Fly.io has a proven one-command
launch, but the Docker path still demands a repository clone, a large env file,
and the development/owner compose stack — the owner's words: "right now I am
overwhelmed looking at the link for docker." The standalone Core image already
contains everything needed; what is missing is two small image gaps (no
localhost origin default, no first-boot owner credential) and a deliberately
small user-facing surface (one `docker run` quickstart, one minimal production
compose) per `design-notes/deploy-surface-parity-2026-06-10.md` and
`docs/research/deploy-button-parity-prior-art-2026-06-10.md`.

## What Changes

- Give the `railway-core`/`platform-core` image standalone defaults:
  `PDPP_REFERENCE_ORIGIN=http://localhost:3000` and
  `PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite`, so a bare
  `docker run -p 3000:3000 -v pdpp_data:/var/lib/pdpp` needs zero `-e` flags
  and actually persists (the prior runtime default was `:memory:`).
- Add a first-boot owner-credential bootstrap to the Core supervisor: when
  `PDPP_OWNER_PASSWORD` is unset, generate one, persist it on the data volume,
  and print a one-time banner with the dashboard URL, the password, and the
  change-it pointer; subsequent boots reuse the persisted password silently.
  The environment variable always wins. SQLite boots also provision a
  persisted credential encryption key file (Railway-template parity); Postgres
  boots keep the explicit fail-closed key contract.
- Add `deploy/docker/` with the quickstart + production runbook, a minimal
  commented production `docker-compose.yml` (reference + web + Postgres with
  pgvector, healthchecks, named volumes, fail-fast required secrets), and a
  site-copy proposal for the reference page's progressive-disclosure deploy
  section.
- Add deterministic tests: `scripts/docker-core-first-boot.test.mjs`
  (`pnpm docker:first-boot:test`) and extended
  `scripts/check-railway-template-artifacts.test.mjs` assertions for the new
  image defaults and supervisor wiring.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Dockerfile defaults, supervisor bootstrap, deploy artifacts, docs, tests.
- Does not change PDPP protocol semantics, connector behavior, or storage
  schema. Managed-platform deploys (Railway template, Fly launch) set these
  variables explicitly and are unaffected.
- Explicitly out of scope: site component redesign (copy proposal only),
  additional platforms (Render, DigitalOcean, Helm), `curl | bash` installers,
  and a hosted compose-file URL.
