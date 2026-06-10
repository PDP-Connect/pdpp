# Tasks: add-docker-core-deploy-target

## 1. Image Gaps

- [x] 1.1 Default `PDPP_REFERENCE_ORIGIN=http://localhost:3000` and
  `PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite` in the `railway-core` stage so the
  zero-flag quickstart works and persists on the named volume.
- [x] 1.2 Add `deploy/railway/core-first-boot.mjs` and wire it into
  `core-supervisor.mjs`: generate/persist/banner the owner password when
  unset, reuse silently on later boots, env var always wins, never logged
  outside the one-time banner; provision a persisted credential encryption
  key file for SQLite boots only.

## 2. Canonical User-Facing Paths

- [x] 2.1 Add `deploy/docker/README.md` with the quickstart one-liner and the
  production compose runbook (flyio README tone).
- [x] 2.2 Add `deploy/docker/docker-compose.yml`: reference + web + Postgres
  (pgvector), healthchecks, named volumes, fail-fast `:?` secrets, no
  published Postgres port.
- [x] 2.3 Add `deploy/docker/site-copy-proposal.md` for the reference page's
  progressive-disclosure deploy section (proposal only; no component work).

## 3. Tests And Gates

- [x] 3.1 Add `scripts/docker-core-first-boot.test.mjs`
  (`pnpm docker:first-boot:test`) covering generate/persist/banner-once,
  env-wins, blank-file regeneration, unpersistable-dir warning, SQLite key
  provisioning, Postgres fail-closed key contract.
- [x] 3.2 Extend `scripts/check-railway-template-artifacts.test.mjs` to pin
  the new image defaults and the supervisor first-boot wiring.
- [x] 3.3 Build `docker build --target railway-core .` locally and prove with
  a throwaway container + volume: first boot prints the banner; a container
  replacement on the same volume reuses the password without reprinting and
  the owner login succeeds. 2026-06-10: done, evidence in the change commit
  message and the worker report (image built from this tree; banner observed
  on boot 1, absent on boot 2 with `owner password loaded from
  /var/lib/pdpp/owner-password`; `POST /owner/login` 302 with session cookie
  on both boots; resources removed after capture).

## 4. Owner-Only Follow-Ups

- [ ] 4.1 Update the reference page deploy section from
  `deploy/docker/site-copy-proposal.md` (site copy is proposal-only in this
  change).
- [ ] 4.2 Confirm `ghcr.io/vana-com/pdpp/railway-core:main` stays anonymously
  pullable before publishing the quickstart on the site
  (`pnpm railway:ghcr-public --tag main`).
- [ ] 4.3 Re-run the quickstart proof against the next published GHCR image
  (the local proof in 3.3 used a locally built image from this tree).

## Acceptance Checks

- `node --test scripts/docker-core-first-boot.test.mjs` — passes (11/11).
- `node --test scripts/check-railway-template-artifacts.test.mjs` — passes
  (10/10).
- `node --check deploy/railway/core-supervisor.mjs` /
  `node --check deploy/railway/core-first-boot.mjs` — clean.
- `docker compose -f deploy/docker/docker-compose.yml config` — fails fast
  without the two required secrets; renders with them.
- `pnpm spec:check` — passes.
- Live quickstart proof — recorded in 3.3.
