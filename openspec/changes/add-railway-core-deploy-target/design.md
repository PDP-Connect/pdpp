# Design: add-railway-core-deploy-target

## Scope

In scope: the durable deployment-target contract for running the existing
reference Docker assembly as a Core node on a managed platform (Railway first),
the platform-neutral deploy artifacts that reproduce it, the narrow image/runtime
defaults needed to keep the Railway Template pushbutton, and the executable
first-live-test acceptance. Out of scope: protocol behavior, endpoint semantics,
connector behavior, and any broader runtime redesign. This change is deployment
contract, deploy artifacts, documentation, and the spec delta that makes them
auditable.

## The topology decision (the load-bearing call)

**Decision: single public origin + private AS/RS listeners + explicit durable
storage. For the Railway pushbutton, package the console and reference AS/RS in
one `railway-core` app service.**

The reference server binds two HTTP listeners in one Node process — AS on
`AS_PORT` (default `7662` outside Railway; Railway maps its injected `PORT` to
`AS_PORT`) and RS on `RS_PORT` (default `7663`)
(`reference-implementation/server/index.js`, `asApp.listen` / `rsApp.listen`).
A managed platform routes one primary service port. Two of the three prior
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
smoke test validates: the console is the only public origin and fronts the AS/RS
listeners. No path-prefix support and no new combined listener are required,
because each of the AS and RS still believes it owns a whole origin — the
console multiplexes by path on the public side and by `PDPP_AS_URL` /
`PDPP_RS_URL` on the private side.

For Railway's published button, live testing changed the packaging decision. A
separate private `reference` image service does not reliably boot unless
`PORT=7662` is set as a Railway service variable; when a source project carries
that literal variable, Railway's generated template turns it into an extra
required deploy-page prompt. The selected Railway Template shape therefore uses
one `railway-core` image: the console binds Railway's injected `$PORT`, while
the reference AS listens on `127.0.0.1:7662` and the RS listens on
`127.0.0.1:7663` inside the same container. This preserves one public origin and
private AS/RS listeners while eliminating topology prompts.

Dockerfile note that reinforces the split: the `reference` stage is the
browser-free Core AS/RS runtime. Browser binaries stay out of the Railway Core
image because browser-backed collection is out of scope for this target and runs
off-box through local collectors. The root Dockerfile keeps a separate
`reference-browser` target for future or local profiles that explicitly need
Patchright/Chromium.

## Template publication decision

**Decision: publish the pushbutton Railway Template from a public
`railway-core` image source.**

Railway's template/share docs and live config schema expose a Dockerfile path
(`build.dockerfilePath`) but not a Docker build target field. Earlier artifacts
added service-specific Dockerfile paths for a split-service project, which
remains valid for manual operator experiments. Live template generation then
showed the stronger button constraint: the private `reference` service needs a
literal `PORT` variable, and Railway promotes that variable to a deploy prompt.

The selected construction is therefore one public GHCR image source:
`ghcr.io/vana-com/pdpp/railway-core:<version-tag>`. The image's supervisor owns
the internal AS/RS ports and loopback targets, so the generated template should
ask for one app value: `core.PDPP_OWNER_PASSWORD`.

The template publication itself is still an owner/Railway-console action because
Railway assigns the template code when the workspace publishes the template.
That owner action is narrow and testable: create a project with `core` plus
Postgres, generate the template from that project, publish it, deploy a fresh
scratch project from the published template, run the live smoke and restart
smoke, then replace the placeholder code in the button markup.

The service source is a separate publication gate. A `railway up` local-upload
deployment proves runtime behavior, but Railway cannot generate a reusable
template from upload-only services. A private GitHub repository or private GHCR
image is likewise not sufficient for a public button. The publishable template
must point at either a public repository source or public container images; the
template SHALL NOT embed private registry credentials.

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
- **Railway Template with manual Docker target-stage settings.** Rejected. It is
  acceptable for a hand-built operator run, but not for the pushbutton path:
  current Railway config/schema does not encode the target field, so the
  template would carry hidden manual setup and could deploy the wrong final
  image.
- **Railway Template generated from local upload.** Rejected for the user-facing
  button. It is useful for first-live runtime proof, but Railway rejects
  upload-only services as template sources because another user has no source to
  rebuild from.
- **Two Railway app services for the public button** (`console` public plus
  `reference` private). Rejected for the published button after live evidence:
  the private image service needed explicit `PORT=7662`, and the generated
  template made that a required user prompt. This remains a manual deploy shape,
  not the selected pushbutton shape.

## Storage decision

Two supported durable options, operator's choice; the contract forbids the
non-durable default either way.

- **Managed Postgres** (`PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}`, with
  `PDPP_STORAGE_BACKEND=postgres` optional). The runtime selects Postgres when
  `PDPP_DATABASE_URL` is present, so Railway does not need to prompt users for a
  literal `PDPP_STORAGE_BACKEND=postgres` value. Schema bootstraps idempotently at
  boot (`postgres-storage.js` `bootstrapPostgresSchema`, `CREATE TABLE IF NOT
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
- The reference AS/RS listeners are not public; in the Railway button they bind
  loopback inside the `core` service. Upstream token-kind gates (`requireOwner`
  / `requireClient` / `requireClientOrMcpPackage`) remain the authoritative
  authorization, unchanged by this change.

## First-live-test acceptance (the executable gate)

A live platform run is requested only after the same acceptance passes against a
local composed-origin stack. The live run validates platform specifics (real
TLS, real public DNS, volume / managed-DB durability across a real restart), not
first-discovery of application bugs.

1. Deploy contract applied: one public `core` service, private loopback AS/RS
   listeners, durable storage, and `PDPP_REFERENCE_ORIGIN` set to the real
   public origin. `PDPP_AS_URL` / `PDPP_RS_URL` stay internal image defaults.
2. Service reaches healthy unattended, and
   `/.well-known/oauth-authorization-server` on the public origin returns HTTP
   200. The published Railway template keeps Railway's default healthcheck
   behavior; the well-known probe is the external acceptance check.
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
- `pnpm railway:template:test` passes for the `railway-core` image shape,
  deploy-button handoff, and no stale manual target-stage runbook instruction.
- `pnpm docker:smoke` passes from the main checkout (composed-origin assertions +
  owner-gating redirect on the real images) — the canonical local proxy for
  acceptance steps 2, 3, and 5.
- `pnpm railway:mcp-query-smoke:test` passes for the live-query harness decision
  logic, and `pnpm railway:mcp-query-smoke -- --origin <origin> --owner-password
  <pw>` proves anonymous `/mcp` refusal plus a scoped `query_records` success
  against a running composed origin.
- `pnpm railway:sqlite-restart-smoke` boots on SQLite forced onto the persistent
  volume, seeds through the MCP query smoke, force-recreates the service, and
  proves records plus owner login survive (acceptance step 7's durability check).
- The documented service env blocks are consistent with `.env.docker.example`;
  `git diff --check` is clean; all deploy-doc links/paths exist; voice-guide self-check
  (operator-voice, honest cost framing, Core / Collection / reference kept
  distinct, no hosted-service "sign up / we sync / our service" language).

## Residual risks

- The deploy artifacts and the live gate are validated against a local
  composed-origin stack and the routing code; no live platform run is performed
  in this planning lane. The live run is the owner's, and its acceptance is the
  list above.
- The user-facing Railway button cannot be final until Railway assigns the
  published template code and a fresh project deployed from that published
  template passes the live smoke plus restart smoke.
- The source-accessibility gate remains hard: if the repository and GHCR images
  stay private, the runtime proof can pass but the template cannot be shared with
  arbitrary Railway users.
- The `docs/inbox/chatgpt-pro-deployment.txt` strategy note is untracked and
  unversioned; the decisions that survive are the ones promoted into this change,
  not the inbox text. Its aspirational names (`pdpp doctor`,
  `PDPP_OWNER_AUTH_MODE`, `PDPP_PUBLIC_ROUTES`, `PDPP_MCP_ENABLED`,
  `PDPP_SESSION_SECRET`) have no implementation and are not part of this contract.
- SQLite-on-volume durability is itself part of what the live test proves; the
  managed-Postgres option is the lower-risk default for anything beyond the
  cheapest test.
