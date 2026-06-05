# Railway template publication handoff

This handoff is for publishing a Railway Template that lets an operator deploy a
PDPP Core reference node with one button. The deployed node is still the
operator's own instance; this is not a hosted PDPP service.

Sources verified on 2026-06-05:

- Railway template creation: <https://docs.railway.com/templates/create>
- Railway publish/share flow and button markup:
  <https://docs.railway.com/templates/publish-and-share>
- Railway config-as-code schema: <https://railway.com/railway.schema.json>
- Railway private networking:
  <https://docs.railway.com/networking/private-networking>
- Railway variables and reference variables:
  <https://docs.railway.com/variables>
- Railway Postgres: <https://docs.railway.com/databases/postgresql>

## Template shape

Create the template from a Railway project with these services:

| Service     | Source           | Dockerfile path                      | Public networking | Healthcheck path |
|-------------|------------------|--------------------------------------|-------------------|------------------|
| `console`   | this repository  | `Dockerfile`                         | enabled           | `/.well-known/oauth-authorization-server` |
| `reference` | this repository  | `deploy/railway/reference.Dockerfile` | disabled          | `/.well-known/oauth-authorization-server` |
| `Postgres`  | Railway plugin   | n/a                                  | disabled          | n/a |

Do not configure a Docker target stage in the template. Railway's published
config schema supports `build.dockerfilePath`, but not a Docker build-target
field. The template-safe construction is to choose a Dockerfile whose final stage
is the service image:

- `Dockerfile` final stage: public `console`
- `deploy/railway/reference.Dockerfile` final stage: private `reference`

## Variables

Set these on both application services:

```sh
PDPP_REFERENCE_MODE=composed
PDPP_REFERENCE_ORIGIN=https://${{console.RAILWAY_PUBLIC_DOMAIN}}
PDPP_OWNER_PASSWORD=<required user-provided secret>
PDPP_OWNER_SUBJECT_ID=owner_local
```

If the template composer cannot bind `PDPP_REFERENCE_ORIGIN` to the console
service's public domain before publication, mark `PDPP_REFERENCE_ORIGIN` as a
required user-provided variable with this description: "The public HTTPS domain
assigned to the console service, including https://".

Set these on the public `console` service:

```sh
PDPP_AS_URL=http://reference.railway.internal:7662
PDPP_RS_URL=http://reference.railway.internal:7663
PDPP_ENABLE_DASHBOARD=1
```

Do not set `PORT` on the console service; Railway injects it.

Set these on the private `reference` service:

```sh
NODE_ENV=production
PORT=7662
AS_PORT=7662
RS_PORT=7663
PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1
PDPP_RS_URL=http://127.0.0.1:7663
PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0
PDPP_STORAGE_BACKEND=postgres
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

`PDPP_OWNER_PASSWORD` must be the same non-empty value on both application
services. `PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}` binds the reference
service to the Postgres plugin and gives Railway an explicit dependency.

## Publish flow

1. Create a scratch Railway project from the current `main` branch.
2. Add the `console` service from this repository and set its Dockerfile path to
   `Dockerfile`.
3. Add the `reference` service from this repository and set its Dockerfile path
   to `deploy/railway/reference.Dockerfile`.
4. Add a Railway Postgres plugin.
5. Configure variables exactly as listed above.
6. Generate a public domain for `console`; do not generate a public domain for
   `reference`.
7. Run the live smoke:

   ```sh
   node scripts/railway-mcp-query-smoke.mjs \
     --origin https://<console-domain> \
     --owner-password "$PDPP_OWNER_PASSWORD"
   ```

8. Restart the `reference` service, then rerun:

   ```sh
   node scripts/railway-mcp-query-smoke.mjs \
     --origin https://<console-domain> \
     --owner-password "$PDPP_OWNER_PASSWORD" \
     --no-seed
   ```

9. From the Railway project canvas, use Settings -> Generate Template from
   Project, verify the two app services and Postgres plugin in the template
   composer, then create the template.
10. Publish the template from the workspace template list.
11. Replace `<template-code>` in the button markup below with the code Railway
    assigns.

## Button markup

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<template-code>?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core)
```

Do not publish the placeholder URL. A docs/site surface should carry the button
only after `<template-code>` has been replaced with the published template code.

## Template QA

Before presenting the button to users:

1. Run local checks from the repo:

   ```sh
   pnpm railway:template:test
   pnpm railway:env-check:test
   pnpm railway:mcp-query-smoke:test
   pnpm railway:sqlite-restart-smoke
   ```

2. Deploy a new scratch project from the published template, not from the
   hand-built source project.
3. Confirm the generated project has exactly one public app service (`console`),
   the private `reference` service, and Postgres.
4. Run the live smoke against the scratch template deploy.
5. Restart `reference` and rerun the live smoke with `--no-seed`.

The template is not ready for user-facing placement until the scratch deploy
passes the live smoke and restart check.
