# Self-service path: Docker, Gmail, and Claude Code

This is the plain supported path for a fresh self-hosted node. It uses the
published Docker Compose stack, one owner session, a Gmail app password, and a
scoped MCP grant. The public site is only the guide; `/mcp` belongs to the
deployment you start.

## 1. Deploy a pinned Compose stack

Use the same registry-proven image tag for the reference and web services. The
current public tag proven by an actual registry manifest is `sha-cc07e3a`; update
both image lines together only after the replacement pair passes that check.

```sh
mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/cc07e3a896c2c0df7841da4ec6b2c660ffe1e792/deploy/docker/docker-compose.yml
printf 'PDPP_REFERENCE_IMAGE=ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a\nPDPP_WEB_IMAGE=ghcr.io/pdp-connect/pdpp/web:sha-cc07e3a\nPDPP_REFERENCE_ORIGIN=http://localhost:3000\nPDPP_WEB_PORT=3000\nPDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

The web service publishes the operator surface on port `3000`; the reference
and Postgres services stay on the private Compose network. For a remote node,
put an HTTPS reverse proxy in front of the web service and set
`PDPP_REFERENCE_ORIGIN=https://your-domain`. Plain HTTP is for a local
loopback deployment only; do not expose a remote node over HTTP.

Check that the stack is up before opening the browser:

```sh
docker compose ps
curl -fsS http://localhost:3000/.well-known/oauth-authorization-server >/dev/null
```

## 2. Sign in as owner

Open `<your-deployment-origin>/owner/login` and sign in with the owner password
from `.env`. The owner session is for setup and approval; it is not an MCP
credential.

## 3. Add Gmail with a Google app password

Open `<your-deployment-origin>/sources/add` (or open **Sources** and choose
**Add source**), select Gmail, and enter:

- the Gmail address for the mailbox;
- a Google app password created for that mailbox.

Submit the source setup and keep the owner session available for any approval
the instance requests. The app password is stored by the deployment's
encrypted credential store; it is not a bearer token to paste into Claude Code.

## 4. Wait for healthy data

Do not wire MCP after the credential is merely saved. Continue only when all
three checks are true:

1. the deployment and Gmail connection report healthy/active;
2. the first sync has succeeded; and
3. the source has `records > 0`.

If the connection is configured but the record count is still zero, fix the
source or sync first. MCP can query only data the deployment has actually
collected.

## 5. Add the deployed MCP server to Claude Code

After the health/data gate, open the deployed canonical `/connect` surface:

```text
<your-deployment-origin>/connect
```

Use the Claude Code handoff shown there, or run:

```sh
claude mcp add --transport http pdpp <your-deployment-origin>/mcp
```

When Claude Code opens OAuth in the browser, approve the Gmail read-only grant.
Then query a known Gmail record. The MCP server URL is the deployed origin's
`/mcp`, never the public documentation origin.

This path covers PDPP's supported hosted MCP profile: authorization code with
PKCE, dynamic registration where enabled, and device authorization for clients
that cannot receive a browser callback. It does not claim interoperability
with every MCP client or every OAuth profile.

## Related runbooks

- [`hosted-mcp-setup.md`](hosted-mcp-setup.md) — client-specific OAuth details,
  including ChatGPT and Claude.ai, which need the public HTTPS origin below
  instead of `http://localhost:3000`.
- [`../../deploy/docker/README.md#public-https-for-chatgpt-and-claudeai`](../../deploy/docker/README.md#public-https-for-chatgpt-and-claudeai) —
  no-open-port public HTTPS for hosted AI clients: an ephemeral no-account
  trial, a stable option with no owned domain (ngrok's assigned Dev Domain),
  or a stable option if you own a domain (Cloudflare named tunnel).
- [`selfhost-quickstart.md`](selfhost-quickstart.md) — deployment notes and
  alternate platform lanes.
- [`add-connection.md`](add-connection.md) — owner-mediated source setup.
