# Tasks: add-flyio-core-deploy-target

## 1. Deploy Artifacts And Env Contract

- [x] 1.1 Add `deploy/flyio/fly.toml` for one public Core app using the root
  Dockerfile target `platform-core`, `[http_service]` on internal port 3000, and
  `force_https = true`.
- [x] 1.2 Add `deploy/flyio/core.env.example` for
  `PDPP_REFERENCE_ORIGIN`, `PDPP_OWNER_PASSWORD`, and durable database URL.
- [x] 1.3 Add a `platform-core` Docker target alias for the proven one-service
  Core runtime.
- [x] 1.4 Add operator documentation for the public-image `fly launch` path,
  source-build `fly launch --from` fallback, verification, restart survival,
  rollback, teardown, and the honest no-template-button state.

## 2. Runtime And Preflight

- [x] 2.1 Allow standard `DATABASE_URL` to select Postgres when
  `PDPP_DATABASE_URL` is absent, while keeping `PDPP_DATABASE_URL` as the
  explicit override.
- [x] 2.2 Add `scripts/check-flyio-deploy-env.mjs` for the one-app Fly env
  contract and deterministic tests.

## 3. OpenSpec Delta

- [x] 3.1 Add a `reference-implementation-architecture` spec delta covering the
  one-app Fly Core topology, durable database env, owner gating, first-live-test
  gate, and honest shareable-path language.

## 4. Owner-Only Live Verification

- [ ] 4.1 Execute a live Fly launch using the documented command.
- [ ] 4.2 Run public metadata, owner-gating, MCP smoke, and restart-survival
  checks.
- [ ] 4.3 Record the live result in this change. If live verification is the only
  remaining owner-only task, convert any remaining platform caveat into Residual
  Risks before archive.

## Acceptance Checks

- `openspec validate add-flyio-core-deploy-target --strict`
- `openspec validate --all --strict`
- `git diff --check`
- `node --test scripts/check-flyio-deploy-env.test.mjs`
- `node --test reference-implementation/test/postgres-runtime-storage.test.js`
- `pnpm docker:smoke`
- Live Fly smoke once owner token is available.
