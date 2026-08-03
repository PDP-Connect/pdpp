# Friend self-host acceptance harness

This gate proves the "first external friend" self-host journey end to end:
clean startup, owner login, first source add, a Gmail-style static-secret
connector, the ChatGPT browser-backed connector, a second static-secret
connector, credential issue/revoke without leaking secrets, an MCP client
connect+query as a Claude-Code-compatible client, and clean teardown. It
drives the same public protocol surface the documented friend path uses —
[`self-service-gmail-mcp.md`](./self-service-gmail-mcp.md) and
[`hosted-mcp-setup.md`](./hosted-mcp-setup.md) — against one running
deployment, never a mock of it.

It reuses the existing owner-journey/release-matrix machinery rather than
duplicating product models: `scripts/lib/owner-session.ts` for owner login,
the same device-code and authorization-code+PKCE flows the reference
integration tests and `scripts/railway-mcp-query-smoke.ts` already exercise,
and the same `deploy/docker/docker-compose.yml` blessed self-service stack
`scripts/docker-smoke.sh` uses.

## Structural vs live

Every journey step is labeled:

- **`structural`** — proven with no real provider credentials. Every
  connector step captures a synthetic fixture secret through the real
  credential-capture route (`POST /_ref/connections/:id/static-secret-credential`);
  nothing here talks to a real Gmail, GitHub, or ChatGPT account. This mode
  runs identically against an in-process reference server
  (`scripts/friend-journey-acceptance/friend-journey-acceptance.test.ts`, no
  Docker, no network) or a live composed origin.
- **`live`** — requires a real browser-capable surface (the ChatGPT
  connector's required `browser` binding). On a network-only deployment
  (no `--profile browser`), this step is *skipped with a named reason* — the
  fail-closed 503 `browser_runtime_unavailable` guard in
  `ref-static-secret-draft-connection.ts` refusing the draft-connection
  before any credential is stored, exactly as the friend-ready program
  requires. It is never silently marked passing. With
  `--profile browser` (the `core-browser` + n.eko service), the real
  credential-capture path runs instead of being skipped.

## Fail-closed on missing release artifacts

Before any live step is attempted, `scripts/friend-journey-acceptance/release-artifacts.ts`
checks that `deploy/docker/docker-compose.yml` and the required Dockerfile
build targets (`reference`, `console`, `core-browser`) exist in this
checkout. A missing artifact produces a named, actionable finding and the run
stops there — it never falls through to `docker compose up` against a
partial or absent release surface.

## Running it

Offline (no Docker, no live provider credentials, safe for every PR):

```sh
pnpm friend-journey:acceptance
pnpm friend-journey:acceptance:test
```

Live, against a real `docker compose up` of the blessed stack (network-only;
ChatGPT is proven via its fail-closed refusal):

```sh
pnpm friend-journey:acceptance:live
```

Live, with the browser profile enabled (ChatGPT's static-secret capture runs
for real, still with a synthetic fixture credential — no live ChatGPT
account is used):

```sh
node --import tsx scripts/check-friend-journey-acceptance.ts --live --profile browser
```

Each live run uses a throwaway `COMPOSE_PROJECT_NAME`, a freshly generated
owner password and credential-encryption key, and tears the stack down with
`docker compose down --volumes --remove-orphans` in a `finally` block —
teardown runs even if a journey step throws. The harness then verifies no
containers or labeled volumes remain for that project before reporting
success.

## Secrets

The owner password and credential-encryption key are generated per run and
never printed. Every fixture connector secret is synthetic
(`friend-e2e-synthetic-*`), never a real provider credential — this harness
must never be pointed at a real Gmail, GitHub, or ChatGPT account. The
credential issue/revoke step (`scripts/friend-journey-acceptance/journey.ts`)
asserts its own log and report detail strings never contain the minted
bearer token before they reach the report renderer.

## Report

A markdown report is written to `tmp/workstreams/friend-journey-acceptance-<timestamp>.md`
(`--no-report` to skip). It lists the release-artifact check, every journey
step with its mode and result, and the teardown verdict — never a secret
value, only the owner-auth *mode* and step outcomes, matching the posture of
[`check-owner-journey-acceptance.ts`](../../scripts/check-owner-journey-acceptance.ts)'s
own report.
