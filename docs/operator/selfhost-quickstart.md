# Self-Host Quickstart

This runbook stands up your own PDPP reference deployment, connects sources, and
permissions an MCP client (Claude or ChatGPT) to read your records. You are the
operator of your own instance. PDPP is a protocol; the reference implementation
is a forkable substrate, not a hosted service.

The canonical no-support journey is
[`self-service-gmail-mcp.md`](self-service-gmail-mcp.md). It pins the Docker /
Compose images to one tag, publishes the web service on port `3000`, and adds
Claude Code only after healthy data exists. The two lanes below retain deeper
owner-stack and RunPod notes for operators who need them.

- **Lane A — Docker host.** Any machine that runs Docker: laptop, NAS, Hetzner /
  Linode / DigitalOcean VPS, home server. Fully supported today.
- **Lane B — RunPod CPU Pod.** A single Pod on RunPod. Documented here for the
  r/selfhosted reader who wants a hosted-VM substrate without setting up a VPS.
  Some constraints; see [Lane B caveats](#lane-b-caveats).

When you finish either lane, jump to [Wire an MCP client](#wire-an-mcp-client).

---

## Before you start

You need:

- the registry-proven images (`ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a`,
  `ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a`) — both public, no login required;
- a place for the dashboard to be reachable over HTTPS when remote (local
  loopback HTTP is supported; the Compose web port is `3000`);
- two deployment secrets: an **owner password** and
  `PDPP_CREDENTIAL_ENCRYPTION_KEY`. The password gates owner setup; the key
  seals source credentials.

You do not need:

- a domain name (the RunPod proxy URL works as-is for SLVP);
- a TLS certificate (RunPod terminates TLS at the proxy; for Lane A behind a
  reverse proxy, terminate there);
- a hosted PDPP account (there is no such thing).

---

## Lane A — Docker host

### 1. Fetch the blessed compose stack

Lane A uses the same pinned, registry-proven Compose stack as
[`self-service-gmail-mcp.md`](self-service-gmail-mcp.md) — the
`reference:sha-cc07e3a` and `web:sha-cc07e3a` images, published on port `3000`.
No repository clone is required:

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/cc07e3a896c2c0df7841da4ec6b2c660ffe1e792/deploy/docker/docker-compose.yml
```

This is [`deploy/docker/docker-compose.yml`](../../deploy/docker/docker-compose.yml)
— the small, pinned self-service stack. It is a different file from the
repository-root `docker-compose.yml`, which is the development/owner stack
(connector credentials, fixtures, browser services) and is not the blessed
self-host entry point.

### 2. Generate secrets and set the required variables

macOS and Linux (bash or zsh):

```sh
printf 'PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a\nPDPP_WEB_IMAGE=ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a\nPDPP_REFERENCE_ORIGIN=http://localhost:3000\nPDPP_WEB_PORT=3000\nPDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
```

Windows PowerShell (the block above cannot work there: `\` is not a line
continuation, `openssl` is usually absent, and `>` writes UTF-16LE, which
`docker compose` cannot parse):

```powershell
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
```

In step 1, use `curl.exe` rather than `curl` on PowerShell — bare `curl` is an
alias for `Invoke-WebRequest` and does not accept those flags.

The compose file refuses to boot until `PDPP_OWNER_PASSWORD` and
`PDPP_CREDENTIAL_ENCRYPTION_KEY` exist in `.env` — the password gates the
dashboard, and the encryption key seals any connector credentials you store.
Keep `.env` with your backups.

Set `PDPP_REFERENCE_ORIGIN` to the external URL your dashboard will be reached
at (e.g. `https://pdpp.example.com`, or leave the `http://localhost:3000`
default for a local trial). This is used by the OAuth and MCP flows to compose
callback URLs — a mismatch silently breaks Claude / ChatGPT login.

You do not need connector-specific source credentials in `.env` to start.
Normal connection setup happens through owner-mediated setup once the instance
is up — see [`docs/operator/add-connection.md`](add-connection.md).

The Postgres credentials in the compose file (`pdpp` / `pdpp`) are private to
the Compose network only — no Postgres port is published. **Do not publish a
Postgres port without also setting `PDPP_POSTGRES_PASSWORD` to something
non-default.**

### Optional: "no open ports" public HTTPS for ChatGPT/Claude.ai

If your Docker host is not publicly reachable — home server behind NAT, VPS
without a domain, or a machine you do not want to expose directly — and you
need ChatGPT or Claude.ai (not just Claude Code) to reach it, none of the
paths below require opening a firewall port. Which one to use depends on
whether you own a domain: a stable hostname genuinely requires either a
domain you add to a Cloudflare account, or ngrok's free no-domain static
domain; a domain-free Cloudflare Quick Tunnel works too but is explicitly
ephemeral/testing-only. `cloudflared` for the domain-owning path is already
built into the blessed Compose stack as an opt-in `--profile tunnel` service.
See
[`deploy/docker/README.md#public-https-for-chatgpt-and-claudeai`](../../deploy/docker/README.md#public-https-for-chatgpt-and-claudeai)
for the full comparison, one-time setup, security posture, and teardown for
all three paths.

### 3. Pull and start

```sh
docker compose pull
docker compose up -d
```

First boot downloads the default embedding model (~500 MB) into the
`pdpp-transformers` volume. The `reference` service is reported healthy as soon
as the authorization server (`:7662`) and resource server (`:7663`) are
listening — embedding download continues in the background.

If you do not need semantic search yet, set
`PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` in `.env` to skip the download.

### 4. Verify in the dashboard

Open the dashboard at `PDPP_REFERENCE_ORIGIN` (default
`http://localhost:3000`), then `/owner/login`. Enter your owner password
(the value you generated into `.env` in step 2). You should land on `/`.

Visit `/deployment` and confirm:

- the authorization server, resource server, and storage backend all report
  healthy;
- the embedding cache is either present or actively downloading;
- the operator console build is the one you pulled.

The in-dashboard *deployment readiness* panel flags the most common first-boot
misconfigurations here: missing owner password, public-origin mismatch, storage
state, embedding cache state, and hosted MCP refresh-token metadata.

### 5. Updating

```sh
docker compose pull
docker compose up -d
```

The named volumes (`pdpp-transformers`, `pdpp-postgres-data`) persist across
`up -d` runs. Do not auto-update on a schedule; database migrations land
between releases and require an operator-driven re-pull. Update the
`reference` and `web` image tags together, and run the registry manifest check
before moving to another published Compose release.

### 6. Backup

Records live in the `pdpp-postgres-data` volume; secrets live in `.env`. Back
up both together. A minimal SLVP backup is a `pg_dump` of the volume. A
dashboard backup UI is deferred.

---

## Lane B — RunPod CPU Pod

### Lane B caveats

Before you start, know what RunPod gives you for this workload:

- **Single-container Pods**, with the container's exposed HTTP ports auto-served
  over TLS at `https://<podid>-<port>.proxy.runpod.net`. You bind your service
  to `0.0.0.0`, declare the port on the template, and RunPod terminates TLS for
  you.
- **No native docker-compose primitive.** You either run all three services
  (`reference`, `web`, `postgres`) inside one container with a process
  supervisor, or you run docker-compose *inside* a single Pod using the host's
  Docker daemon if your template provides one. The recipe below uses the
  second approach because it reuses the existing compose stack without forking
  the image.
- **No first-party custom domains** for the proxy URL in 2026. CNAME-via-
  Cloudflare in front of the proxy URL is the community escape hatch; not
  required for SLVP.
- **No UDP**; not needed for the SLVP because hosted MCP runs over HTTP and we
  are not enabling the optional browser-streaming overlay (`n.eko`) in this
  lane.
- **`/workspace` is the persistent volume.** Container disk is scratch; put
  everything you want to survive a Pod restart on `/workspace`.

A first-class RunPod Pod template with a `pdpp-all-in-one` image is the next
slice; see [Deferred](#deferred) below. This lane uses the existing compose
stack on a single Pod, reachable via the proxy URL.

### 1. Create a CPU Pod

Choose any CPU Pod template that includes a Docker daemon (the official
"Docker" or "Ubuntu + Docker" template will do). When configuring:

- **Container disk:** 10 GB (scratch for the Docker host).
- **Volume disk (`/workspace`):** at least 20 GB (Postgres data, embedding
  cache, browser profiles).
- **Expose HTTP port:** `3000` (the operator dashboard). RunPod will publish
  it at `https://<podid>-3000.proxy.runpod.net`.
- **Env vars (set on the template):** none required — `PDPP_OWNER_PASSWORD` and
  `PDPP_CREDENTIAL_ENCRYPTION_KEY` are generated in step 2 and written to
  `.env`. Set `PDPP_REFERENCE_ORIGIN` once the Pod is up (you need the proxy
  URL to know what to set it to).

### 2. Boot the stack on the Pod

Once the Pod is running, open the web terminal (Console → Pods → Connect → Open
Web Terminal) and:

```sh
mkdir -p /workspace/pdpp && cd /workspace/pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/cc07e3a896c2c0df7841da4ec6b2c660ffe1e792/deploy/docker/docker-compose.yml

# Generate required secrets and set the origin to the proxy URL RunPod gave you:
printf 'PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a\nPDPP_WEB_IMAGE=ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a\nPDPP_WEB_PORT=3000\nPDPP_REFERENCE_ORIGIN=https://<podid>-3000.proxy.runpod.net\nPDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env

docker compose pull
docker compose up -d
```

The first-boot embedding download runs from inside the Pod's container; the
~500 MB lands in the `pdpp-transformers` Docker volume, which is itself on the
Pod's `/workspace` mount.

### 3. Verify

In a browser, open `https://<podid>-3000.proxy.runpod.net/owner/login`, sign
in with your owner password (the value you generated into `.env` in step 2),
and walk through `/deployment` as in Lane A step 4.

### 4. Updating

Same as Lane A: `docker compose pull && docker compose up -d` over the same
checkout in `/workspace`. The compose volumes persist on `/workspace`.

### 5. Stopping the Pod

Stopped Pods retain the volume disk but the proxy URL changes when the Pod
restarts on a different host. After resuming a stopped Pod, update
`PDPP_REFERENCE_ORIGIN` in `.env` to the new proxy URL and restart the stack.

### Optional: Browser-backed sources (ChatGPT, USAA, Amazon, ...)

If you want to use browser-backed connectors that require interactive 2FA or
bot-challenge verification, see
[Browser-backed sources](../../deploy/docker/README.md#browser-backed-sources-chatgpt-usaa-)
in the Docker deployment guide. It requires adding one environment variable and
restarting with the `--profile browser` flag. Network-only sources (Gmail,
GitHub, etc.) work without this step.

---

## Wire an MCP client

Once your deployment is reachable, healthy, and has `records > 0`, follow the
existing runbook to wire Claude or ChatGPT. A configured source or saved
credential is not enough:

- [`docs/operator/hosted-mcp-setup.md`](hosted-mcp-setup.md) — covers the
  device-flow OAuth, the `/deployment/tokens` token issuer, and the
  MCP server URL shape.

Your MCP server URL is `<PDPP_REFERENCE_ORIGIN>/mcp`. For Lane B that is
`https://<podid>-3000.proxy.runpod.net/mcp`.

The hosted MCP surface uses the scoped grant selected during consent. It supports
the normal grant-scoped read tools only; event-subscription management stays in
the operator console and REST/control-plane docs. It does not expose owner-mode
administration. Revoking the grant from `/deployment/tokens`
invalidates both the access and refresh tokens.

### Verify event delivery (optional)

If the connected client wants to subscribe to record changes, your
deployment can deliver Standard Webhooks–signed CloudEvents to any HTTPS
receiver. Before pointing a real client at the deployment, sanity-check
delivery with the bundled local receiver:

```sh
# From the repo root, in a separate terminal:
node --import tsx scripts/event-subscription-test-receiver.ts
```

Then follow [`docs/operator/event-subscriptions.md`](event-subscriptions.md)
to create a subscription against the receiver and watch the verification
handshake complete. The receiver verifies the signature, echoes the
verify challenge, and pretty-prints every envelope. Subscriptions are
visible at `/event-subscriptions`.

---

## Adding connections

You add connections through owner-mediated setup, not by editing deployment
environment variables. See
[`docs/operator/add-connection.md`](add-connection.md) for the full flow; in
short:

- **Console.** Open `/connect` after signing in as owner, and use **Add a data source**
  on the Connect page. Local sources (Claude Code, Codex), browser-backed
  sources, static-secret sources, deployment-blocked sources, and unsupported
  sources each show one status and one next step.
- **Owner agent / REST.** A trusted owner agent calls
  `POST /v1/owner/connections/intents` and receives the same setup plan and
  next-step contract the console renders. The agent never receives provider
  secrets, owner cookies, or grant-scoped MCP bearers.
- **CLI.** After owner-agent onboarding, run
  `pdpp owner-agent connectors list --entrypoint <instance-url>` or
  `pdpp owner-agent connectors search <provider> --entrypoint <instance-url>` to
  discover source setup options, `pdpp owner-agent connectors explain
  <connector-id>` to preview without minting setup material, and `pdpp
  owner-agent setup <connector-id> --display-name <name>` to start setup.

Connector-specific source credential variables set directly on the Docker host
(Lane A) or on the Pod's template env-var form (Lane B) are a **compatibility
fallback and local development escape hatch** for Docker-managed connector
runs on the repository-root development stack — not the normal
setup path. The instance-level `PDPP_CREDENTIAL_ENCRYPTION_KEY` is the exception:
it is a deployment variable that seals owner-captured static-secret credentials
at rest, set once for the instance rather than per connection.

Static-secret sources use the owner-session form linked from **Add a data
source**. The form is generated from connector manifests, creates a draft
connection, captures the provider secret, and starts the first sync; the
connection stays hidden until ingest accepts records. The static-secret runbook
linked from [`add-connection.md`](add-connection.md) is now the proof/debug
reference, not the normal happy path.

---

## Deferred

These are explicitly out of scope for the SLVP runbook. They are tracked so a
future reader does not re-derive that they are intentionally absent.

- **RunPod Pod template / persistent Pod image.** A `pdpp-all-in-one`
  single-container image with process supervision, auto-generated secrets on
  first boot, and SQLite default — usable as a RunPod Pod template. Requires a
  new image shape and a release-tag cadence. RunPod Hub is a serverless worker
  platform and is the wrong target for a persistent service.
- **Full connector credential management UI.** The static-secret add form
  captures a first credential. Rotation, revoke, and per-connection credential
  inspection remain future owner-console work.
- **Custom-domain TLS at the PDPP layer.** Use Cloudflare CNAME or a Caddy /
  Traefik fronting container if you need a vanity domain on RunPod.
- **Backup-restore dashboard UI.** Today, `pg_dump` for Postgres and a
  `/workspace` tarball for everything else. UI later.
- **Multi-operator RBAC.** Single owner password is the SLVP model.

---

## See also

- [`docs/operator/hosted-mcp-setup.md`](hosted-mcp-setup.md) — wiring Claude /
  ChatGPT to `/mcp`.
- [`docs/operator/event-subscriptions.md`](event-subscriptions.md) —
  client-driven outbound webhooks, the operator console surface, and the
  bundled local test receiver script.
- [`docs/operator/local-collector-runbook.md`](local-collector-runbook.md) —
  running browser-backed connectors on a host with a visible Chromium.
- [`docs/operator/dynamic-neko-operator-guide.md`](../dynamic-neko-operator-guide.md) —
  optional pooled-browser overlay (`n.eko`); not required for SLVP.
- [`docs/reference/voice-and-framing.md`](../voice-and-framing.md) — voice rules for
  any operator-facing copy edits here.
