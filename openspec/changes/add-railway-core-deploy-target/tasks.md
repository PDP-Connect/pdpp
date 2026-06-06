# Tasks: add-railway-core-deploy-target

Topology is decided (single public console front door + private reference
service + explicit durable storage; configuration only — see `design.md`). The
slices below make the first live test reproducible. They are documentation and
deploy artifacts plus a verification harness; none requires a runtime code change
to the AS, RS, console, storage layer, or connectors. Doctor CLI is an explicit
follow-on, not a blocker. The browser-free Core reference image is part of this
change because the live Railway pushbutton path must not carry browser runtime
bloat.

## 1. Deploy artifacts and env contract

- [x] 1.1 Add `deploy/railway/` with a runbook describing the two services
  (public console, private reference), the storage choice (managed Postgres or
  SQLite-on-volume), the healthcheck path, and the rollback/cleanup steps.
  (`deploy/railway/README.md`.)
- [x] 1.2 Add a documented environment block (public origin, `PDPP_AS_URL` /
  `PDPP_RS_URL` private targets, owner password, storage vars,
  `NODE_ENV=production`, semantic off) and confirm it is consistent with
  `.env.docker.example`. (`deploy/railway/console.env.example`,
  `deploy/railway/reference.env.example`, and consolidated reference
  `deploy/railway/env.example` — same variable names and meanings as
  `.env.docker.example`, Railway-scoped subset.)
- [x] 1.3 Add (or reference) a `railway.json` / config-as-code pointing at the
  service Dockerfile paths (console public, reference private) and the
  healthcheck path; document the `$PORT` mapping for the console standalone server.
  (`deploy/railway/railway.console.json`, `deploy/railway/railway.reference.json`;
  the reference service uses `deploy/railway/reference.Dockerfile` so a Railway
  template can select it by Dockerfile path, and the README notes that `$PORT`
  is Railway-injected — do not set `PORT`.)
- [x] 1.4 Add an operator-voice "Deploy on Railway" section to the deployment
  guide; run the `docs/voice-and-framing.md` self-check (no hosted-service
  language; Core / Collection / reference / console kept distinct; honest cost
  framing). (`deploy/railway/README.md`; self-check run, only match for
  "sign up" is the negation.)
- [x] 1.5 Add a template-safe reference service Dockerfile so the private service
  can be selected by Dockerfile path instead of a manual Docker build-target
  setting. (`deploy/railway/reference.Dockerfile`;
  `deploy/railway/railway.reference.json`.)
- [x] 1.6 Add the Railway Template publication handoff and deploy-button markup,
  including the exact service shape, variable bindings, scratch-template QA, and
  the rule that the placeholder button URL is not user-facing until Railway
  assigns a template code. (`deploy/railway/template.md`;
  `pnpm railway:template:test`.)
- [x] 1.7 Add a Railway upload ignore file so local runtime proof deployments do
  not traverse machine-local agent skill symlinks. Local uploads are proof
  artifacts only; they are not a valid public template source.
  (`.railwayignore`.)

## 2. Storage persistence

- [x] 2.1 Document the managed-Postgres path (`PDPP_STORAGE_BACKEND=postgres`,
  `PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}`, idempotent boot bootstrap, no
  migrate step, no volume) as the lower-risk default. (README "Storage" Option A;
  `env.example`.)
- [x] 2.2 Document the SQLite-on-volume path and the `PDPP_DB_PATH`-onto-mounted-
  volume requirement, calling out that the default `/var/lib/pdpp/pdpp.sqlite`
  is not on the documented `/root/.pdpp` volume. (README "Storage" Option B;
  `env.example`; the env-contract check fails an unmounted-default SQLite path.)
- [x] 2.3 Verify restart survival for the chosen backend in the local harness
  (records and owner session persist across a container restart).
  (`scripts/railway-sqlite-restart-smoke.sh`, `pnpm railway:sqlite-restart-smoke`.)
  Boots the composed stack with SQLite forced onto the persistent `pdpp-home`
  volume (`PDPP_DB_PATH=/root/.pdpp/pdpp.sqlite`, overriding the unmounted
  default), seeds via the step-3.2 harness, force-recreates the `reference`
  container (`docker compose up -d --force-recreate --no-deps reference` — the
  named volume persists, the writable layer does not), then re-queries
  `--no-seed` and re-checks owner login. Requires Docker + a built image, so it
  is the live-gate proxy (acceptance step 7), not a CI unit test; the pass/fail
  logic it relies on is unit-tested offline in
  `scripts/railway-mcp-query-smoke.test.mjs`. The owner-only live run (step 5.1)
  still observes durability across a real platform restart.

## 3. First-live-test verification harness

- [x] 3.1 Wire the composed-origin smoke (`scripts/docker-smoke.sh`) as the
  canonical local proxy for the health, metadata-consistency, and
  owner-gating-redirect acceptance steps. (README "First-live-test gate" cites
  `pnpm docker:smoke` as the local proxy for steps 2/3/5; confirmed the console
  proxies `/.well-known/oauth-authorization-server`, the documented healthcheck
  path.)
- [x] 3.2 Add a deterministic record-seed (hand-imported fixture, no connector
  run) and a scripted external MCP `tools/list` + scoped record query that
  asserts anonymous refusal and scoped success against the local composed-origin
  stack. (`scripts/railway-mcp-query-smoke.mjs`, `pnpm railway:mcp-query-smoke`.)
  The seed registers a fixture connector manifest and writes a deterministic
  record set over the owner-gated `POST /v1/ingest/:stream` path — owner-token
  mint via owner login + device flow, then RS ingest — with no browser connector
  run. The query path proves an anonymous `/mcp` request is refused (401), then
  mints a scoped client grant (DCR + authorization-code + consent approval) and
  runs `initialize` → `tools/list` (asserts `query_records` is advertised) →
  `query_records` (asserts the seeded records return). Zero-dependency Node
  `fetch`, like `check-railway-deploy-env.mjs`; the pure decision logic is
  unit-tested offline by `scripts/railway-mcp-query-smoke.test.mjs` (19 tests,
  `pnpm railway:mcp-query-smoke:test`). The go/no-go checklist records the live
  run as steps 5–6.
- [x] 3.3 Document the live go/no-go checklist and the rollback/cleanup path.
  (README "First-live-test gate" and "Rollback and cleanup".)

  Added beyond the original list: `scripts/check-railway-deploy-env.mjs` (+
  `.test.mjs`, 21 tests) — a deterministic, offline env-contract preflight that
  catches the avoidable misconfigurations (no/non-HTTPS origin, empty owner
  password, mismatched shared service values, console AS/RS targets that do not
  use Railway private networking, missing reference healthcheck `PORT`, and
  non-durable or unmounted-default storage) before a live run.

## 4. Follow-on and image-slimming work

- [x] 4.1 (Deferred) `pdpp doctor` CLI (human + `--json`) consuming
  `GET /_ref/deployment` for the Core subset. Deferred by design, not required:
  smoke + diagnostics already cover the gate.
- [x] 4.2 Promote the private `reference` image to a browser-free Core AS/RS
  runtime for Railway and keep browser execution out of the pushbutton profile.
  The root Dockerfile retains an explicit `reference-browser` target for profiles
  that need Patchright/Chromium; `deploy/railway/reference.Dockerfile` uses the
  slim Core shape directly so Railway templates do not pull browser binaries.

## 5. Owner-only live verification

- [ ] 5.1 (Owner-only) Execute the first live Railway run against the acceptance
  gate in `design.md` (real TLS, real public DNS, durability across a real
  restart). Record the result; if this is the only remaining open task, convert
  it to a Residual Risk and archive per `AGENTS.md`.
- [ ] 5.2 (Owner-only) Publish the Railway Template from a validated project,
  deploy a new scratch project from the published template, run the live smoke
  and restart smoke against the scratch deploy, then replace `<template-code>` in
  the user-facing button surface.
- [ ] 5.3 (Owner-only) Satisfy the public source gate before publishing the
  button: either make the template repository source public/reusable by Railway
  users or use public anonymously pullable app images. Do not publish a template
  generated from local upload-only services.

## Acceptance checks

Run before handing back and before any live platform run is requested:

- `openspec validate add-railway-core-deploy-target --strict` — passes.
- `openspec validate --all --strict` — passes.
- `git diff --check` — clean.
- `pnpm railway:template:test` — passes: the reference service uses the
  template-safe Dockerfile path, the runbook does not require manual target-stage
  setup, and the handoff carries Railway deploy-button markup plus required
  variable bindings.
- `pnpm docker:smoke` (from the main checkout) — passes: composed-origin
  assertions (`issuer` / `resource` / `authorization_servers[0]` equal the public
  origin, no internal-URL leak) and the `/dashboard` -> `/owner/login` redirect on
  the real images. Proxy for acceptance steps 2, 3, and 5.
- `node --test scripts/railway-mcp-query-smoke.test.mjs` (offline, zero deps) —
  19/19 passing. Unit-proves the seed corpus, MCP JSON-RPC framing, dual-
  transport response parsing, seeded-record assertion, anonymous-refusal
  classifier, and owner-login form parsing the live harness depends on.
- `pnpm railway:mcp-query-smoke -- --origin <origin> --owner-password <pw>`
  (requires a running composed origin) — seeds a deterministic record set with
  no connector run and proves anonymous `/mcp` refusal plus a scoped
  `query_records` success (acceptance steps 5–6).
- `pnpm railway:sqlite-restart-smoke` (from the main checkout, Docker) — boots on
  SQLite forced onto the persistent volume, seeds, force-recreates the reference
  container, and survives with the records + owner login intact (acceptance step
  7 durability check).
- Documented service env blocks are consistent with `.env.docker.example`; all
  deploy-doc links/paths exist; voice-guide self-check passes.
