# Proposal: deploy section copy for the reference page

**Status:** Proposal only — copy and structure, no component redesign.
**Target:** `apps/site/src/app/reference/page.tsx`.

## Principle

Progressive disclosure. The public page should present one reproducible,
registry-backed self-service path: pinned Docker Compose, owner setup, healthy
data, then the deployed `/connect` handoff. Alternate platform lanes stay out of
the blessed path until their exact artifacts pass an actual registry manifest
check.

## Proposed section

### Tier 1 — always visible: one pinned Compose card

> #### Deploy with Docker Compose
>
> Download the one stable release URL — `reference`, `web`, and `neko` are
> already pinned by digest, not a tag or commit SHA. The web service is
> published on port `3000`; reference services and Postgres remain private.
>
> ```sh
> mkdir pdpp && cd pdpp
> curl -fsSLO https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml
> printf 'PDPP_REFERENCE_ORIGIN=http://localhost:3000\nPDPP_WEB_PORT=3000\nPDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
>   "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
> docker compose up -d
> ```
>
> Do not add `PDPP_REFERENCE_IMAGE`/`PDPP_WEB_IMAGE` — the downloaded bundle
> already pins both. Open `http://localhost:3000/owner/login`, add Gmail with
> a Google app password, and wait for healthy data with `records > 0`.

### Tier 2 — collapsed beneath the card

**Disclosure: "Connect after healthy data"**

> Open the deployed `<your-deployment-origin>/connect` surface only after the
> deployment is healthy, the first sync has succeeded, and `records > 0`.
> Add `<your-deployment-origin>/mcp` to Claude Code, complete OAuth, and query
> a known record.

Full copy belongs in
[`docs/operator/self-service-gmail-mcp.md`](../../docs/operator/self-service-gmail-mcp.md).

## Copy rules baked into the above

- The blessed path uses the one stable release URL, which already pins
  `reference`, `web`, and `neko` by digest; do not substitute a raw
  main-branch or commit-SHA fetch, a mutable tag, or a hand-copied image
  override.
- Port `3000` is explicit in the copied Compose environment so local setup and
  the public page tell the same story.
- The client handoff names deployed `/connect` and `/mcp`; the public docs site
  is never presented as the live server.
- Keep the health/data gate before OAuth. A configured source or saved secret is
  not proof that MCP can query records.

## Out of scope

- Alternate platform buttons or image shortcuts before their concrete image
  manifests are proven and their live path is separately verified.
- No `curl | bash` installer. Keep artifacts inspectable with `curl -O` plus
  `docker compose up`.
- No component or layout redesign; this is copy and ordering only.
