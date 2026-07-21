# Self-Host Quickstart

This runbook stands up your own PDPP reference deployment, connects sources, and
permissions an MCP client (Claude or ChatGPT) to read your records. You are the
operator of your own instance. PDPP is a protocol; the reference implementation
is a forkable substrate, not a hosted service.

There are two lanes below. Pick one.

- **Lane A — Docker host.** Any machine that runs Docker: laptop, NAS, Hetzner /
  Linode / DigitalOcean VPS, home server. Fully supported today.
- **Lane B — RunPod CPU Pod.** A single Pod on RunPod. Documented here for the
  r/selfhosted reader who wants a hosted-VM substrate without setting up a VPS.
  Some constraints; see [Lane B caveats](#lane-b-caveats).

When you finish either lane, jump to [Wire an MCP client](#wire-an-mcp-client).

---

## Before you start

You need:

- the published images (`ghcr.io/vana-com/pdpp/reference:main`,
  `ghcr.io/vana-com/pdpp/web:main`) — both public, no login required;
- a place for the dashboard to be reachable over HTTPS (Lane A: a reverse proxy
  or local development URL; Lane B: the `*.proxy.runpod.net` URL RunPod gives
  you);
- one piece of secret you choose: an **owner password**. This gates `/owner`,
  `/device`, `/consent`, and `/dashboard`.

You do not need:

- a domain name (the RunPod proxy URL works as-is for SLVP);
- a TLS certificate (RunPod terminates TLS at the proxy; for Lane A behind a
  reverse proxy, terminate there);
- a hosted PDPP account (there is no such thing).

---

## Lane A — Docker host

### 1. Fetch the compose stack

```sh
git clone https://github.com/PDP-Connect/pdpp
cd pdpp
cp .env.docker.example .env.docker
```

Or, without cloning: download
[`docker-compose.yml`](../../docker-compose.yml) and
[`.env.docker.example`](../../.env.docker.example) to an empty directory and
rename the example to `.env.docker`.

### 2. Generate secrets

Run the helper script to fill the required secrets into `.env.docker`:

```sh
bash scripts/generate-secrets.sh --write
```

This sets `PDPP_OWNER_PASSWORD`, `PDPP_CREDENTIAL_ENCRYPTION_KEY`, and the VAPID
key pair for browser push notifications. It never overwrites a value you have
already set. The generated output is printed if you prefer to review it before
writing:

```sh
bash scripts/generate-secrets.sh          # print to stdout; no files modified
bash scripts/generate-secrets.sh --write  # patch .env.docker in place
```

### 3. Set the remaining required variable

Open `.env.docker` and set:

| Variable | Set to | Why |
|---|---|---|
| `PDPP_REFERENCE_ORIGIN` | the external URL your dashboard will be reached at (e.g. `https://pdpp.example.com` or `http://localhost:3002`) | Used by the OAuth and MCP flows to compose callback URLs. A mismatch silently breaks Claude / ChatGPT login. |

`PDPP_OWNER_PASSWORD` and `PDPP_CREDENTIAL_ENCRYPTION_KEY` were set by the
script in the previous step. If you skipped the script, set them here.

The default Postgres credentials in the compose file (`pdpp` / `pdpp`) are
intentionally weak and bound to loopback only (`127.0.0.1:55432`). **Do not
change `PDPP_POSTGRES_BIND_HOST` unless you also set
`PDPP_POSTGRES_PASSWORD` to something non-default.**

You can leave every other variable blank. Normal connection setup does **not**
require connector-specific source credentials in `.env.docker`: you add a Gmail
mailbox, GitHub account, or local-collector device through owner-mediated setup
once the instance is up — see
[`docs/operator/add-connection.md`](add-connection.md). The per-connector source
variables (`GMAIL_APP_PASSWORD`, `GITHUB_PERSONAL_ACCESS_TOKEN`, etc.) in
`.env.docker.example` are a fallback/dev escape hatch for Docker-managed
connector runs, not the normal path; leave them blank unless you are
deliberately driving that connector from this stack.

One credential variable is instance-level, not per-connection:
`PDPP_CREDENTIAL_ENCRYPTION_KEY` seals captured static-secret credentials at
rest. The setup form blocks before asking for a provider credential if neither
that env var nor `PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE` is configured. It is not
a per-mailbox or per-account variable.

### Optional: "no domain, no open ports" with Cloudflare Tunnel

If your Docker host is not publicly reachable — home server behind NAT, VPS
without a domain, or a machine you do not want to expose directly — Cloudflare
Tunnel gives you a stable HTTPS URL without opening firewall ports or owning a
domain.

**One-time setup:**

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com), go to
   **Zero Trust → Networks → Tunnels**, and create a new tunnel.
2. Copy the tunnel token shown after creation.
3. Add the `cloudflared` service to your compose stack. Create
   `docker-compose.override.yml` alongside `docker-compose.yml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: "${CLOUDFLARE_TUNNEL_TOKEN}"
    networks:
      - pdpp
```

4. In the Cloudflare dashboard, add a public hostname for the tunnel pointing to
   `http://web:3000` (the `web` service on the internal Compose network).
5. Set the env vars in `.env.docker`:

```sh
CLOUDFLARE_TUNNEL_TOKEN=<your-tunnel-token>
PDPP_REFERENCE_ORIGIN=https://<your-hostname>.trycloudflare.com  # or your custom domain
```

6. Start the full stack:

```sh
docker compose --env-file .env.docker up -d
```

The tunnel service connects outbound to Cloudflare; no inbound ports need to be
opened. `PDPP_REFERENCE_ORIGIN` is the only PDPP-protocol-relevant output of
this step — set it to the stable HTTPS URL the tunnel provides.

### 4. Pull and start

```sh
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

First boot downloads the default embedding model (~500 MB) into the
`pdpp-transformers` volume. The `reference` service is reported healthy as soon
as the authorization server (`:7662`) and resource server (`:7663`) are
listening — embedding download continues in the background.

If you do not need semantic search yet, set
`PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` in `.env.docker` to skip the download.

### 5. Verify in the dashboard

Open the dashboard at `PDPP_REFERENCE_ORIGIN` (default
`http://localhost:3002`), then `/owner/login`. Enter your owner password
(printed by the script in step 2, or find it in `.env.docker` as
`PDPP_OWNER_PASSWORD`). You should land on `/dashboard`.

Visit `/dashboard/deployment` and confirm:

- the authorization server, resource server, and storage backend all report
  healthy;
- the embedding cache is either present or actively downloading;
- the operator console build is the one you pulled.

The in-dashboard *deployment readiness* panel flags the most common first-boot
misconfigurations here: missing owner password, public-origin mismatch, storage
state, embedding cache state, and hosted MCP refresh-token metadata.

### 6. Updating

```sh
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

The named volumes (`pdpp-transformers`, `pdpp-home`, `pdpp-postgres-data`)
persist across `up -d` runs. Do not auto-update on a schedule; database
migrations land between releases and require an operator-driven re-pull.

### 7. Backup

The two pieces of state you care about:

- `pdpp-postgres-data` — Postgres data, including grants and collected
  records.
- `pdpp-home` — the operator's runtime state, owner key material, and
  browser profile cache.

A minimal SLVP backup is a `pg_dump` and a `docker run --volumes-from` tarball
of `pdpp-home`. A dashboard backup UI is deferred.

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
- **Expose HTTP port:** `3002` (the operator dashboard). RunPod will publish
  it at `https://<podid>-3002.proxy.runpod.net`.
- **Env vars (set on the template):** none required — `PDPP_OWNER_PASSWORD` and
  `PDPP_CREDENTIAL_ENCRYPTION_KEY` are generated by the script in step 2 and
  written to `.env.docker`. Set `PDPP_REFERENCE_ORIGIN` once the Pod is up (you
  need the proxy URL to know what to set it to).

### 2. Boot the stack on the Pod

Once the Pod is running, open the web terminal (Console → Pods → Connect → Open
Web Terminal) and:

```sh
cd /workspace
git clone https://github.com/PDP-Connect/pdpp
cd pdpp
cp .env.docker.example .env.docker

# Generate required secrets (owner password, credential key, VAPID keys):
bash scripts/generate-secrets.sh --write

# Set the origin to the proxy URL RunPod gave you:
sed -i 's|^PDPP_REFERENCE_ORIGIN=.*|PDPP_REFERENCE_ORIGIN=https://<podid>-3002.proxy.runpod.net|' .env.docker

docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

The first-boot embedding download runs from inside the Pod's container; the
~500 MB lands in the `pdpp-transformers` Docker volume, which is itself on the
Pod's `/workspace` mount.

### 3. Verify

In a browser, open `https://<podid>-3002.proxy.runpod.net/owner/login`, sign
in with your owner password (printed by `generate-secrets.sh --write` in step
2), and walk through `/dashboard/deployment` as in Lane A step 4.

### 4. Updating

Same as Lane A: `docker compose pull && docker compose up -d` over the same
checkout in `/workspace`. The compose volumes persist on `/workspace`.

### 5. Stopping the Pod

Stopped Pods retain the volume disk but the proxy URL changes when the Pod
restarts on a different host. After resuming a stopped Pod, update
`PDPP_REFERENCE_ORIGIN` in `.env.docker` to the new proxy URL and restart the
stack.

---

## Wire an MCP client

Once your deployment is reachable and you have collected at least one stream,
follow the existing runbook to wire Claude or ChatGPT:

- [`docs/operator/hosted-mcp-setup.md`](hosted-mcp-setup.md) — covers the
  device-flow OAuth, the `/dashboard/deployment/tokens` token issuer, and the
  MCP server URL shape.

Your MCP server URL is `<PDPP_REFERENCE_ORIGIN>/mcp`. For Lane B that is
`https://<podid>-3002.proxy.runpod.net/mcp`.

The hosted MCP surface uses the scoped grant selected during consent. It supports
the normal grant-scoped read tools only; event-subscription management stays in
the operator console and REST/control-plane docs. It does not expose owner-mode
administration. Revoking the grant from `/dashboard/deployment/tokens`
invalidates both the access and refresh tokens.

### Verify event delivery (optional)

If the connected client wants to subscribe to record changes, your
deployment can deliver Standard Webhooks–signed CloudEvents to any HTTPS
receiver. Before pointing a real client at the deployment, sanity-check
delivery with the bundled local receiver:

```sh
# From the repo root, in a separate terminal:
node scripts/event-subscription-test-receiver.mjs
```

Then follow [`docs/operator/event-subscriptions.md`](event-subscriptions.md)
to create a subscription against the receiver and watch the verification
handshake complete. The receiver verifies the signature, echoes the
verify challenge, and pretty-prints every envelope. Subscriptions are
visible at `/dashboard/event-subscriptions`.

---

## Adding connections

You add connections through owner-mediated setup, not by editing deployment
environment variables. See
[`docs/operator/add-connection.md`](add-connection.md) for the full flow; in
short:

- **Console.** Open `/dashboard`, sign in as owner, and use **Add a data source**
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

Connector-specific source credential variables in `.env.docker` (Lane A) or on
the Pod's template env-var form (Lane B) are a **compatibility fallback and local
development escape hatch** for Docker-managed connector runs — not the normal
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
