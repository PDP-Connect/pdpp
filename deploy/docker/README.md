# Deploy a PDPP Core node with Docker

Two paths, by intent:

- **Quickstart** — one `docker run`, SQLite on a named volume, running on a
  laptop in under a minute. Start here.
- **Production** — a small Docker Compose stack with Postgres + pgvector for a
  node you intend to keep.

Both run the same proven one-service Core runtime as the Railway button and
the Fly.io launch path: the operator console on the public port, the
Authorization Server and Resource Server on loopback inside the container.

## Quickstart

```sh
docker run -d --name pdpp -p 3000:3000 -v pdpp_data:/var/lib/pdpp \
  ghcr.io/pdp-connect/pdpp/railway-core:main
docker logs -f pdpp
```

No flags to fill in. On first boot the container generates an owner password,
saves it to the `pdpp_data` volume, and prints a one-time banner:

```
[railway-core] ────────────────────────────────────────────────────────────────
[railway-core] First boot — generated an owner password for this instance.
[railway-core]
[railway-core]   Dashboard:      http://localhost:3000/dashboard
[railway-core]   Owner password: hCJ3hQ0X8evNNCH9R9KqL5Ai
[railway-core]
[railway-core] Saved to /var/lib/pdpp/owner-password (on the data volume), so restarts keep
[railway-core] this password. To change it, set the PDPP_OWNER_PASSWORD environment
[railway-core] variable and restart; the environment variable always wins.
[railway-core] This password is printed only on first boot.
[railway-core] ────────────────────────────────────────────────────────────────
```

Open the dashboard URL, sign in with the printed password, and connect your
first source. Records live in SQLite on the `pdpp_data` volume; restarts and
container replacements keep your data and your password. Prefer to choose the
password yourself? Add `-e PDPP_OWNER_PASSWORD=...` — the environment variable
always wins and no banner is printed.

The quickstart serves plain HTTP on localhost. That is fine on your own
machine; do not port-forward it to the internet as-is. For a public node, put
an HTTPS reverse proxy in front and set
`-e PDPP_REFERENCE_ORIGIN=https://your-domain` so the advertised OAuth
metadata matches the real origin — or use the production path below.

## Production

[`docker-compose.yml`](./docker-compose.yml) runs the reference and console as
separate services on Postgres with pgvector. No repository clone required:

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/main/deploy/docker/docker-compose.yml
printf 'PDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

The compose file refuses to boot until both secrets exist in `.env` — the
owner password gates the dashboard, and the credential encryption key seals
any connector credentials you store. Keep `.env` with your backups.

Configuration knobs (all optional, set in `.env`):

```sh
PDPP_REFERENCE_ORIGIN=https://pdpp.example.com  # public origin; default http://localhost:3000
PDPP_WEB_PORT=3000                              # published console port
PDPP_POSTGRES_PASSWORD=...                      # change if you ever publish Postgres
PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0               # opt out of semantic search model download
```

To enable the API-backed Google Maps Data Portability source, create a Google
OAuth client for your PDPP origin and add the callback URL to Google exactly as
shown:

```sh
GOOGLE_DATAPORTABILITY_CLIENT_ID=...
GOOGLE_DATAPORTABILITY_CLIENT_SECRET=...
GOOGLE_DATAPORTABILITY_REDIRECT_URI=https://pdpp.example.com/_ref/provider-auth/callback
# Optional: comma-separated documented Maps resource groups; blank = connector default.
GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS=
```

These are deployment-level OAuth app settings. They are not per-account Google
credentials, and a Gmail/Google app password cannot authorize the Google Data
Portability API.

**Browser-backed connectors (ChatGPT, USAA, ...):** the default `reference`
image is browser-free. If you run these connectors inside the reference
container rather than via the local collector, add this to `.env`:

```sh
PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference-browser:main
```

That image includes Patchright and a bundled Chromium so the connector can
launch a headless browser inside the container.

Serve a real domain through your HTTPS reverse proxy (Caddy, Traefik, nginx)
pointed at the `web` port, and set `PDPP_REFERENCE_ORIGIN` to that domain so
owner-session cookies and OAuth metadata are correct.

## Verification

```sh
curl -fsS "$ORIGIN/.well-known/oauth-authorization-server" | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/dashboard"   # 307 -> /owner/login (gated)
```

Sign in at `$ORIGIN/dashboard`, then check Deployment in the console for the
runtime diagnostics surface (`GET /_ref/deployment`).

## Storage and upgrades

- Quickstart: everything (SQLite database, owner password, credential
  encryption key) lives on the `pdpp_data` volume. Back up the volume.
- Production: records live in the `pdpp-postgres-data` volume; secrets live in
  `.env`. Back up both together.

Upgrade by pulling and recreating; volumes persist:

```sh
docker pull ghcr.io/pdp-connect/pdpp/railway-core:main && docker rm -f pdpp && <your docker run>
# or, compose:
docker compose pull && docker compose up -d
```

The published `:main` tag tracks the repository default branch. Pin a
`sha-<rev>` tag (see GHCR) if you want explicit, reproducible upgrades.

## Teardown

```sh
docker rm -f pdpp && docker volume rm pdpp_data        # quickstart
docker compose down --volumes                          # production (deletes data)
```

## Related

- [`deploy/railway/README.md`](../railway/README.md) — the Railway pushbutton
  Core target this image was proven on.
- [`deploy/flyio/README.md`](../flyio/README.md) — the Fly.io `fly launch`
  path for the same image.
- [`deploy/railway/core-first-boot.mjs`](../railway/core-first-boot.mjs) — the
  first-boot owner-credential bootstrap, tested by
  `pnpm docker:first-boot:test`.
- [`../../docker-compose.yml`](../../docker-compose.yml) — the
  development/owner stack (connector credentials, fixtures, browser services);
  not the self-host entry point.
