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

Choose this **before** you set up sources, because it changes which image you
run. Sources split into two kinds and the dashboard tells you which is which:

| You want | Run | Containers |
| --- | --- | --- |
| Gmail, GitHub, Notion, Oura, YNAB (network-only) | `railway-core` (or the Compose stack above) | 1 (or 3) |
| ...and also ChatGPT, USAA, Amazon, Chase, Reddit (browser-backed) | `core-browser` + a browser surface | 2 |

Browser-backed connectors sign in through a real, *viewable* browser session:
the provider may show a Cloudflare challenge or a 2FA prompt that you have to
click yourself. A headless browser cannot do that, and a headed browser inside a
container has no screen, so these connectors need a browser surface you can
watch and control (n.eko). This is why they are not part of the one-command
network-only path.

If you only want the network-only sources, ignore this section. The dashboard
refuses a browser-backed source up front on a node without a browser surface,
rather than taking your provider password and failing on the first sync.

The single-container browser-capable node is `core-browser` — the same bundled
console and supervisor as `railway-core`, plus Chromium — pointed at a n.eko
surface:

The n.eko surface image is **not published to a registry** — it is built from
this repository, so this path requires a clone:

```sh
git clone https://github.com/PDP-Connect/pdpp.git && cd pdpp
docker build -f docker/neko/Dockerfile -t pdpp-neko:local .
docker run -d --name pdpp-neko --shm-size=2g pdpp-neko:local
NEKO_IP=$(docker inspect pdpp-neko --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

docker run -d --name pdpp -p 3000:3000 -v pdpp_data:/var/lib/pdpp \
  -e PDPP_NEKO_BASE_URL="http://$NEKO_IP:8080/neko" \
  -e PDPP_NEKO_CDP_HTTP_URL="http://$NEKO_IP:9223" \
  -e PDPP_NEKO_WINDOW_SETTLE_URL="http://$NEKO_IP:9223/pdpp/window-settle" \
  -e PDPP_NEKO_PROXY_ALLOWED_HOSTS="$NEKO_IP:8080" \
  -e PDPP_NEKO_MANAGED_CONNECTORS="https://registry.pdpp.org/connectors/chatgpt" \
  -e PDPP_NEKO_SURFACE_MODE=static \
  -e PDPP_NEKO_SURFACE_CAP=1 \
  -e PDPP_NEKO_STATIC_PROFILE_KEY="https://registry.pdpp.org/connectors/chatgpt" \
  -e PDPP_NEKO_BROWSER_OWNER_MODE=neko-owned \
  ghcr.io/pdp-connect/pdpp/core-browser:<released-tag>
```

Every one of those `PDPP_NEKO_*` variables is required; the server refuses to
start with a named error if one is missing (for example
`PDPP_NEKO_SURFACE_CAP is required`). Gmail and the other network-only sources
work on this node too, so you do not need both nodes.

`core-browser` and the n.eko image are larger than `railway-core` (Chromium and
its dependencies), which is the only reason they are a separate tag rather than
the default.

> **Honest status.** `core-browser` is new in this change and has no released
> tag yet; substitute one once a release exists. The n.eko image is not
> published at all today, so this path needs a repository clone and two local
> builds. That makes it a **developer-grade** path, not a self-service one — if
> you are setting this up for someone non-technical, prefer the network-only
> node and leave browser-backed sources out.

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
