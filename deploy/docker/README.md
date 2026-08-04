# Deploy a PDPP Core node with Docker

The blessed self-service path is one stable URL:
[`https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml`](https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml).
It always resolves to the current release's Compose bundle, with the
`reference`, `web`, and `neko` images already pinned by immutable digest —
not a tag, not a commit SHA you copy by hand. The bundle publishes the
operator surface on port `3000` and keeps the protocol listeners and
Postgres private.

For the one plain self-service journey — including Gmail setup, the health/data
gate, and Claude Code OAuth — use
[`docs/operator/self-service-gmail-mcp.md`](../../docs/operator/self-service-gmail-mcp.md).

## The one stable self-service URL

Every release publishes a version-coherent Compose bundle as a GitHub Release
asset. `.../releases/latest/download/docker-compose.yml` always points at the
current release; no doc, and no friend, ever hand-copies a tag or commit SHA.
No repository clone required:

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml
printf 'PDPP_REFERENCE_ORIGIN=http://localhost:3000\nPDPP_WEB_PORT=3000\nPDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
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
curl.exe -fsSLO https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml
$ownerBytes = [byte[]]::new(24)
$keyBytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($ownerBytes); $rng.GetBytes($keyBytes)
$owner = [Convert]::ToBase64String($ownerBytes)
$key = ($keyBytes | ForEach-Object { $_.ToString('x2') }) -join ''
@(
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

**Do not add `PDPP_REFERENCE_IMAGE` or `PDPP_WEB_IMAGE` to `.env`.** The
downloaded bundle already pins both to this release's exact digest; setting
either in `.env` overrides that pin back to whatever value you type, which
defeats the entire point of the stable URL — a stale or mistyped override is
indistinguishable from a real regression until something breaks. Only set
origin/port/password/encryption-key and the other real operator settings
below.

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

**Release status:** the bundle you downloaded from
`.../releases/latest/download/docker-compose.yml` already pins `neko` to this
release's exact digest, the same way it pins `reference` and `web` — there is
nothing to verify, clone, or build. The release pipeline's
`publish-selfhost-bundle` job is gated on every image in the release matrix
(`reference`, `web`, `neko`, `core-browser`, `railway-core`) actually
publishing; if any of them failed to publish, the bundle itself is not
published either, so a friend can never end up with a bundle that references
an image the release didn't ship. You do not need `pnpm`, a repository clone,
or a local `docker build` on this path.

> **Developer fallback, not the normal path.** If you are working from a
> repository checkout — contributing, testing an unreleased change, or
> debugging a specific release — you can still verify a given version's
> images directly with `pnpm docker:release-matrix:verify-published --tag
> <version>` (`scripts/verify-published-docker-images.ts`, queries GHCR
> anonymously) or build `neko` locally with `docker build -f
> docker/neko/Dockerfile -t pdpp-neko:local .` and override
> `PDPP_NEKO_IMAGE=pdpp-neko:local` in `.env`. Neither step belongs in the
> friend-facing self-service path above; both require a clone this path is
> designed to avoid.

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
`http://localhost:3000/mcp` directly — **nothing in this section applies to
them, and they need no tunnel at all.**

ChatGPT and Claude.ai are hosted services: they fetch your MCP server URL from
their own infrastructure, not your browser, so `localhost`, a LAN IP, or any
other private address can never work for them, no matter how your firewall or
router is configured. They need a public HTTPS origin. You do not need a PDPP
account for any of the paths below.

**Cloudflare named tunnels specifically require a domain you own, added to
your Cloudflare account.** Cloudflare's own prerequisites state plainly: a
named tunnel's public hostname needs
"[a domain on Cloudflare](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)
(required to publish applications)" — see
[`developers.cloudflare.com/tunnel/setup`](https://developers.cloudflare.com/tunnel/setup).
Cloudflare does not issue a free subdomain for a named tunnel; `*.trycloudflare.com`
is generated only by the ephemeral Quick Tunnel below, and cannot be routed to
a named tunnel. **If you don't own a domain, a stable hostname is still
available** through a third-party-assigned hostname on another provider's
account — ngrok's free plan is documented below. Use the Cloudflare named
tunnel path only if you already have, or are willing to register, a domain
you can add to a Cloudflare account.

Pick one of the three paths below based on what you have and what you need:

| You have | You want | Use |
| --- | --- | --- |
| Nothing yet, just trying it out | A quick trial connection | [Ephemeral Quick Tunnel](#ephemeral-trial-cloudflare-quick-tunnel) |
| No domain, want it to keep working | A stable hostname | [ngrok assigned dev domain](#stable-no-owned-domain-ngrok-assigned-dev-domain) |
| A domain already on Cloudflare | A stable hostname | [Cloudflare named tunnel](#stable-with-a-domain-cloudflare-named-tunnel) |

### Ephemeral trial: Cloudflare Quick Tunnel

`cloudflared tunnel --url` needs no account and no domain — it prints a random
`https://<words>.trycloudflare.com` hostname and forwards it to your local
node. Cloudflare's own docs describe this as
["testing and development purposes only"](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
no SLA, a 200 in-flight request cap, and the hostname changes every time you
restart it. **Use this only for a short trial connection, never for a
deployment you want to keep working.**

Cloudflare's docs also state Quick Tunnels do not support Server-Sent Events.
That does not block PDPP specifically: PDPP's `/mcp` endpoint runs the MCP
Streamable HTTP transport with `enableJsonResponse: true`
(`packages/mcp-server/src/server.ts`), so `initialize`, `tools/list`, and
`tools/call` always respond with plain `application/json`, never
`text/event-stream` — verified with real HTTP requests through an
SSE-rejecting proxy. (The one SSE-only path, an optional `GET /mcp`
server-push stream, is not part of ordinary tool-calling and PDPP's transport
is stateless, so normal clients never open it.)

```sh
cloudflared tunnel --url http://localhost:3000
```

Copy the printed `https://<words>.trycloudflare.com` URL, set it as
`PDPP_REFERENCE_ORIGIN` in `.env`, and restart the stack (`docker compose up
-d`) so OAuth metadata and cookies are composed from the new origin. Stop the
`cloudflared` process to tear the tunnel down; nothing in Compose needs to
change since this runs outside the `tunnel` profile entirely.

### Stable, no owned domain: ngrok assigned Dev Domain

[ngrok](https://ngrok.com)'s free plan gives every account one **Dev
Domain** — ngrok's own term, not a domain you register or choose. Per
ngrok's docs: "Every ngrok account comes with a free Dev Domain that can be
used if you don't want to pick a domain," and on the free plan "you can only
use your automatically assigned dev domain... you cannot choose or reserve
custom domain names" — that capability requires a paid plan
([`ngrok.com/docs/universal-gateway/domains/`](https://ngrok.com/docs/universal-gateway/domains/)).
Practically: ngrok assigns the hostname (shape
`https://<assigned-name>.ngrok-free.app`) and it does not change across
restarts, at no cost and with no domain purchase or Cloudflare-style
domain-onboarding step — but you do not pick the name, and the free plan
gives you exactly one. Documented free-plan limits: 1 GB/month data transfer,
20,000 HTTP requests/month, up to 3 concurrent online endpoints
([ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)).

One real caveat: the free plan shows a one-time interstitial "this is served
by ngrok" page to browser (HTML) traffic, which a friend will see once when
Claude.ai/ChatGPT redirect their browser through OAuth — click "Visit Site" to
continue. It does not affect the API traffic ChatGPT/Claude.ai make directly
to `/mcp`.

```sh
ngrok config add-authtoken <your-authtoken>              # from the ngrok dashboard, free account
ngrok http 3000 --url=<your-assigned-dev-domain>          # the hostname ngrok assigned you, from the dashboard's Domains page
```

`--url` is the documented flag for pinning a tunnel to a specific hostname
([`ngrok.com/docs/http/#domain`](https://ngrok.com/docs/http/#domain)); the
value is the Dev Domain ngrok already assigned your account, found on your
ngrok dashboard's Domains page — not a name you invent. Set
`PDPP_REFERENCE_ORIGIN=https://<your-assigned-dev-domain>` in `.env` and
restart the stack (`docker compose up -d`).

### Stable, with a domain: Cloudflare named tunnel

If you already own a domain and have added it to a Cloudflare account as a
zone, a named tunnel gives you a stable hostname with none of the Quick
Tunnel disclaimers, published without opening any inbound port on your router
or host firewall — `cloudflared` makes an outbound-only connection to
Cloudflare. This is the path the `cloudflared` service in
[`docker-compose.yml`](./docker-compose.yml) (opt-in `--profile tunnel`) is
built for.

**1. Create a named tunnel (one time, on any machine with `cloudflared`)**

Install `cloudflared` ([Cloudflare's install docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)),
then:

```sh
cloudflared tunnel login          # opens a browser; free Cloudflare account
cloudflared tunnel create pdpp    # prints a tunnel ID and writes a credentials file
cloudflared tunnel route dns pdpp <your-choice>.<your-domain-on-cloudflare>
```

`tunnel route dns` requires that `<your-domain-on-cloudflare>` already be
[added to your Cloudflare account](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)
— Cloudflare will not create a hostname on a domain it does not manage.

Get the token for that tunnel — either from the credentials file `cloudflared
create` wrote, or from the Cloudflare dashboard (Zero Trust → Networks →
Tunnels → your tunnel → install/token) — and set it, along with the hostname
you just routed, in `.env`:

```sh
CLOUDFLARE_TUNNEL_TOKEN=<your-tunnel-token>
PDPP_REFERENCE_ORIGIN=https://<your-choice>.<your-domain-on-cloudflare>
```

`PDPP_REFERENCE_ORIGIN` is the only PDPP-protocol-relevant output of this
step: OAuth metadata, cookies, and the `/mcp` URL shown on `/connect` are all
composed from it, so it must exactly match the hostname you routed.

**2. Start the tunnel profile**

```sh
docker compose --profile tunnel up -d
```

This starts `cloudflared` alongside the normal stack (add `--profile browser`
too if you also enabled browser-backed sources). `cloudflared` runs the tunnel
you created in step 1 and forwards it to the `web` service over the private
compose network; no host port is published for it.

**3. Verify and connect**

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

This posture applies to all three paths above (Quick Tunnel, ngrok, and
Cloudflare named tunnel) — each only changes how a public hostname reaches
`web`, not what that hostname exposes or how it is authenticated:

- The tunnel client (`cloudflared` or `ngrok`) only ever makes outbound
  connections to its provider's edge; no inbound port is opened on your
  router or host firewall by any of these paths.
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

### Cloudflare named-tunnel teardown

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
It requires exact npm versions; both it and this operator runbook now use the
same digest-pinned self-service bundle.

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

To move to a later release, re-download the bundle from
`.../releases/latest/download/docker-compose.yml` and run
`docker compose pull && docker compose up -d` again — the new bundle already
carries the new release's digests for `reference`, `web`, and `neko`
together, so there is no separate tag to update by hand.

## Teardown

```sh
docker compose down --volumes                          # deletes data
```

## Related

- [`../../docker-compose.yml`](../../docker-compose.yml) — the
  development/owner stack (connector credentials, fixtures, browser services);
  it is not the blessed self-service entry point.
