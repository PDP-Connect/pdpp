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

The template uses two application services plus a Postgres plugin. There are two
valid, mutually exclusive source shapes for the two application services; pick one
before generating the template. Both satisfy the source-accessibility gate below.

### Option 1 (selected SLVP): public GHCR image source

Point each application service at a public, anonymously pullable GHCR image. This
is the selected shape for the first published button: it requires making two
already-published inspection images public, which is a smaller disclosure decision
than making the whole monorepo public, and it deploys without a per-service build.

| Service     | Source (Docker Image)                       | Public networking | Healthcheck path |
|-------------|---------------------------------------------|-------------------|------------------|
| `console`   | `ghcr.io/vana-com/pdpp/web:<version-tag>`   | enabled           | `/.well-known/oauth-authorization-server` |
| `reference` | `ghcr.io/vana-com/pdpp/reference:<version-tag>` | disabled      | `/.well-known/oauth-authorization-server` |
| `Postgres`  | Railway plugin                              | disabled          | n/a |

Image mapping (from `.github/workflows/docker-images.yml`): both images are built
from the root `Dockerfile` by stage target. The `web` image is the `console`
stage (the public, browser-free console); the `reference` image is the `reference`
stage (the private, browser-free AS/RS runtime). So the `console` service points
at `…/web` and the `reference` service points at `…/reference`.

A Docker Image source **supersedes** `build.dockerfilePath`: when the service
source is an image, Railway pulls the image and does not run a Dockerfile build,
so `deploy/railway/reference.Dockerfile` and the committed `railway.*.json`
Dockerfile-path blocks are **not** on this deploy path.

Pin a concrete version tag, never `latest` or a moving tag, so the template is
reproducible. The publish pipeline tags semver images with the version stripped of
its leading `v` (`docker/metadata-action` `type=semver,pattern={{version}}`), so a
Git tag `v0.1.0-beta.7` publishes image tag `0.1.0-beta.7`. Confirm the concrete
tag with the source-accessibility probe below before setting it.

### Option 2: public repository + Dockerfile path

Point each application service at the public source repository and select a
Dockerfile whose final stage is the service image. Use this shape only if the
source repository is public.

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

The committed `deploy/railway/railway.console.json` and
`deploy/railway/railway.reference.json` carry the Dockerfile paths for this shape.

## Source accessibility gate

The template source must be reusable by an arbitrary Railway user. A local
`railway up` upload is valid for proving the runtime, but Railway cannot turn an
upload-only service into a reusable template source. A private GitHub repository
or private GHCR image is also not a valid public template source unless the
template includes credentials, which this template SHALL NOT do.

Before publishing the user-facing button, make one source option true:

- (Option 1, selected) The app services use public container images that can be
  pulled anonymously: `ghcr.io/vana-com/pdpp/web` and
  `ghcr.io/vana-com/pdpp/reference`.
- (Option 2) The source repository used by both services is public and Railway
  can build it without organization-specific GitHub access.

If neither is true, stop after the live runtime proof and do not publish the
button.

As of 2026-06-05 both GHCR packages are **private**, so Option 1 requires an
owner-only visibility flip first (the `web` and `reference` packages each:
GitHub -> org `vana-com` -> Packages -> the package -> remove inherited repository
permissions if present -> Change visibility -> Public). Verify the flip with the
committed probe before switching the Railway sources — it exits `0` only when both
images are anonymously pullable, and prints the exact owner action while blocked:

```sh
pnpm railway:ghcr-public                 # both images; exit 0 = gate clear
pnpm railway:ghcr-public --tag <version-tag>   # also assert the pinned tag exists
```

The probe's pass/fail logic is unit-tested offline by
`node --test scripts/check-railway-ghcr-public.test.mjs`. The classifier it uses:
a public package returns `200` and exposes `tags/list`; a private one returns
`401`; a nonexistent path returns `403`. The equivalent inline check (no repo
checkout) is:

```sh
python3 - <<'PY'
import json, urllib.request, urllib.error
def get(u, h=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers=h or {}), timeout=25) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
for img in ["vana-com/pdpp/web", "vana-com/pdpp/reference"]:
    s, b = get(f"https://ghcr.io/token?scope=repository:{img}:pull")
    print(img, "token", s)  # expect 200 after the flip
    if s == 200:
        tok = json.loads(b)["token"]
        ts, tb = get(f"https://ghcr.io/v2/{img}/tags/list",
                     {"Authorization": f"Bearer {tok}", "Accept": "application/json"})
        print("   tags/list", ts, json.loads(tb).get("tags") if ts == 200 else "")
PY
```

(Equivalent: `docker logout ghcr.io && docker pull ghcr.io/vana-com/pdpp/web:<version-tag>`.)
The visibility flip and the template generation are explicit owner actions; this
handoff does not perform them.

## Variables

Set these on the public `console` service:

```sh
PDPP_REFERENCE_ORIGIN=https://${{console.RAILWAY_PUBLIC_DOMAIN}}
PDPP_OWNER_PASSWORD=${{reference.PDPP_OWNER_PASSWORD}}
PDPP_AS_URL=http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7662
PDPP_RS_URL=http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7663
```

`PDPP_OWNER_PASSWORD=${{reference.PDPP_OWNER_PASSWORD}}` makes the console reuse
the single owner password entered for the private reference service. Do not set
`PORT` on the console service; Railway injects it.

Set these on the private `reference` service:

```sh
PDPP_REFERENCE_ORIGIN=https://${{console.RAILWAY_PUBLIC_DOMAIN}}
PDPP_OWNER_PASSWORD=<required user-provided secret>
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The `reference` image supplies the Core constants (`PORT=7662`, `AS_PORT=7662`,
`RS_PORT=7663`, `PDPP_RS_URL=http://127.0.0.1:7663`,
`PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1`, and
`PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0`). The runtime selects Postgres when
`PDPP_DATABASE_URL` is present, so the template does not need a
`PDPP_STORAGE_BACKEND` prompt.

Set these on the `Postgres` service:

```sh
PGDATA=${{RAILWAY_VOLUME_MOUNT_PATH}}/pgdata
POSTGRES_PASSWORD=${{ secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") }}
DATABASE_URL=postgresql://postgres:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/postgres
```

The Postgres image defaults the user and database to `postgres`; the generated
password and `DATABASE_URL` are enough for the reference service binding.
`PGDATA` must stay under the Railway volume mount path or the image rejects
startup.

## Publish flow

1. Create a scratch Railway project.
2. Add the `console` service. For the selected Option 1, set its source to the
   public Docker Image `ghcr.io/vana-com/pdpp/web:<version-tag>`. (Option 2: add
   it from the public repository and set its Dockerfile path to `Dockerfile`.)
3. Add the `reference` service. For Option 1, set its source to the public Docker
   Image `ghcr.io/vana-com/pdpp/reference:<version-tag>`. (Option 2: add it from
   the public repository and set its Dockerfile path to
   `deploy/railway/reference.Dockerfile`.)
4. Add a Railway Postgres plugin.
5. Configure variables exactly as listed above. The deploy page should ask for
   one user-provided value: `reference` service `PDPP_OWNER_PASSWORD`.
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

### `<template-code>` replacement checklist

The placeholder `<template-code>` appears intentionally in `deploy/railway/README.md`
and this file as documentation, not as a live button. When Railway assigns the
code (publish flow step 11), replace it only on the surface that should carry the
real button — do not edit the docs' placeholder away. Before flipping any surface
live:

- [ ] `pnpm railway:ghcr-public` exits `0` (both images public; the publish gate).
- [ ] The published template deploys a fresh scratch project (Template QA below).
- [ ] The chosen surface's button URL has `<template-code>` -> the real code AND
      keeps `?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core`.
- [ ] No surface still shows `<template-code>` as a clickable button (the docs
      placeholders stay as documentation, not links).

## Template QA

Before presenting the button to users:

1. Run local checks from the repo:

   ```sh
   pnpm railway:template:test
   pnpm railway:ghcr-public:test
   pnpm railway:env-check:test
   pnpm railway:mcp-query-smoke:test
   pnpm railway:sqlite-restart-smoke
   pnpm railway:ghcr-public          # live gate: must exit 0 before publishing
   ```

2. Deploy a new scratch project from the published template, not from the
   hand-built source project.
3. Confirm the generated project has exactly one public app service (`console`),
   the private `reference` service, and Postgres.
4. Run the live smoke against the scratch template deploy.
5. Restart `reference` and rerun the live smoke with `--no-seed`.

The template is not ready for user-facing placement until the scratch deploy
passes the live smoke and restart check.
