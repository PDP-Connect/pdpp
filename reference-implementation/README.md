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

### Consent and grant issuance

- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`

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

These `_ref` endpoints are intentionally reference-only artifacts, not core PDPP protocol requirements.

## How to use it

Run the server:

```bash
pnpm --dir reference-implementation server
```

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
