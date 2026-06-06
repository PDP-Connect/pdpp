# Tasks: add-flyio-core-deploy-target

Topology is decided (single public console app + private reference app +
explicit Fly Postgres; see `design.md`). The platform-neutral deploy contract
from `add-railway-core-deploy-target` applies; this slice adds Fly.io-specific
artifacts, documents the honest CLI-based operator path, and wires the offline
preflight. No pushbutton equivalent exists yet; the runbook documents that
plainly and leaves a placeholder.

## 1. Deploy artifacts and env contract

- [x] 1.1 Add `deploy/flyio/fly.toml` for the public console app: `[build]`
  pointing at the root `Dockerfile` (final stage = console), `[http_service]`
  on `internal_port = 3000` with `force_https = true` and
  `auto_stop_machines = "stop"`, healthcheck path
  `/.well-known/oauth-authorization-server`. (`deploy/flyio/fly.toml`.)
- [x] 1.2 Add `deploy/flyio/fly.reference.toml` for the private reference app:
  `[build]` with `dockerfile = "Dockerfile"` and `target = "reference"`,
  **no** `[http_service]` or `[[services]]` block (private-only), exposes
  ports `7662` / `7663` as internal-only via `[[vm]]` and env defaults.
  (`deploy/flyio/fly.reference.toml`.)
- [x] 1.3 Add documented env blocks (`deploy/flyio/console.env.example`,
  `deploy/flyio/reference.env.example`): same variables as the Railway
  equivalents, substituting `*.internal` hostnames for Railway's
  `${{reference.RAILWAY_PRIVATE_DOMAIN}}` syntax.
- [x] 1.4 Add operator-voice `deploy/flyio/README.md` runbook: topology diagram,
  step-by-step deploy commands (`fly launch`, `fly postgres create`,
  `fly postgres attach`, `fly deploy`), env wiring, healthcheck verification,
  first-live-test gate (references `pnpm docker:smoke` and
  `pnpm railway:mcp-query-smoke` as platform-neutral harnesses), rollback and
  teardown. Run the `docs/voice-and-framing.md` self-check (no hosted-service
  language; honest pushbutton assessment; Core/Collection/reference/console
  distinct; honest cost framing). (`deploy/flyio/README.md`.)
- [x] 1.5 Include a "Launch on Fly" button placeholder in the README with an
  explicit note that no live link exists yet; document what a future slice
  would need to fill it.

## 2. Offline env-contract preflight

- [x] 2.1 Add `scripts/check-flyio-deploy-env.mjs` that validates the Fly.io
  env contract offline: `PDPP_REFERENCE_ORIGIN` is HTTPS, `PDPP_AS_URL` /
  `PDPP_RS_URL` use `*.internal` hostnames (not public URLs or localhost),
  `PDPP_OWNER_PASSWORD` is non-empty, `PDPP_DATABASE_URL` is present, no
  cross-service URL confusion. Zero-dependency Node `fetch`-free static check;
  mirrors `check-railway-deploy-env.mjs` in structure.
- [x] 2.2 Add `scripts/check-flyio-deploy-env.test.mjs` with deterministic
  offline tests covering valid config, each required-field absence, HTTPS
  enforcement, non-internal AS/RS URL rejection, and empty-password rejection.
  Add `pnpm flyio:env:check:test` script.

## 3. OpenSpec spec delta

- [x] 3.1 Add `openspec/changes/add-flyio-core-deploy-target/specs/
  reference-implementation-architecture/spec.md` with requirements and scenarios
  for the Fly.io deploy target: private app networking, Fly Postgres, honest
  pushbutton assessment, and the same first-live-test gate as Railway.

## 4. Owner-only live verification

- [ ] 4.1 (Owner-only) Execute the first live Fly.io run against the acceptance
  gate in `design.md`: `fly launch` + `fly postgres create` + `fly postgres
  attach` + `fly deploy`, then run the composed-origin smoke assertions and
  `pnpm railway:mcp-query-smoke -- --origin <fly-origin> --owner-password <pw>`,
  plus a restart-survival check. Record the result; if this is the only
  remaining open task, convert to a Residual Risk and archive.
- [ ] 4.2 (Owner-only / future slice) Replace the "Launch on Fly" placeholder
  button with a live link when Fly.io's one-click template ecosystem matures
  and meets the source-accessibility gate (public GHCR images or public repo
  source).

## Acceptance checks

Run before handing back:

- `openspec validate add-flyio-core-deploy-target --strict` — passes.
- `openspec validate --all --strict` — passes.
- `git diff --check` — clean.
- `node --test scripts/check-flyio-deploy-env.test.mjs` — passes (offline,
  zero-dependency).
- `pnpm docker:smoke` (from the main checkout) — passes: composed-origin
  assertions and the `/dashboard` -> `/owner/login` redirect. Proxy for
  acceptance steps 2, 3, and 5 (Fly.io-agnostic, same assertions).
- Documented env blocks are consistent with `.env.docker.example`; all
  deploy-doc links/paths exist; voice-guide self-check passes.
