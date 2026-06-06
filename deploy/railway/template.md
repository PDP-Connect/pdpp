# Railway template publication handoff

This handoff is for publishing a Railway Template that lets an operator deploy a
PDPP Core reference node with one button. The deployed node is the operator's own
instance.

## Selected template shape

The selected template uses one application service plus a Postgres plugin.

| Service | Source | Public networking | Healthcheck path |
|---|---|---:|---|
| `core` | `ghcr.io/vana-com/pdpp/railway-core:<version-tag>` | enabled | `/.well-known/oauth-authorization-server` |
| `Postgres` | Railway plugin | disabled | n/a |

The `railway-core` image is built from the root `Dockerfile` target
`railway-core`. It runs:

- the operator console on Railway's injected `$PORT`;
- the Authorization Server on `127.0.0.1:7662`;
- the Resource Server on `127.0.0.1:7663`;
- the console proxy with internal `PDPP_AS_URL` / `PDPP_RS_URL` loopback targets.

This is the selected SLVP for the public button because live testing showed that
a separate private `reference` image service requires an explicit service `PORT`
to boot reliably, and Railway turns that `PORT` into an extra required deploy
prompt. The one-service image preserves one public origin and private AS/RS
listeners without asking the deploying operator for topology constants.

Pin a concrete version tag, never `latest` or a moving tag, so the template is
reproducible.

## Source accessibility gate

The template source must be reusable by an arbitrary Railway user. A private
source or private image is not a valid public template source unless the
template intentionally and safely supplies reusable public access; this template
does not embed registry credentials.

Before publishing the user-facing button:

```sh
pnpm railway:ghcr-public --tag <version-tag>
```

The probe exits `0` only when `ghcr.io/vana-com/pdpp/railway-core:<version-tag>`
is anonymously pullable.

The probe's pass/fail logic is unit-tested offline by
`scripts/check-railway-ghcr-public.test.mjs`.

## Variables

Set these on the `core` service:

```sh
PDPP_REFERENCE_ORIGIN=https://${{core.RAILWAY_PUBLIC_DOMAIN}}
PDPP_OWNER_PASSWORD=<required user-provided secret>
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Do not set these as Railway service variables on `core`:

```sh
PORT
AS_PORT
RS_PORT
PDPP_AS_URL
PDPP_RS_URL
```

Railway injects `PORT`. The image owns the internal AS/RS ports and loopback
proxy targets. Keeping those constants out of the service-variable set prevents
extra deploy-page prompts.

Set these on the `Postgres` service:

```sh
PGDATA=${{RAILWAY_VOLUME_MOUNT_PATH}}/pgdata
POSTGRES_PASSWORD=${{ secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") }}
DATABASE_URL=postgresql://postgres:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/postgres
```

The Postgres image defaults the user and database to `postgres`. `PGDATA` must
stay under the Railway volume mount path.

## Publish flow

1. Create a source Railway project.
2. Add the `core` service from Docker Image
   `ghcr.io/vana-com/pdpp/railway-core:<version-tag>`.
3. Add a Railway Postgres plugin.
4. Configure variables exactly as listed above.
5. Generate a public domain for `core`.
6. Run the live smoke:

   ```sh
   node scripts/railway-mcp-query-smoke.mjs \
     --origin https://<core-domain> \
     --owner-password "$PDPP_OWNER_PASSWORD"
   ```

7. Restart `core`, then rerun:

   ```sh
   node scripts/railway-mcp-query-smoke.mjs \
     --origin https://<core-domain> \
     --owner-password "$PDPP_OWNER_PASSWORD" \
     --no-seed
   ```

8. Generate a template from the validated project.
9. Inspect the generated template config. It should contain exactly one required
   user-provided app value: `core.PDPP_OWNER_PASSWORD`. It must not ask for
   `PORT`, `AS_PORT`, `RS_PORT`, `PDPP_AS_URL`, or `PDPP_RS_URL`.
10. Publish the template from the workspace template list.
11. Deploy a fresh scratch project from the published template and rerun the
    live smoke plus restart smoke.
12. Replace `<template-code>` in the chosen user-facing button surface with
    Railway's assigned template code.

## Button markup

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<template-code>?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core)
```

Do not publish the placeholder URL. A docs/site surface should carry the button
only after `<template-code>` has been replaced with the published template code.

### `<template-code>` replacement checklist

- [ ] `pnpm railway:ghcr-public --tag <version-tag>` exits `0`.
- [ ] The published template deploys a fresh scratch project.
- [ ] The chosen surface's button URL has `<template-code>` replaced with the
      real code and keeps
      `?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core`.
- [ ] No user-facing surface shows `<template-code>` as a clickable button.

## Template QA

Before presenting the button to users:

```sh
pnpm railway:template:test
pnpm railway:ghcr-public:test
pnpm railway:env-check:test
pnpm railway:mcp-query-smoke:test
pnpm railway:ghcr-public --tag <version-tag>
```

Then deploy a new scratch project from the published template, not from the
hand-built source project. Confirm the generated project has exactly one public
app service (`core`) plus Postgres, run the live smoke, restart `core`, and rerun
the smoke with `--no-seed`.

The template is not ready for user-facing placement until the scratch deploy
passes the live smoke and restart check.
