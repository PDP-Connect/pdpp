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

**Release status:** `neko` and `core-browser` publish from the same release
pipeline as `reference`/`web`/`reference-browser` (`.github/workflows/semantic-release.yml`,
`publish-images` job) — there is no separate step to remember. Verify a given
version actually published before you pin it:

```sh
pnpm docker:release-matrix:verify-published --tag <version>   # e.g. 1.3.0, or "latest"
```

This queries GHCR directly (no login required) for every image the pipeline is
supposed to publish and fails if any is missing at that tag — the same check
that caught this gap in the first place
(`scripts/verify-published-docker-images.ts`). If it reports `neko` or
`core-browser` missing at the tag you want, no release has published them yet;
use the network-only path above until one has, or build locally as a stopgap:

```sh
PDPP_NEKO_IMAGE=pdpp-neko:local
```

added to `.env`, with the image built from this repository via
`docker build -f docker/neko/Dockerfile -t pdpp-neko:local .`. This is the one
step that needs a clone, and it exists only as a stopgap for a tag that has not
published yet — it is not the steady-state route once `verify-published`
reports the tag present.

Until you set `PDPP_NEKO_IMAGE`, the compose file resolves the n.eko service to
the placeholder `pdpp-neko-image-not-set`, which fails loudly rather than
pulling a tag that does not exist. The default network-only stack is unaffected:
the n.eko service is not created without `--profile browser`.

Serve a remote domain through your HTTPS reverse proxy (Caddy, Traefik, nginx)
pointed at the `web` port, and set `PDPP_REFERENCE_ORIGIN` to that domain so
owner-session cookies and OAuth metadata are correct. Local loopback HTTP is
supported for a local client; do not expose a remote node over HTTP.

## Public HTTPS for ChatGPT and Claude.ai

Claude Code, Codex, and other local agents run on your machine and can reach
`http://localhost:3000/mcp` directly — nothing in this section applies to them.

ChatGPT and Claude.ai are hosted services: they fetch your MCP server URL from
their own infrastructure, not your browser, so `localhost`, a LAN IP, or any
other private address can never work for them, no matter how your firewall or
router is configured. They need a public HTTPS origin.

You do not need a domain name or a PDPP account to get one. This uses
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
to publish your local node without opening any inbound port on your router or
host firewall — `cloudflared` makes an outbound-only connection to Cloudflare.

**Use a named tunnel, not `cloudflared tunnel --url` (Quick Tunnel).** Quick
Tunnels need no account at all, but Cloudflare's own docs describe them as
["testing and development purposes only"](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/),
with no SLA, a 200 in-flight request cap, and **no support for Server-Sent
Events** — any of which can silently break a hosted MCP client mid-session. A
named tunnel needs a free Cloudflare account (email + password; Cloudflare can
issue you a subdomain, so a domain purchase is still not required) and has
none of those disclaimers.

### 1. Create a named tunnel (one time, on any machine with `cloudflared`)

Install `cloudflared` ([Cloudflare's install docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)),
then:

```sh
cloudflared tunnel login          # opens a browser; free Cloudflare account
cloudflared tunnel create pdpp    # prints a tunnel ID and writes a credentials file
cloudflared tunnel route dns pdpp <your-choice>.<your-zone-or-cloudflare-subdomain>
```

Get the token for that tunnel — either from the credentials file `cloudflared
create` wrote, or from the Cloudflare dashboard (Zero Trust → Networks →
Tunnels → your tunnel → install/token) — and set it, along with the hostname
you just routed, in `.env`:

```sh
CLOUDFLARE_TUNNEL_TOKEN=<your-tunnel-token>
PDPP_REFERENCE_ORIGIN=https://<your-choice>.<your-zone-or-cloudflare-subdomain>
```

`PDPP_REFERENCE_ORIGIN` is the only PDPP-protocol-relevant output of this
step: OAuth metadata, cookies, and the `/mcp` URL shown on `/connect` are all
composed from it, so it must exactly match the hostname you routed.

### 2. Start the tunnel profile

```sh
docker compose --profile tunnel up -d
```

This starts `cloudflared` alongside the normal stack (add `--profile browser`
too if you also enabled browser-backed sources). `cloudflared` runs the tunnel
you created in step 1 and forwards it to the `web` service over the private
compose network; no host port is published for it.

### 3. Verify and connect

```sh
curl -fsS "$PDPP_REFERENCE_ORIGIN/.well-known/oauth-authorization-server" >/dev/null && echo reachable
```

Open `<PDPP_REFERENCE_ORIGIN>/connect` and use the ChatGPT or Claude.ai setup
steps shown there. Both ask you to sign in to *this* deployment's owner
dashboard and approve a specific, source-scoped grant before either client can
read anything — the tunnel makes the origin reachable, it does not grant
access by itself. See
[`docs/operator/hosted-mcp-setup.md`](../../docs/operator/hosted-mcp-setup.md#chatgpt)
for the exact client-side steps.

### Security posture

- `cloudflared` only ever makes outbound connections to Cloudflare's edge; no
  inbound port is opened on your router or host firewall by this profile.
- The tunnel exposes exactly the `web` service — the same operator console and
  protocol surface already reachable at `http://localhost:3000`. It does not
  expose Postgres or the browser surface (`neko`), neither of which publish a
  host port even without a tunnel.
- Publishing this node publicly does not weaken owner auth: `/owner/login`,
  the grant-approval flow, and the `/mcp` bearer checks are unchanged. Anyone
  who reaches the origin can attempt to sign in or start OAuth, but cannot
  read data without completing owner login or an approved, source-scoped
  grant.
- Revoking access later does not require tearing down the tunnel: revoke the
  specific grant or CIMD client identity at `/connect`, or rotate
  `PDPP_OWNER_PASSWORD`.

### Tunnel teardown

Stop just the tunnel, keeping the node running locally:

```sh
docker compose --profile tunnel stop cloudflared
```

Remove it entirely (the node stays up on `http://localhost:3000`, now
unreachable from outside your machine again):

```sh
docker compose --profile tunnel rm -sf cloudflared
```

Deleting the tunnel itself (so the hostname stops resolving at all) is done
once, outside Compose, from wherever you ran `cloudflared tunnel create`:

```sh
cloudflared tunnel delete pdpp
```

This does not touch `pdpp-postgres-data` or any other volume — deleting the
tunnel only retires the public hostname, not your data. Use the
[Teardown](#teardown) section below to also delete data.

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
- If you enabled browser-backed sources, the `neko` service's Chromium
  profile (cookies, saved login state) lives in the `pdpp-neko-profile`
  volume, independent of the `neko` container itself.

Upgrade by pulling and recreating; volumes persist:

```sh
docker compose pull && docker compose up -d
```

This recreates every container (including `neko`, if the browser profile is
enabled) but reattaches the same named volumes, so Postgres data and the
Chromium sign-in state both survive — you should not need to sign back in to
ChatGPT/USAA/Amazon/etc. after an upgrade. The same is true of an ordinary
`docker compose stop && docker compose start`, and of `docker compose down`
followed by `docker compose up -d` with no `--volumes` flag. Only
`docker compose down --volumes` (below) deletes profile/auth state, along
with Postgres data.

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
