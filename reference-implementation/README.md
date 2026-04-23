# PDPP Reference Implementation

This package is the forkable PDPP reference substrate in this repository.

It contains the current:

- authorization server and resource server
- Collection Profile runtime
- CLI
- reference manifests and sample connector
- executable black-box test suite

It is not the website. The website in `apps/web/` explains and showcases the reference implementation, but the runnable implementation lives here.

## What it proves today

The current provider-connect story is intentionally thin and honest. It proves:

- standards-based discovery via RFC 9728 protected-resource metadata and RFC 8414 AS metadata
- PAR-backed request staging through `POST /oauth/par`
- protected dynamic client registration through `POST /oauth/register`
- a consent shell and approval surface for issued grants
- owner self-export through the device flow
- pre-registered and dynamically registered client paths for the current third-party connect flow

It does **not** yet prove:

- a full generic third-party authorization-code redirect flow
- a broader ecosystem profile beyond the currently advertised metadata and `authorization_details` type

## What this package is proving

The current reference is centered on one architectural claim:

- one engine substrate can support both a **native provider** realization and a **polyfill/connector** realization
- public source identity stays honest:
  - `provider_id` for native providers such as `Northstar HR`
  - `connector_id` for collected/polyfill sources such as Spotify
- owner self-export, client grants, and reference-only traces can all be exercised against the same running system

## Package layout

- `server/`
  - authorization server, resource server, metadata, consent, grant issuance, introspection
- `runtime/`
  - Collection Profile runner and related runtime helpers
- `cli/`
  - `pdpp` CLI for owner login, export, provider inspection, grant staging, and trace/timeline inspection
- `manifests/`
  - sample connector manifests plus the native `northstar-hr` manifest
- `test/`
  - black-box integration, metadata, CLI, event-spine, and Collection Profile conformance tests
- `lib/`
  - shared implementation helpers such as the durable event spine

## Primary surfaces

### Discovery

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

### Client request start

- `POST /oauth/par`

### Client registration

- `POST /oauth/register`

Dynamic client registration is enabled **by default** for local reference use.
When neither `PDPP_DCR_INITIAL_ACCESS_TOKENS` nor `startServer()`'s
`dynamicClientRegistrationInitialAccessTokens` opt is set, the reference AS
falls back to a shared reference-local default token exported from
[`server/reference-local-defaults.js`](server/reference-local-defaults.js).
This keeps the forkable reference usable out of the box without silently
widening the protocol contract.

Overrides:

- `PDPP_DCR_INITIAL_ACCESS_TOKENS=token1,token2` — comma-separated initial
  access tokens. When set, the reference server only accepts these tokens.
- `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` — explicitly disables DCR. The
  AS metadata then omits `registration_endpoint` and advertises only
  `pdpp_registration_modes_supported: ["pre_registered_public"]`.

Default pre-registered public clients seeded at startup include the real
first-party demo clients (`longview`, `longview_planning_v1`, `cli_longview`,
`concert_recommendation_app`) plus the dashboard/bootstrap clients
`pdpp-web-dashboard` and `pdpp-polyfill-owner-bootstrap` so owner device
bootstrap from the dashboard and the polyfill orchestrator works out of the
box. The pre-registered set is reference-local convenience; production
deployments should supply their own `preRegisteredPublicClients` option.

### Consent and grant issuance

- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`

The reference AS also exposes a stable owner-entry page at `GET /owner/login`.
It behaves as a small reference-only owner access hub:

- when `PDPP_OWNER_PASSWORD` is unset, it explains that placeholder auth is
  disabled and points operators at the hosted device approval UI
- when `PDPP_OWNER_PASSWORD` is set, it renders the owner sign-in form
- when already signed in, it becomes a signed-in landing page with device
  approval and sign-out actions

### Owner self-export

- `POST /oauth/device_authorization`
- `GET /device`
- `POST /device/approve`
- `POST /oauth/token`

### Resource access

- `/v1/streams/...`
- owner and client queries under the current reference contract

For reference inspection, successful and route-level rejected `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/records`, and `/v1/streams/:stream/records/:id` responses also expose:

- `Request-Id`
- `PDPP-Reference-Trace-Id`

That pair lets a caller correlate a live query response to `GET /_ref/traces/:traceId` without widening the `_ref` surface itself.

### Reference-only debugging surfaces

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/dataset/summary`

These `_ref` endpoints are intentionally reference-only artifacts, not core PDPP protocol requirements.

`GET /_ref/dataset/summary` returns a live aggregate description of what the
substrate is holding: connector count, stream count, live record count, and
three separately-labeled byte totals (`record_json_bytes` for live payloads,
`record_changes_json_bytes` for retained change history, `blob_bytes` for
blobs), summed into `total_retained_bytes`. Counts exclude soft-deleted
records. The response also carries two pairs of temporal bounds:
`earliest_record_time` / `latest_record_time` are real-world timestamps
mined from record payloads via each stream's manifest-declared
`consent_time_field`, and `earliest_ingested_at` / `latest_ingested_at` are
the substrate's own `emitted_at` bounds (when the runtime wrote each row).
Plus a top-3 `top_connectors` list. Used by the operator-console hero band;
see `openspec/changes/reference-implementation-program/design-notes/dashboard-hero-plan-2026-04-22.md`
for the design rationale.

### Reference-only owner-auth placeholder

The reference ships a minimal local-only owner-auth placeholder for the current owner/operator browser surfaces. It is **not** part of the PDPP protocol and is **not** a finished owner-auth product. See
[`openspec/changes/reference-implementation-program/design-notes/owner-auth-placeholder-open-question-2026-04-22.md`](../openspec/changes/reference-implementation-program/design-notes/owner-auth-placeholder-open-question-2026-04-22.md)
for scope and rationale.

Environment variables:

- `PDPP_OWNER_PASSWORD` — if set, the current owner/operator browser surfaces below require a valid owner session. If unset, the server keeps its current open local-dev behavior.
- `PDPP_OWNER_SUBJECT_ID` — optional. Defaults to `owner_local`. When placeholder auth is enabled, this value is the owner subject id used for every approved grant and device authorization; any `subject_id` submitted from a form or JSON body is ignored.

Routes gated by the placeholder (when enabled):

- `GET /consent`, `POST /consent/approve`, `POST /consent/deny`
- `GET /device`, `POST /device/approve`, `POST /device/deny`
- `/dashboard`, `/dashboard/*` (via the composed web origin)

Stable owner-entry routes:

- `GET /owner/login` — owner access page (supports a safe same-origin `return_to` query parameter). When placeholder auth is disabled it renders an honest disabled-state landing page; when enabled it renders either the sign-in form or a signed-in landing page.
- `POST /owner/login` — when placeholder auth is enabled, submits the owner password; on success sets a signed HTTP-only session cookie (`pdpp_owner_session`, 12 hour lifetime, `SameSite=Lax`, `Secure` when served over HTTPS) and redirects to `return_to`
- `POST /owner/logout` — clears the session cookie when present

Unauthenticated HTML requests to the protected routes redirect to `/owner/login?return_to=...`; non-HTML callers receive an honest `401` with error code `owner_session_required`.

The placeholder is intentionally narrow:

- no user table, no external IdP, no multi-user auth
- stateless HMAC-signed session cookie — rotating `PDPP_OWNER_PASSWORD` invalidates existing sessions
- public protocol surfaces (`/oauth/par`, `/oauth/register`, `/oauth/token`, `/v1/*`, `/.well-known/*`) are **not** gated
- the placeholder is still not a durable owner-auth story; it is only the current reference-local browser/session gate

### Reference-only hosted-UI layer

Server-rendered HTML pages (`GET /consent`, `GET /device` and its result pages, `POST /consent/approve`/`deny` result pages, and the stable owner-entry page at `GET /owner/login`) all go through a small shared hosted-UI module, [`server/hosted-ui.js`](server/hosted-ui.js). That module renders the PDPP brand mark and typography, reuses the `data-surface="human"` / `data-surface="protocol"` language from `packages/pdpp-brand/base.css`, and serves a single shared stylesheet at `GET /__pdpp/hosted-ui.css`.

This hosted-UI layer is **reference-only** implementation support. It is **not** a PDPP protocol surface; clients and providers never need to fetch `/__pdpp/hosted-ui.css` or consume any of the `hosted-ui-*` class names. The React/Next website in `apps/web/` remains the canonical design-system surface.

## How to use it

### Same-origin local reference composition

The preferred local reference-product entrypoint is now the composed browser
origin at `http://localhost:3000`.

Run the full local stack from the repo root:

```bash
pnpm dev
```

In that mode:

- the Next app serves the browser-facing origin on `http://localhost:3000`
- the internal AS/RS still listen on `:7662` / `:7663`
- the browser-facing origin proxies the reference namespaces:
  - `/.well-known/*`
  - `/oauth/*`
  - `/v1/*`
  - `/_ref/*`
  - `/owner/*`
  - `/device`
  - `/consent`
  - `/__pdpp/hosted-ui.css`
- when `PDPP_OWNER_PASSWORD` is set, `/owner/*` and `/dashboard/*` share the
  same `pdpp_owner_session` cookie on the browser-facing origin

If you only need the backing AS/RS side of that composed setup while the web
app is already running, start this package in composition mode:

```bash
pnpm --dir reference-implementation dev
```

That mode pins `AS_PUBLIC_URL` and `RS_PUBLIC_URL` to
`http://localhost:3000` so the internal AS/RS advertise the browser-facing
origin in metadata, device verification URLs, and PAR authorization URLs.

### Standalone reference server

Run the server:

```bash
pnpm --dir reference-implementation server
```

That starts the AS/RS directly on their own listen ports (`:7662` / `:7663`)
without the composed browser-facing web origin.

Inspect the CLI:

```bash
pnpm --dir reference-implementation cli --help
```

Run the test suite:

```bash
pnpm --dir reference-implementation test
```

Verify the generated contract artifacts are current:

```bash
pnpm reference-contract:check-generated
```

### Example third-party client app

A minimal example app illustrates the **current** thin reference
provider-connect flow end to end (register &rarr; PAR &rarr; owner approval
&rarr; token &rarr; RS query). It lives at
[`examples/third-party-app/`](examples/third-party-app/) and runs on its own
port (default `7674`) separate from the AS/RS:

```bash
pnpm --dir reference-implementation example-client
```

Defaults: `PORT=7674`, `AS_URL=http://localhost:7662`, `RS_URL=http://localhost:7663`.

The example supports both approval modes honestly:

- when the reference server runs without `PDPP_OWNER_PASSWORD`, the example
  uses the reference-local JSON shortcut at `POST /consent/approve` and
  captures the token inline
- when `PDPP_OWNER_PASSWORD` is set, the inline shortcut is refused by the
  reference server. The example surfaces that honestly, links out to the
  hosted `/consent` page, and lets you paste the issued token back

The example is a third-party client illustration — it is **not** a full
generic OAuth authorization-code redirect client. It has no PKCE, no
`/callback`, and no code exchange. It only exercises the endpoints the
reference currently advertises.

## Published generated artifacts

The reference publishes generated machine-readable and human-readable contract
artifacts derived from `@pdpp/reference-contract`. These are treated as
versioned reference outputs, not throwaway build noise.

- `openapi/reference-public.openapi.json`
  - public PDPP JSON APIs only
- `openapi/reference-full.openapi.json`
  - public APIs plus reference-only `/_ref` operator surfaces
- `docs/generated/reference-routes.md`
  - generated route index for public APIs
- `docs/generated/reference-ref-routes.md`
  - generated route index for reference-only APIs
- `docs/generated/query-cookbook.md`
  - generated query and flow cookbook

Regenerate them with:

```bash
pnpm reference-contract:generate
```

## Relationship to the root PDPP specs

The root `spec-*.md` files remain normative for PDPP protocol semantics.

This package is the executable reference implementation:

- use the root specs to understand what PDPP means
- use this package to see what the current reference actually does
- use OpenSpec to understand project-level architecture and active implementation changes
