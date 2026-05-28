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
git clone https://github.com/vana-com/pdpp
cd pdpp
cp .env.docker.example .env.docker
```

Or, without cloning: download
[`docker-compose.yml`](../../docker-compose.yml) and
[`.env.docker.example`](../../.env.docker.example) to an empty directory and
rename the example to `.env.docker`.

### 2. Set the minimum env vars

Edit `.env.docker` and set at least:

| Variable | Set to | Why |
|---|---|---|
| `PDPP_OWNER_PASSWORD` | a password you choose | Gates `/owner`, `/device`, `/consent`, `/dashboard`. Leaving it empty leaves those routes open. |
| `PDPP_REFERENCE_ORIGIN` | the external URL your dashboard will be reached at (e.g. `https://pdpp.example.com` or `http://localhost:3002`) | Used by the OAuth and MCP flows to compose callback URLs. A mismatch silently breaks Claude / ChatGPT login. |

The default Postgres credentials in the compose file (`pdpp` / `pdpp`) are
intentionally weak and bound to loopback only (`127.0.0.1:55432`). **Do not
change `PDPP_POSTGRES_BIND_HOST` unless you also set
`PDPP_POSTGRES_PASSWORD` to something non-default.**

You can leave every other variable blank. Connector credentials
(`GMAIL_APP_PASSWORD`, `GITHUB_PERSONAL_ACCESS_TOKEN`, etc.) are only required
for the connectors you intend to run; see the comments in
`.env.docker.example`.

### 3. Pull and start

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

### 4. Verify in the dashboard

Open the dashboard at `PDPP_REFERENCE_ORIGIN` (default
`http://localhost:3002`), then `/owner/login`. Enter your
`PDPP_OWNER_PASSWORD`. You should land on `/dashboard`.

Visit `/dashboard/deployment` and confirm:

- the authorization server, resource server, and storage backend all report
  healthy;
- the embedding cache is either present or actively downloading;
- the operator console build is the one you pulled.

The in-dashboard *deployment readiness* panel flags the most common first-boot
misconfigurations here: missing owner password, public-origin mismatch, storage
state, embedding cache state, and hosted MCP refresh-token metadata.

### 5. Updating

```sh
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

The named volumes (`pdpp-transformers`, `pdpp-home`, `pdpp-postgres-data`)
persist across `up -d` runs. Do not auto-update on a schedule; database
migrations land between releases and require an operator-driven re-pull.

### 6. Backup

The two pieces of state you care about:

- `pdpp-postgres-data` — Postgres data, including grants and collected
  records.
- `pdpp-home` — the operator's runtime state, owner key material, and
  browser profile cache.

A minimal SLVP backup is a `pg_dump` and a `docker run --volumes-from` tarball
of `pdpp-home`. A dashboard backup UI is deferred; see
`openspec/changes/add-selfhost-onboarding-slvp` for the deferred slice.

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

A first-class RunPod Hub `hub.json` + `tests.json` template is the next slice;
see [Deferred](#deferred) below. This lane uses the existing compose stack on
a single Pod, reachable via the proxy URL.

### 1. Create a CPU Pod

Choose any CPU Pod template that includes a Docker daemon (the official
"Docker" or "Ubuntu + Docker" template will do). When configuring:

- **Container disk:** 10 GB (scratch for the Docker host).
- **Volume disk (`/workspace`):** at least 20 GB (Postgres data, embedding
  cache, browser profiles).
- **Expose HTTP port:** `3002` (the operator dashboard). RunPod will publish
  it at `https://<podid>-3002.proxy.runpod.net`.
- **Env vars (set on the template):** at minimum `PDPP_OWNER_PASSWORD`. Set
  `PDPP_REFERENCE_ORIGIN` once the Pod is up (you need the proxy URL to know
  what to set it to).

### 2. Boot the stack on the Pod

Once the Pod is running, open the web terminal (Console → Pods → Connect → Open
Web Terminal) and:

```sh
cd /workspace
git clone https://github.com/vana-com/pdpp
cd pdpp
cp .env.docker.example .env.docker

# Replace the placeholder with the proxy URL RunPod gave you:
sed -i 's|^PDPP_REFERENCE_ORIGIN=.*|PDPP_REFERENCE_ORIGIN=https://<podid>-3002.proxy.runpod.net|' .env.docker
sed -i 's|^PDPP_OWNER_PASSWORD=.*|PDPP_OWNER_PASSWORD=<your-password>|' .env.docker

docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

The first-boot embedding download runs from inside the Pod's container; the
~500 MB lands in the `pdpp-transformers` Docker volume, which is itself on the
Pod's `/workspace` mount.

### 3. Verify

In a browser, open `https://<podid>-3002.proxy.runpod.net/owner/login`, sign
in with your owner password, and walk through `/dashboard/deployment` as in
Lane A step 4.

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

The hosted MCP surface is read-only by design. Revoking the grant from
`/dashboard/deployment/tokens` invalidates both the access and refresh
tokens.

---

## Connector credentials today

Connector credentials are set via environment variables in `.env.docker`
(Lane A) or on the Pod's template env-var form (Lane B). There is no
dashboard UI for adding credentials yet. The set of supported env vars is
defined per connector in `.env.docker.example`.

A dashboard credential-management UI is a separate, deferred change; see
[Deferred](#deferred).

---

## Deferred

These are explicitly out of scope for the SLVP runbook. They are tracked so a
future reader does not re-derive that they are intentionally absent.

- **RunPod Hub template.** A `hub.json` + `tests.json` single-container image
  that RunPod's Hub can deploy in one click. Requires a process supervisor
  inside one image and a release-tag cadence. Tracked in the design notes
  under
  [`design-notes/selfhost-runpod-onboarding-slvp-2026-05-27.md`](../../design-notes/selfhost-runpod-onboarding-slvp-2026-05-27.md).
- **In-dashboard connector credential management UI.** A Plaid-Link-style
  flow that captures, encrypts, and rotates connector credentials from the
  dashboard. Its own OpenSpec change.
- **Custom-domain TLS at the PDPP layer.** Use Cloudflare CNAME or a Caddy /
  Traefik fronting container if you need a vanity domain on RunPod.
- **Backup-restore dashboard UI.** Today, `pg_dump` for Postgres and a
  `/workspace` tarball for everything else. UI later.
- **Multi-operator RBAC.** Single owner password is the SLVP model.

---

## See also

- [`docs/operator/hosted-mcp-setup.md`](hosted-mcp-setup.md) — wiring Claude /
  ChatGPT to `/mcp`.
- [`docs/operator/local-collector-runbook.md`](local-collector-runbook.md) —
  running browser-backed connectors on a host with a visible Chromium.
- [`docs/operator/dynamic-neko-operator-guide.md`](../dynamic-neko-operator-guide.md) —
  optional pooled-browser overlay (`n.eko`); not required for SLVP.
- [`docs/voice-and-framing.md`](../voice-and-framing.md) — voice rules for
  any operator-facing copy edits here.
- [`design-notes/selfhost-runpod-onboarding-slvp-2026-05-27.md`](../../design-notes/selfhost-runpod-onboarding-slvp-2026-05-27.md) —
  the design note this runbook implements.
- [`openspec/changes/add-selfhost-onboarding-slvp/`](../../openspec/changes/add-selfhost-onboarding-slvp/) —
  the OpenSpec change tracking this work.
