# Deploy-Button Parity: Prior Art Research

**Date:** 2026-06-10
**Scope:** Fly.io one-click options; multi-target self-hosted deploy presentation; Docker low-cognitive-load patterns.

---

## 1. Fly.io One-Click Options in 2026

### Does a "Launch on Fly.io" button exist?

**No.** Fly.io does not provide a Railway-style hosted Template button that encodes a deployment as a shareable one-click link for arbitrary repos. This was confirmed by:

- The Fly.io docs page that would host such a feature (https://fly.io/docs/launch/launch-button/) returned HTTP 404 as of 2026-06-10, indicating the feature either never shipped or was removed.
- A community forum thread about a "launch button for Fly.io" (https://community.fly.io/t/launch-button-for-fly-io/19441, fetched 2026-06-10) is repurposed/redirected content unrelated to a hosted button feature.
- The Fly.io official launch docs (https://fly.io/docs/launch/, https://fly.io/docs/launch/create/, fetched 2026-06-10) describe no URL-based one-click deploy button. The entire "Fly Launch" product is CLI-only: `fly launch`, `fly deploy`, `fly.toml`.

**Verdict:** Fly's equivalent of a deploy button is a single `fly launch` command, not a web URL. The repo's own `deploy/flyio/README.md` documents this honestly as "the Fly-native path."

### What `fly launch` requires in the repo

- **fly.toml at root is the default,** but `--config <path>` allows specifying a subdirectory path (e.g., `fly launch --config deploy/flyio/fly.toml`). The `--from <GitHub-URL>` flag clones the repo and can be combined with `--config`.
- Source: https://fly.io/docs/launch/create/ (fetched 2026-06-10): "You can provide your own `fly.toml` and `fly launch` will offer to copy that configuration to a new app."

### fly.toml path note for pdpp

The pdpp repo keeps `fly.toml` at `deploy/flyio/fly.toml`, not at the root. This is fine for CLI usage (`fly launch --config deploy/flyio/fly.toml`), but if Fly ever ships a button with a URL-encoded repo reference, the non-root path would need explicit `--config` encoding — and as of June 2026, no such URL parameter exists in the Fly.io product.

### Postgres provisioning and secrets

`fly launch --db` automatically provisions a Fly Postgres app and injects `DATABASE_URL` into the app's secrets. The pdpp runtime accepts both `DATABASE_URL` and `PDPP_DATABASE_URL`, so `--db` works without additional wiring.

Secrets passed inline: `fly launch --secret "PDPP_OWNER_PASSWORD=$OWNER_PASSWORD"`. Additional env vars like `PDPP_REFERENCE_ORIGIN` can be passed with `--env`.

Source: https://fly.io/docs/flyctl/launch/ (fetched 2026-06-10)

### Trial org / payment behavior

Trial organizations (no credit card on file) are blocked at the final release step with error:

```
failed to create release (status 422): This functionality is disabled for trial organizations
```

App creation, Postgres provisioning, and IP allocation all succeed first — the failure happens at the last step. A card must be added at the Fly billing dashboard before launching. This is documented in pdpp's own `deploy/flyio/README.md` from live testing.

---

## 2. Multi-Target Deploy Row Patterns in Self-Hosted Projects

### n8n (https://docs.n8n.io/hosting/installation/docker/, fetched 2026-06-10)

n8n recommends Docker for self-hosting. Deploy surface:
- **Docker:** Two-step pattern — `docker volume create n8n_data` then a multiline `docker run` with timezone env, volume mount, and port binding.
- **No Railway/Render/Fly/DigitalOcean buttons** on the main install page.
- SQLite is the default; Postgres is opt-in via env vars.
- Copy pattern for Docker: prefaced with "From your terminal, run the following commands" — no one-liner.

### Plausible Community Edition (https://github.com/plausible/community-edition, fetched 2026-06-10)

Plausible CE uses a multi-step Docker Compose flow:
1. `git clone -b v3.2.1 --single-branch https://github.com/plausible/community-edition plausible-ce`
2. `cd plausible-ce`
3. Edit `.env` for BASE_URL + SECRET_KEY_BASE
4. Port-expose override via `compose.override.yml`
5. `docker compose up -d`

**No single-command deploy. No Railway/Render/Fly buttons.** The friction is intentional — Plausible's website (https://plausible.io/self-hosted-web-analytics, fetched 2026-06-10) explicitly calls self-hosting "a real commitment."

### Umami (https://umami.is/docs/install, fetched 2026-06-10)

Umami ships a docker-compose file bundling the app and Postgres:
- **Docker Compose:** `docker compose up -d` — the simplest real-world one-command pattern in this sample.
- Defaults: username `admin`, password `umami` (hardcoded, user must change immediately).
- **No Railway/Fly/DigitalOcean buttons** on the install page.
- Note: requires Postgres (no SQLite path).

### Outline (https://github.com/outline/outline#readme, fetched 2026-06-10)

Outline's README links to a `docker-compose.yml` but does not present a one-liner Docker command or platform buttons. The self-host path is documented in a separate wiki. No Railway/Render/Fly deploy buttons visible on the GitHub README.

### Coolify (https://coolify.io/docs/installation, fetched 2026-06-10)

Coolify is itself a self-hosted PaaS. Its install is the canonical `curl | bash` pattern:

```sh
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
# or with sudo:
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

The manual path downloads four files from a CDN, showing the underlying mechanism: a stable CDN-hosted `docker-compose.yml` + env file + upgrade script.

### Summary table

| Project       | Railway | Render | Fly | DigitalOcean | Docker one-liner | Docker compose |
|---------------|:-------:|:------:|:---:|:------------:|:----------------:|:--------------:|
| n8n           | —       | —      | —   | —            | multiline `run`  | (for Postgres) |
| Plausible CE  | —       | —      | —   | —            | —                | git clone + up |
| Umami         | —       | —      | —   | —            | —                | `compose up`   |
| Outline       | —       | —      | —   | —            | —                | via wiki       |
| Coolify       | —       | —      | —   | —            | `curl\|bash`     | —              |
| **pdpp**      | button  | —      | CLI | —            | not yet          | multi-step     |

**Observation:** Among these peers, pdpp is already at or ahead of the norm with a real Railway button. None of the peers offer a Railway or Fly button. Umami's `docker compose up` with no pre-requisite env is the simplest observed Docker pattern.

---

## 3. State of the Art: Lowest-Cognitive-Load Docker Self-Hosting

### Pattern A: Single `docker run` with embedded defaults

```sh
docker run -d \
  --name myapp \
  -p 3000:3000 \
  -v myapp_data:/data \
  myimage:latest
```

**Pros:** Single command, no file download, no compose installed. Used by many tools for evaluation/demo. Works when the image has sensible ENV defaults.
**Cons:** No multi-container coordination; doesn't work when the service needs a separate database container. Fine for SQLite-backed apps.

### Pattern B: `curl | compose up` (Coolify-style, Plausible manual path)

```sh
# Coolify approach
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

# Plausible approach (less opaque)
curl -fsSL https://plausible.io/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

**Pros:** Keeps compose file at a stable URL independent of git history; no `git clone` required; operator can inspect before running.
**Cons:** The `curl | bash` form is the most controversial security-wise (executes untrusted code with no review step). The `curl -o file && compose up` split is safer (operator can inspect the file) and is widely accepted. Both require `docker compose` v2+.

### Pattern C: Interactive bootstrap script

Examples: Coolify (above), Dokploy.

**Pros:** Can prompt for domain, generate secrets, configure TLS, handle OS differences.
**Cons:** Highest attack surface; not auditable without reading the script; opaque to operators who want to understand what ran.

### Security perception of `curl | sh` patterns

The security community has documented the risks clearly (e.g., https://0x46.net/thoughts/2019/04/27/piping-curl-to-shell/):

1. **No integrity check:** Unless the script is served with a pinned checksum that the operator verifies before execution, MITM or CDN compromise silently runs arbitrary code.
2. **No review step:** Operators cannot audit what will run before it runs.
3. **Root escalation:** `curl | sudo bash` is full root execution of remote code.

**Mitigations:** Hash verification (`sha256sum`), serving from a commit-pinned URL, signing with a public key. Coolify links to its script source as a partial mitigation.

**Industry consensus:** `curl | bash` is acceptable for dev/ops tools targeting technical users who understand the trade-off. For production self-hosted software targeting a slightly broader audience, the safer presentation is:

```sh
# Step 1 (optional, reviewer-friendly):
curl -fsSL https://example.com/docker-compose.yml -o docker-compose.yml
# review docker-compose.yml if desired
docker compose up -d
```

Or even simpler for single-image SQLite apps — a plain `docker run` with named volume:

```sh
docker run -d \
  --name pdpp \
  -p 3000:3000 \
  -e PDPP_OWNER_PASSWORD="$(openssl rand -base64 24)" \
  -v pdpp_data:/var/lib/pdpp \
  ghcr.io/vana-com/pdpp/railway-core:latest
```

This is the model that should be evaluated for pdpp (see design note).

---

## Sources

| URL | Accessed |
|-----|----------|
| https://fly.io/docs/launch/ | 2026-06-10 |
| https://fly.io/docs/launch/create/ | 2026-06-10 |
| https://fly.io/docs/flyctl/launch/ | 2026-06-10 |
| https://fly.io/docs/postgres/ | 2026-06-10 |
| https://fly.io/docs/launch/launch-button/ | 2026-06-10 (404 — no such page) |
| https://community.fly.io/t/launch-button-for-fly-io/19441 | 2026-06-10 (redirected — no Fly button) |
| https://docs.n8n.io/hosting/installation/docker/ | 2026-06-10 |
| https://plausible.io/self-hosted-web-analytics | 2026-06-10 |
| https://github.com/plausible/community-edition | 2026-06-10 |
| https://umami.is/docs/install | 2026-06-10 |
| https://github.com/outline/outline#readme | 2026-06-10 |
| https://coolify.io/docs/installation | 2026-06-10 |
