# Deploy a PDPP Core node with Docker

The blessed self-service path is one pinned Docker Compose stack. It uses the
registry-proven `reference:sha-cc07e3a` and `web:sha-cc07e3a` images, publishes
the operator surface on port `3000`, and keeps the protocol listeners and
Postgres private.

For the one plain self-service journey — including Gmail setup, the health/data
gate, and Claude Code OAuth — use
[`docs/operator/self-service-gmail-mcp.md`](../../docs/operator/self-service-gmail-mcp.md).

## Pinned self-service Compose

[`docker-compose.yml`](./docker-compose.yml) runs the reference and console as
separate services on Postgres with pgvector. No repository clone required:

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/cc07e3a896c2c0df7841da4ec6b2c660ffe1e792/deploy/docker/docker-compose.yml
printf 'PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a\nPDPP_WEB_IMAGE=ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a\nPDPP_REFERENCE_ORIGIN=http://localhost:3000\nPDPP_WEB_PORT=3000\nPDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

That block is macOS/Linux (bash or zsh). On **Windows PowerShell** the same
text is not just awkward, it is broken: `\` is not a line continuation
(PowerShell uses a backtick), `openssl` is usually absent, and `>` writes
UTF-16LE, which `docker compose` cannot read as a `.env` file. Use this
instead — it generates the same two secrets with .NET and writes ASCII:

```powershell
mkdir pdpp; cd pdpp
curl.exe -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/cc07e3a896c2c0df7841da4ec6b2c660ffe1e792/deploy/docker/docker-compose.yml
$ownerBytes = [byte[]]::new(24)
$keyBytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($ownerBytes); $rng.GetBytes($keyBytes)
$owner = [Convert]::ToBase64String($ownerBytes)
$key = ($keyBytes | ForEach-Object { $_.ToString('x2') }) -join ''
@(
  'PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a'
  'PDPP_WEB_IMAGE=ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a'
  'PDPP_REFERENCE_ORIGIN=http://localhost:3000'
  'PDPP_WEB_PORT=3000'
  "PDPP_OWNER_PASSWORD=$owner"
  "PDPP_CREDENTIAL_ENCRYPTION_KEY=$key"
) | Set-Content -Path .env -Encoding ascii
docker compose up -d
```

Use `curl.exe`, not `curl` — bare `curl` in PowerShell is an alias for
`Invoke-WebRequest`, which does not accept these flags.

The compose file refuses to boot until both secrets exist in `.env` — the
owner password gates the dashboard, and the credential encryption key seals
any connector credentials you store. Keep `.env` with your backups.

Configuration knobs (all optional, set in `.env`):

```sh
PDPP_REFERENCE_ORIGIN=https://pdpp.example.com  # remote origin; local default http://localhost:3000
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

## Browser-backed sources (ChatGPT, USAA, ...)

Sources split into two kinds — the dashboard tells you which is which:

| You want | Setup | Services |
| --- | --- | --- |
| Gmail, GitHub, Notion, Oura, YNAB (network-only) | `docker compose up -d` | 3 (`reference`, `web`, `postgres`) |
| ...and also ChatGPT, USAA, Amazon, Chase, Reddit (browser-backed) | add one env var, then `docker compose --profile browser up -d` | 4 (above + `neko`) |

Browser-backed connectors sign in through a real, *viewable* browser session:
the provider may show a Cloudflare challenge or a 2FA prompt that you have to
click yourself. A headless browser cannot do that, and a headed browser inside a
container has no screen, so these connectors need a browser surface you can
watch and control (n.eko). This is why they are not part of the one-command
network-only path.

If you only want the network-only sources, stop here; the dashboard refuses a
browser-backed source up front on a node without a browser surface, rather than
taking your provider password and failing on the first sync.

### Enabling browser-backed sources

Browser-backed connectors are enabled as a Docker Compose profile. The same
`docker-compose.yml` file above runs both modes.

**1. Add one line to `.env`:**

The `neko` service is already defined in the compose file with a `profiles: ["browser"]`
directive, so it is not created by default. To opt in, set the managed connector
in your `.env`:

```sh
PDPP_NEKO_MANAGED_CONNECTORS=https://registry.pdpp.org/connectors/chatgpt
```

All other `PDPP_NEKO_*` settings derive automatically from this single choice.
The wiring is internal to the compose network (service names, no host IPs), so
you never need to look up a container address.

On **Windows PowerShell**, append to `.env` with:

```powershell
Add-Content -Path .env -Value 'PDPP_NEKO_MANAGED_CONNECTORS=https://registry.pdpp.org/connectors/chatgpt' -Encoding ascii
```

**2. Start the full stack with the browser profile:**

```sh
docker compose --profile browser up -d
```

The `reference`, `web`, and `postgres` services start as before; the `neko`
service joins the compose network. Once `reference` is healthy (5-30 seconds),
browser-backed sources are available in the dashboard.

**Release status:** The `neko` and `core-browser` images are newly added to the
release pipeline but have NOT been published yet. Until a release runs, you must
override `PDPP_NEKO_IMAGE` with a locally built image. Add to `.env`:

```sh
PDPP_NEKO_IMAGE=pdpp-neko:local
```

Build that image from this repository with
`docker build -f docker/neko/Dockerfile -t pdpp-neko:local .`. This is the one
step that still needs a clone, and it exists only because the image is not
published yet — it is not part of the steady-state route.

Until you set `PDPP_NEKO_IMAGE`, the compose file resolves the n.eko service to
the placeholder `pdpp-neko-image-not-set`, which fails loudly rather than
pulling a tag that does not exist. The default network-only stack is unaffected:
the n.eko service is not created without `--profile browser`.

Once a release publishes the image, set `PDPP_NEKO_IMAGE` to that released tag.

Serve a remote domain through your HTTPS reverse proxy (Caddy, Traefik, nginx)
pointed at the `web` port, and set `PDPP_REFERENCE_ORIGIN` to that domain so
owner-session cookies and OAuth metadata are correct. Local loopback HTTP is
supported for a local client; do not expose a remote node over HTTP.

## Verification

```sh
curl -fsS "$ORIGIN/.well-known/oauth-authorization-server" | head -c 200; echo
curl -s -o /dev/null -w '%{http_code}\n' "$ORIGIN/connect"   # 307 -> /owner/login (gated)
```

Sign in at `$ORIGIN/owner/login`, then check `$ORIGIN/deployment` for the
runtime diagnostics surface (`GET /_ref/deployment`).

For the release-owner proof from clean Compose state, use
[`docs/operator/release-selfservice-smoke.md`](../../docs/operator/release-selfservice-smoke.md).
It requires exact npm versions and digest-pinned images; the ordinary quickstart
and this operator runbook may continue to use a moving tag for exploratory work.

## Storage and upgrades

- Records live in the `pdpp-postgres-data` volume; secrets live in `.env`.
  Back up both together.

Upgrade by pulling and recreating; volumes persist:

```sh
docker compose pull && docker compose up -d
```

Update the reference and web image tags together, and run the registry manifest
check before moving to another published Compose release.

## Teardown

```sh
docker compose down --volumes                          # deletes data
```

## Related

- [`../../docker-compose.yml`](../../docker-compose.yml) — the
  development/owner stack (connector credentials, fixtures, browser services);
  it is not the blessed self-service entry point.
