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

- [x] 4.1 Execute a live Fly launch using the documented command. 2026-06-10:
  executed the documented image-backed `fly launch` (org `the owner-nunamaker`, app
  `pdpp-core-b29574`, region `iad`, image
  `ghcr.io/vana-com/pdpp/railway-core:sha-39232ac`, anonymously pullable —
  `pnpm railway:ghcr-public --tag sha-39232ac` passed). The command created the
  app, provisioned and attached Fly Postgres `pdpp-core-b29574-db`
  (`flyio/postgres-flex:17.2`, `DATABASE_URL` secret over flycast), set
  `PDPP_OWNER_PASSWORD`, wrote a valid config, resolved the image, and
  allocated public IPs — then was refused at the final release step because the
  org had no payment method: `failed to create release (status 422):
  {"error":"This functionality is disabled for trial organizations. Please add
  a credit card ..."}`. Reproduced deterministically with `fly deploy`.
  Deviations recorded verbatim: (a) added `--vm-memory 512` to match the
  committed `fly.toml` `[[vm]]` sizing (launch default is larger); (b) billing
  gate forced creating the Core machine directly from the same image via the
  Machines API, which the same trial org permits: `fly machine run
  ghcr.io/vana-com/pdpp/railway-core:sha-39232ac -a pdpp-core-b29574 -r iad
  --name core --vm-memory 512 --port 80:3000/tcp:http --port
  443:3000/tcp:tls:http --autostart --autostop=stop --env
  PDPP_REFERENCE_ORIGIN=https://pdpp-core-b29574.fly.dev` (machine
  `7846469c632058`); `force_https` and the documented healthcheck are not
  expressible as `machine run` flags, so HTTPS behavior was verified directly.
  Deployed image digest:
  `sha256:0e9f25cfd85994ffaabe805ff1cac729acd8c304e171227976091080fd38f1ae`.
  App secrets in place: `PDPP_OWNER_PASSWORD` (generated), `DATABASE_URL`
  (attach-generated); values not recorded. Postgres schema bootstrapped
  idempotently at first boot via the injected standard `DATABASE_URL` with
  `PDPP_DATABASE_URL` absent, proving the 2.1 runtime fallback live.
- [x] 4.2 Run public metadata, owner-gating, MCP smoke, and restart-survival
  checks. 2026-06-10 against `https://pdpp-core-b29574.fly.dev`:
  (1) `curl -fsS $ORIGIN/.well-known/oauth-authorization-server` → HTTP 200,
  `issuer`/`authorization_endpoint`/`token_endpoint`/`registration_endpoint`
  all on the Fly origin; `curl -fsS
  $ORIGIN/.well-known/oauth-protected-resource` → HTTP 200, `resource` and
  `authorization_servers[0]` equal the Fly origin; no loopback/internal
  hostname leaked. (2) anonymous `curl -sv $ORIGIN/dashboard` → 307 `location:
  /owner/login?return_to=%2Fdashboard`; anonymous `GET /_ref/deployment` → 401
  `owner_session_required`, no data served. (3) `pnpm railway:mcp-query-smoke
  -- --origin $ORIGIN --owner-password ...` passed end-to-end: owner login,
  owner token mint, fixture manifest registered (201), 2 records seeded,
  anonymous `/mcp` refused with 401, scoped client token minted, `tools/list`
  advertised `query_records` (14 tools), and `query_records` returned
  `railway-seed-artist-1`/`railway-seed-artist-2`. (4) restart survival:
  `fly machine restart 7846469c632058` (user-source restart event,
  `requested_stop=true`, confirmed in `fly machine status`), then
  `pnpm railway:mcp-query-smoke -- ... --no-seed` passed — owner login and the
  previously seeded records survived the restart out of Fly Postgres.
  Procedural note: `fly apps restart` listed the machine but logged no restart
  event in this flyctl version (v0.4.59); `fly machine restart` is the
  verified restart path. Resilience observation: ~40s after first boot an idle
  Postgres connection drop (`Connection terminated unexpectedly`, pg pool)
  crashed the reference via uncaughtException; the supervisor exit triggered a
  machine restart and the app recovered cleanly with no data loss.
- [x] 4.3 Record the live result in this change. If live verification is the only
  remaining owner-only task, convert any remaining platform caveat into Residual
  Risks before archive. 2026-06-10: live evidence recorded above; the trial-org
  release gate and the idle-connection crash/recovery observation were
  converted into Residual Risks in `design.md`; the payment-method account
  prerequisite was added to `deploy/flyio/README.md`. Closeout also restored
  `deploy/flyio/core.env.example` (referenced by task 1.2 and the README
  preflight, but never tracked: the `.gitignore` `core.*` core-dump rule
  silently swallowed it when the one-app artifacts landed in `39232ac6`; a
  `!deploy/*/core.env.example` exemption now pins it);
  `node scripts/check-flyio-deploy-env.mjs --core
  deploy/flyio/core.env.example` fails on the committed placeholders as
  documented. Proof resources were destroyed after evidence capture
  (`fly apps destroy pdpp-core-b29574`, `fly postgres destroy
  pdpp-core-b29574-db`); the launch is reproducible from the documented
  command on a payment-method-verified org.

## Acceptance Checks

- `openspec validate add-flyio-core-deploy-target --strict` — passes.
- `openspec validate --all --strict` — passes.
- `git diff --check` — clean.
- `node --test scripts/check-flyio-deploy-env.test.mjs` — passes.
- `node --test reference-implementation/test/postgres-runtime-storage.test.js`
  — passes.
- `pnpm docker:smoke` — local composed-origin proxy; superseded for this gate by
  the 2026-06-10 live Fly run recorded in section 4.
- Live Fly smoke once owner token is available — done 2026-06-10, recorded in
  section 4: metadata, owner gating, MCP seed + scoped query, and
  restart-survival all passed against `https://pdpp-core-b29574.fly.dev`.
