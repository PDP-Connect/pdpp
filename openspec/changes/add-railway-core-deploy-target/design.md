# Design: add-railway-core-deploy-target

## Scope

In scope: the durable deployment-target contract for running the existing
reference Docker assembly as a Core node on a managed platform (Railway first),
the platform-neutral deploy artifacts that reproduce it, and the executable
first-live-test acceptance. Out of scope: any runtime code change to the AS, RS,
console, storage layer, or connectors. This change is configuration, deploy
artifacts, documentation, and the spec delta that makes them auditable.

## The topology decision (the load-bearing call)

**Decision: single public console front door + private reference service +
explicit durable storage. Two application services. Configuration only.**

The reference server binds two HTTP listeners in one Node process — AS on
`AS_PORT` (default `7662`) and RS on `RS_PORT` (default `7663`)
(`reference-implementation/server/index.js`, `asApp.listen` / `rsApp.listen`).
A managed platform routes one public port per service. Two of the three prior
reports treated this as the gating constraint and concluded the live test must
either expose the Resource Server only, or run two public services (`as` + `rs`)
with cross-origin metadata config.

Reading the actual routing code shows that conclusion is wrong for the supported
deploy shape, because the public front door is **not** the reference image — it
is the console:

- `apps/console/src/app/reference-proxy.ts` proxies requests to the internal AS
  or RS using `PDPP_AS_URL` / `PDPP_RS_URL`, deleting the inbound `host` and
  setting `x-forwarded-host` / `x-forwarded-proto` from the public request.
- App Router route handlers cover the full protocol surface:
  `mcp/route.ts` -> RS, `v1/[...path]/route.ts` -> RS,
  `oauth/[...path]/route.ts` -> AS,
  `well-known/oauth-authorization-server/route.ts` -> AS,
  `well-known/oauth-protected-resource/[[...path]]/route.ts` -> RS. The
  `proxy.ts` middleware additionally fronts `/_ref`, `/connectors`, `/neko`,
  `/__pdpp`, `/agent-connect`, `/grants/*/revoke`, and the `/dashboard`
  owner-auth redirect.
- `reference-implementation/server/reference-topology.ts` switches to composed
  mode when `PDPP_REFERENCE_ORIGIN` / `AS_PUBLIC_URL` / `RS_PUBLIC_URL` is set, so
  the AS issuer and RS resource advertise the single public origin while
  `PDPP_AS_URL` / `PDPP_RS_URL` keep the internal targets private.
- `scripts/docker-smoke.sh` already exercises this end to end against the real
  images and asserts `issuer === origin`, `resource === origin`,
  `authorization_servers[0] === origin`, no internal-URL leak, and the
  `/dashboard` -> `/owner/login` redirect.

So the supported managed-platform shape is the same composed-origin topology the
smoke test validates: the console is a single Next.js standalone process on
`$PORT` (`Dockerfile` console stage: `HOSTNAME=0.0.0.0`, `PORT=3000`, which the
platform's injected `$PORT` overrides), it is the only public origin, and it
reaches a **private** reference service over the platform's private network. No
path-prefix support and no new combined listener are required, because each of
the AS and RS still believes it owns a whole origin — the console multiplexes by
path on the public side and by `PDPP_AS_URL` / `PDPP_RS_URL` on the private side.

Dockerfile note that reinforces the split: the `reference` stage descends
`FROM browsers` and bakes Chromium; the `console` stage descends `FROM base` and
is already browser-free. Putting the console on the public origin means the
internet-facing service carries no browser binary; the browser bloat lives only
on the private reference service (and can be slimmed later by a `core` target —
a follow-on, not a blocker).

## Alternatives considered

- **Resource-Server-only single service** (current-docs report's SLVP). Rejected
  as the supported shape: it proves only the RS path, cannot exercise the OAuth
  issuance / owner-console / device-approval surfaces, and abandons the
  composed-origin model the codebase already implements and tests. It is a
  narrower test of less, not a smaller test of the real claim.
- **Two public services `as` + `rs`** with cross-origin metadata. Rejected:
  two public origins is more surface and more operator config to get right
  (lower confidence), and it is unnecessary because the console already presents
  one origin. This is the shape only if the console is deliberately excluded,
  which this change does not do.
- **Host-header routing / a new reverse proxy** (slvp-plan report's 1B).
  Rejected as unnecessary: the console is already the reverse proxy. Building a
  second one would duplicate `reference-proxy.ts`.
- **Operator console as a separate third public service.** Deferred. The console
  *is* the front door here; a separate split is not needed for a Core test and
  would add a public origin.

## Storage decision

Two supported durable options, operator's choice; the contract forbids the
non-durable default either way.

- **Managed Postgres** (`PDPP_STORAGE_BACKEND=postgres`,
  `PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}`). Schema bootstraps idempotently
  at boot (`postgres-storage.js` `bootstrapPostgresSchema`, `CREATE TABLE IF NOT
  EXISTS` + guarded `DO $$` blocks called from `startServer()`), so no separate
  migrate step and no volume. This is the cleaner managed-platform fit: the DB
  persists independently of the app container, and a redeploy does not force the
  app down for a volume remount. Railway's managed Postgres is plain `postgres`,
  not `pgvector`; the reference falls back to grant-scoped JSONB vector storage,
  which is fine for a Core test that leaves semantic retrieval off.
- **SQLite on a mounted persistent volume** with `PDPP_DB_PATH` pointed onto the
  volume. Cheapest (one fewer service). Caveat the contract makes explicit: the
  default `PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite` is **not** under the
  documented `/root/.pdpp` named volume, so the operator must set `PDPP_DB_PATH`
  onto the actually-mounted path or lose data; and a volume-backed service incurs
  brief redeploy downtime on the platform.

The restart-survival check in the acceptance gate is what proves whichever
storage choice is actually durable before it is trusted.

## Security posture for a public origin

- `PDPP_OWNER_PASSWORD` is required and non-empty. The shipped
  `.env.docker.example` default is empty, and with it empty the dashboard and
  device-approval surfaces render live owner data and approve flows anonymously
  (`owner-auth.ts` fall-through; console `verify-session.ts`). On a public URL
  that is catastrophic, so the deploy contract requires it and the live gate
  verifies the `/dashboard` -> `/owner/login` redirect.
- HTTPS with trusted forwarded-proto so owner-session / CSRF cookies are marked
  `Secure` (`owner-auth.ts` `isSecureRequest` honors `x-forwarded-proto`; the
  console proxy forwards it). The platform terminates TLS and sets the header.
- The owner-session HMAC key derives from `PDPP_OWNER_PASSWORD`
  (`sha256("pdpp-owner-session:" + password)`), so owner sessions survive a
  restart as long as the password is stable; tokens persist in storage. There is
  no `PDPP_SESSION_SECRET` to set.
- No connector credentials and no `PDPP_CREDENTIAL_ENCRYPTION_KEY` are needed for
  a Core query test; the credential store fails closed without the key, which is
  acceptable because the first slice stores no static-secret connectors.
- The private reference service is not published; only the console origin is
  internet-reachable. Upstream token-kind gates (`requireOwner` /
  `requireClient` / `requireClientOrMcpPackage`) remain the authoritative
  authorization, unchanged by this change.

## First-live-test acceptance (the executable gate)

A live platform run is requested only after the same acceptance passes against a
local composed-origin stack. The live run validates platform specifics (real
TLS, real public DNS, volume / managed-DB durability across a real restart), not
first-discovery of application bugs.

1. Deploy contract applied: one public console service, one private reference
   service, durable storage, `PDPP_REFERENCE_ORIGIN` / `PDPP_AS_URL` /
   `PDPP_RS_URL` set to the real public origin and the private internal targets.
2. Service reaches healthy unattended via the healthcheck path
   (`/.well-known/oauth-authorization-server` on the public console).
3. Composed-origin smoke assertions hold against the public origin: AS `issuer`,
   RS `resource`, and RS `authorization_servers[0]` all equal the public origin,
   and no internal service name leaks.
4. `GET /_ref/deployment` (owner-gated) reports the deploy facts; semantic
   retrieval shows as an honest "not enabled," not a defect.
5. Owner console is password-gated over HTTPS: an anonymous `/dashboard` hit
   redirects to `/owner/login`; a valid owner session passes.
6. Hosted MCP at the public `/mcp` refuses anonymous access and completes
   `tools/list` for a scoped grant/token; one scoped record query returns
   data from a small hand-imported record set (no connector run).
7. Restart the service; owner login and stored records survive; re-run the query
   and the doctor checks.
8. Rollback/cleanup path documented and exercised: redeploy the prior image (or
   tear down the project) returns to a known-good or clean state without
   orphaning the public origin or the volume.

## Acceptance checks (local, before any live request)

- `openspec validate add-railway-core-deploy-target --strict` passes.
- `openspec validate --all --strict` passes.
- `pnpm docker:smoke` passes from the main checkout (composed-origin assertions +
  owner-gating redirect on the real images) — the canonical local proxy for
  acceptance steps 2, 3, and 5.
- `pnpm railway:mcp-query-smoke:test` passes for the live-query harness decision
  logic, and `pnpm railway:mcp-query-smoke -- --origin <origin> --owner-password
  <pw>` proves anonymous `/mcp` refusal plus a scoped `query_records` success
  against a running composed origin.
- `pnpm railway:sqlite-restart-smoke` boots on SQLite forced onto the persistent
  volume, seeds through the MCP query smoke, force-recreates the private
  reference container, and proves records plus owner login survive (acceptance
  step 7's durability check).
- The documented service env blocks are consistent with `.env.docker.example`;
  `git diff --check` is clean; all deploy-doc links/paths exist; voice-guide self-check
  (operator-voice, honest cost framing, Core / Collection / reference kept
  distinct, no hosted-service "sign up / we sync / our service" language).

## Residual risks

- The deploy artifacts and the live gate are validated against a local
  composed-origin stack and the routing code; no live platform run is performed
  in this planning lane. The live run is the owner's, and its acceptance is the
  list above.
- The `docs/inbox/chatgpt-pro-deployment.txt` strategy note is untracked and
  unversioned; the decisions that survive are the ones promoted into this change,
  not the inbox text. Its aspirational names (`pdpp doctor`,
  `PDPP_OWNER_AUTH_MODE`, `PDPP_PUBLIC_ROUTES`, `PDPP_MCP_ENABLED`,
  `PDPP_SESSION_SECRET`) have no implementation and are not part of this contract.
- SQLite-on-volume durability is itself part of what the live test proves; the
  managed-Postgres option is the lower-risk default for anything beyond the
  cheapest test.
