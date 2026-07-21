# Proposal: deploy section copy for the reference page

**Status:** Proposal only — copy and structure, no component redesign.
**Target:** `apps/site/src/app/reference/page.tsx` (the `pdpp.dev/reference`
deploy surface; today a "Deploy on Railway" hero button plus a
"Self-host with Docker" link into the GitHub README).
**Basis:** `docs/research/deploy-button-parity-prior-art-2026-06-10.md`.

## Principle

Progressive disclosure. The research found peers either bury Docker in
multi-step docs (Plausible, n8n) or offer nothing one-shot at all. PDPP can
lead with exactly two zero-decision paths — the Railway button and a Docker
one-liner — and collapse everything else beneath them. A new operator should
see two choices, not a matrix.

## Proposed section

### Tier 1 — always visible: two cards side by side

A single "Run your own node" section replacing the current scattered deploy
links. Two equal-weight cards:

---

**Card 1 — Cloud, one click**

> #### Deploy on Railway
>
> One click provisions the Core node and Postgres. You choose one thing: your
> owner password.
>
> [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/pdpp-core-template-source?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core)

**Card 2 — Your machine, one command**

> #### Run with Docker
>
> One command starts a full node on your laptop. First boot prints your
> dashboard URL and a generated owner password — nothing to configure.
>
> ```sh
> docker run -d --name pdpp -p 3000:3000 -v pdpp_data:/var/lib/pdpp \
>   ghcr.io/vana-com/pdpp/railway-core:main
> docker logs -f pdpp
> ```
>
> Open http://localhost:3000/dashboard and sign in with the printed password.
> Your data persists in the `pdpp_data` volume across restarts and upgrades.

---

### Tier 2 — collapsed beneath the cards

Two `<details>`-style disclosures (or the site's accordion equivalent),
closed by default:

---

**Disclosure 1: "Production deployment (Docker Compose)"**

> Running a node you intend to keep? Use the minimal Compose stack — reference
> + console + Postgres with pgvector — with healthchecks and named volumes:
>
> ```sh
> mkdir pdpp && cd pdpp
> curl -fsSLO https://raw.githubusercontent.com/PDP-Connect/pdpp/main/deploy/docker/docker-compose.yml
> printf 'PDPP_OWNER_PASSWORD=%s\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\n' \
>   "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
> docker compose up -d
> ```
>
> Put your HTTPS reverse proxy in front and set `PDPP_REFERENCE_ORIGIN` to
> your domain. Full runbook: [deploy/docker/README.md](https://github.com/PDP-Connect/pdpp/blob/main/deploy/docker/README.md).

**Disclosure 2: "Other platforms (Fly.io)"**

> Fly.io has no deploy button; its honest equivalent is one `fly launch`
> command that creates the app, provisions Postgres, and deploys the same
> Core image:
>
> ```sh
> APP="pdpp-core-$(openssl rand -hex 3)"
> OWNER_PASSWORD="$(openssl rand -base64 24)"
> fly launch --image ghcr.io/vana-com/pdpp/railway-core:main \
>   --name "$APP" --internal-port 3000 --db \
>   --secret "PDPP_OWNER_PASSWORD=$OWNER_PASSWORD" \
>   --env "PDPP_REFERENCE_ORIGIN=https://$APP.fly.dev" \
>   --no-github-workflow --no-object-storage --no-redis --now --yes
> printf 'Origin: https://%s.fly.dev\nOwner password: %s\n' "$APP" "$OWNER_PASSWORD"
> ```
>
> Requires a payment method on the Fly org (trial orgs are refused at release).
> Details and a source-build fallback: [deploy/flyio/README.md](https://github.com/PDP-Connect/pdpp/blob/main/deploy/flyio/README.md).

---

## Copy rules baked into the above

- The two Tier-1 paths are phrased as *outcomes* ("one click", "one command"),
  not technologies. No env-var names appear above the fold except inside the
  copy-paste block itself.
- The Docker one-liner carries zero `-e` flags. The first-boot bootstrap in
  the image (deploy/railway/core-first-boot.mjs) generates and persists the
  owner password and prints the dashboard URL, so the command requires no
  secret handling, no `openssl`, no shell substitution.
- `docker logs -f pdpp` is part of the quickstart copy on purpose: the banner
  *is* the onboarding. Do not move the password into page copy or a generated
  query string.
- Fly stays honest: a command block labeled as a command, never a fake button
  (the research confirmed no Fly button product exists as of June 2026).
- The existing "Self-host with Docker" hero link should point at
  `deploy/docker/README.md` instead of the reference README once this section
  lands.

## Out of scope (deliberately)

- No Render/DigitalOcean/Helm tiles — peers ship none of these either; add a
  third tier only when someone asks.
- No `curl | bash` installer. The research's security review favors
  inspectable artifacts (`curl -O` + `compose up`) over piped shell.
- No component or layout redesign; this is copy + ordering only.
