# Railway template publication handoff

This handoff describes a possible Railway Template for an operator-owned PDPP
Core node. It is not the blessed self-service path. The current image shortcut
is withdrawn until an exact registry manifest is proven; use the pinned
`reference/web:sha-cc07e3a` Compose pair on port `3000` and deployed `/connect`
for the supported journey.

## Selected template shape

The selected template uses one application service plus a Postgres plugin.

| Service | Source | Public networking | Healthcheck path |
|---|---|---:|---|
| `core` | Pinned source build from the repository | enabled | Railway default; externally probe `/.well-known/oauth-authorization-server` |
| `Postgres` | Railway plugin | disabled | n/a |

The single-service source build runs:

- the operator console on Railway's injected `$PORT`;
- the Authorization Server on `127.0.0.1:7662`;
- the Resource Server on `127.0.0.1:7663`;
- the console proxy with internal `PDPP_AS_URL` / `PDPP_RS_URL` loopback targets.

This is the selected SLVP for the public button because live testing showed that
a separate private `reference` image service requires an explicit service `PORT`
to boot reliably, and Railway turns that `PORT` into an extra required deploy
prompt. The one-service image preserves one public origin and private AS/RS
listeners without asking the deploying operator for topology constants.

Pin a concrete repository revision so the source build is reproducible. Do not
publish an image-backed template without an exact registry manifest.

There is no current registry-proven image candidate for this alternate lane.
Do not advertise or pull an image tag from this handoff. A future candidate must
pass `docker manifest inspect` for the exact image before the live template and
scratch-project gates can begin.

Current published template:

| Field | Value |
|---|---|
| Template code | `pdpp-core-template-source` |
| Template ID | `<your-template-id>` |
| Source project | `<your-project-id>` |
| Scratch proof project | `<verification-project-id>` |
| Scratch proof origin | `https://<your-app>.up.railway.app` |

## Source accessibility gate

The template source must be reusable by an arbitrary Railway user. A private
source or private image is not a valid public template source unless the
template intentionally and safely supplies reusable public access; this template
does not embed registry credentials.

Before publishing any user-facing button:

```sh
pnpm railway:ghcr-public --tag <version-tag>
```

The probe is only a pre-publication gate for a future exact image. A passing
offline test is not evidence that a registry manifest exists.

The probe's pass/fail logic is unit-tested offline by
`scripts/check-railway-ghcr-public.test.ts`.

## Variables

Set these on the `core` service:

```sh
PDPP_REFERENCE_ORIGIN=https://${{core.RAILWAY_PUBLIC_DOMAIN}}
PDPP_OWNER_PASSWORD=<required user-provided secret>
PDPP_CREDENTIAL_ENCRYPTION_KEY=${{ secret(64) }}
PDPP_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Optional, for the API-backed Google Maps Data Portability source:

```sh
GOOGLE_DATAPORTABILITY_CLIENT_ID=<google-oauth-client-id>
GOOGLE_DATAPORTABILITY_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_DATAPORTABILITY_REDIRECT_URI=https://${{core.RAILWAY_PUBLIC_DOMAIN}}/_ref/provider-auth/callback
GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS=
```

These are deployment-level Google OAuth app settings. Keep them optional in the
public button unless the template can supply a reusable approved OAuth app;
otherwise they become extra deploy-page prompts for a source many operators may
not enable.

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
2. Add the `core` service from a pinned source revision.
3. Add a Railway Postgres plugin.
4. Configure variables exactly as listed above.
5. Generate a public domain for `core`.
6. Run the live smoke:

   ```sh
   node --import tsx scripts/railway-mcp-query-smoke.ts \
     --origin https://<core-domain> \
     --owner-password "$PDPP_OWNER_PASSWORD"
   ```

7. Restart `core`, then rerun:

   ```sh
   node --import tsx scripts/railway-mcp-query-smoke.ts \
     --origin https://<core-domain> \
     --owner-password "$PDPP_OWNER_PASSWORD" \
     --no-seed
   ```

8. Generate a template from the validated project.
9. Inspect the generated template config. It should contain exactly one required
   user-provided app value: `core.PDPP_OWNER_PASSWORD`; `core.PDPP_CREDENTIAL_ENCRYPTION_KEY`
   must be generated by the template with `${{ secret(64) }}`. It must not ask
   for `PORT`, `AS_PORT`, `RS_PORT`, `PDPP_AS_URL`, or `PDPP_RS_URL`.
10. Publish the template from the workspace template list.
11. Deploy a fresh scratch project from the published template and rerun the
    live smoke plus restart smoke.
12. Replace any placeholder template code in the chosen user-facing button
    surface with Railway's assigned template code.

## Button markup

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/pdpp-core-template-source?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core)
```

Do not publish a placeholder URL. A docs/site surface should carry the button
only after the real template code has been installed and scratch-verified.

### Template-code replacement checklist

- [ ] An exact image manifest passes `docker manifest inspect` for any future
      image-backed publication.
- [x] The published template deploys a fresh scratch project.
- [x] The chosen surface's button URL uses `pdpp-core-template-source` and keeps
      `?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core`.
- [x] No user-facing surface shows a placeholder template code as a clickable
      button.

## Prior scratch notes

Historical scratch notes are not current artifact or publication evidence. Do
not use them to justify pulling an image or presenting a Railway button. Re-run
the source-build, manifest, live-template, and scratch-project gates for any
future publication.

## Template QA

Before presenting the button to users:

```sh
pnpm railway:template:test
pnpm railway:ghcr-public:test
pnpm railway:env-check:test
pnpm railway:mcp-query-smoke:test
pnpm railway:ghcr-public --tag <version-tag>
```

For future template revisions, deploy a new scratch project from the published
template, not from the hand-built source project. Confirm the generated project
has exactly one public app service (`core`) plus Postgres, run the live smoke,
restart `core`, and rerun the smoke with `--no-seed`.
